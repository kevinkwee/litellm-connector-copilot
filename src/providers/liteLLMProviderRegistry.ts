/**
 * BackendRegistry: the single source of truth for backends and their
 * associated models.
 *
 * This class owns:
 *  1. **Discovery**: a per-group `/model/info` fetch that runs on every
 *     `discoverModels` call, behind a short TTL response cache (60 s by
 *     default), namespaced into `<routingIdentity>/<rawModelName>` ids.
 *  2. **Storage**: an in-memory map of (namespaced id) → {baseUrl, apiKey,
 *     rawModelName, routingIdentity}, a `WeakMap` from each delivered model
 *     object to its routing entry, plus a per-backend view of the last
 *     delivered model list (used for change detection and for falling back to
 *     it when a refresh fails).
 *  3. **Change detection**: emits `onDidChange` when a backend's model set
 *     actually differs from the prior delivery, so VS Code only refreshes
 *     the picker when the set has really changed.
 *  4. **Capability caches**: per-model `LiteLLMModelInfo` and derived
 *     capabilities. These are populated as a side effect of discovery and
 *     feed the request hot path. They are NOT a model-list cache: they
 *     cache the capability info for known models.
 *
 * Public surface (read + ingress)
 *  - `discoverModels(options, token)`: the only way for VS Code (or any
 *    consumer) to fetch a model list and populate the registry.
 *  - `lookup(id)`: resolve a namespaced id to its routing entry.
 *  - `lookupInfo(info)`: resolve the exact model object VS Code passed back,
 *    which is what distinguishes two groups on the same host.
 *  - `extractRawName(id)`: strip the routing prefix from a namespaced id.
 *  - `getModelInfo(id)` / `getDerivedCapabilities(id)`: read the
 *    capability caches populated during discovery.
 *  - `size()`: number of distinct backends currently registered.
 *  - `clear()`: wipe the routing table (call on user-initiated reload).
 *  - `clearCaches()`: wipe the capability caches + backoff controller.
 *  - `onDidChange`: fires when a backend's model set changes.
 *
 * Internal surface (write)
 *  - `setModelsForBackend(...)`: internal write, called only by
 *    `discoverInternal`. Not part of the public contract.
 *  - `getModelsForBackend(backendKey)` / `getModelIdsForBackend(backendKey)`:
 *    internal read, used only by `discoverInternal`.
 *
 * Discovery, storage, and change detection live in one class so the
 * write-before-compare change-detection protocol has a single call site:
 * `discoverModels` is the only code path that needs to know the write
 * protocol exists, and consumers see a single ingress that returns the
 * model list, updates the registry, and fires the change event as a unit.
 *
 * Per-group namespacing
 * The namespaced id format `<routingIdentity>/<rawModelName>` lets the response
 * path look up routing in O(1) by id. The routing identity is the URL hostname
 * (with the user-entered group name as fallback); the raw model name is the
 * part after the first `/` in the id, preserved unchanged from what the backend
 * returned. Ids are unique per host, not per group: two groups on one host
 * produce identical ids, so response-time routing resolves the model object
 * VS Code passed back (`lookupInfo`) first and only falls back to the id for
 * objects this registry did not produce.
 */
import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import { Logger } from "../utils/logger";
import { StructuredLogger } from "../observability/structuredLogger";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
    buildReasoningEffortConfigurationSchema,
    buildTemperatureConfigurationProperty,
    mergeConfigurationSchemas,
    getSupportedReasoningEfforts,
    derivePickerCategory,
} from "../utils/modelCapabilities";
import { deriveGroupNameFromUrl } from "../utils";
import { sha256HexAsync } from "../utils/discoveryHash";
import { LiteLLMDiscoveryError } from "../adapters/litellmClient";
import type { LiteLLMConfig, LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../types";
import type { ConfigManager } from "../config/configManager";
import type { BackendSession } from "./backendSession";
import { sharedDiscoveryBackoff } from "./base/discoveryBackoff";
import { DebouncedEmitter } from "./base/debouncedEmitter";
import {
    derivePriceCategory,
    extractPricing,
    formatPricingForDetail,
    formatPricingForTooltip,
} from "../utils/pricingCalculator";

/**
 * Cached result from a /model/info discovery call.
 */
interface CachedDiscoveryResult {
    readonly bodyHash: string;
    readonly models: readonly vscode.LanguageModelChatInformation[];
    readonly fetchedAtMs: number;
    readonly ttlMs: number;
}

/**
 * Hashes the API key for use in internal keys. Only the first 8 characters of
 * the SHA-256 digest are used, so the raw key is never logged or persisted.
 */
async function hashApiKeySuffixAsync(apiKey: string | undefined): Promise<string> {
    return apiKey ? (await sha256HexAsync(apiKey)).slice(0, 8) : "anonymous";
}

/**
 * Identity of one configured provider group: its server URL plus a suffix of a
 * hash of its API key.
 *
 * The same value keys the discovery response cache and the per-backend model
 * list, so groups that differ in URL, scheme, or API key never share a cache
 * entry. The scheme is kept as written because `http` and `https` may be
 * different servers.
 */
async function toBackendIdentityKey(baseUrl: string, apiKey: string | undefined): Promise<string> {
    return `${baseUrl.replace(/\/+$/, "")}#${await hashApiKeySuffixAsync(apiKey)}`;
}

/**
 * Returns a short, log-safe reason for a failed discovery refresh.
 */
function describeDiscoveryFailure(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const singleLine = message.replace(/\s+/g, " ").trim();
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

/**
 * Statuses that mean this group is misconfigured rather than the endpoint
 * being unhealthy. Serving the last known list for one of them would hide the
 * problem behind a warning icon, so discovery returns an empty list instead.
 */
const NON_TRANSIENT_DISCOVERY_STATUS = new Set([400, 401, 403, 404]);
function isTransientDiscoveryFailure(err: unknown): boolean {
    return !(err instanceof LiteLLMDiscoveryError && NON_TRANSIENT_DISCOVERY_STATUS.has(err.status));
}

/**
 * The shape returned by `lookup(id)`. The response path needs the
 * baseUrl/apiKey to construct the transport, and the rawModelName to
 * populate `request.model` in the OpenAI-compatible body (LiteLLM does
 * NOT understand the namespaced id).
 */
export interface RegistryEntry {
    readonly baseUrl: string;
    readonly apiKey: string;
    /** The raw LiteLLM model_name (the part after the first `/` in the id). */
    readonly rawModelName: string;
    /** The routing identity (the part before the first `/` in the id). */
    readonly routingIdentity: string;
}

/**
 * The dependency bundle required to construct a registry. Bundled so
 * the constructor signature stays stable and the registry can be
 * unit-tested with a stub ConfigManager.
 */
export interface RegistryDeps {
    readonly configManager: ConfigManager;
    readonly userAgent: string;
}

/**
 * Return value of `discoverInternal` for a single per-group call.
 * The `changed` flag tells callers whether the change event should fire.
 */
export interface DiscoveryOutcome {
    readonly models: LanguageModelChatInformation[];
    readonly changed: boolean;
    readonly session?: BackendSession;
    readonly routingIdentity: string;
}

/**
 * Returns true if two sets contain the same elements. Order-independent.
 * Used by `discoverInternal` to decide whether firing the change event
 * would be a no-op signal.
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }
    return true;
}

/**
 * A single deployment row from a `/model/info` response. The same public
 * `model_name` can be served by multiple deployments with different
 * credentials or providers.
 */
type LiteLLMModelInfoEntry = LiteLLMModelInfoResponse["data"][number];

/**
 * Applies LiteLLM's paused-model listing rule to a `/model/info` payload,
 * matching `Router.get_fully_blocked_model_names` on the proxy: a
 * deployment whose `model_info.blocked` is `true` is admin-paused and is
 * dropped. A public name is hidden only when every deployment carrying it
 * is paused; with at least one non-paused deployment the name stays
 * listable and is represented by its first non-paused deployment, so
 * multi-deployment names appear once. Entries without a `model_name` are
 * passed through unless paused, so the unknown-name skip in
 * `toVSCodeInfo` keeps reporting them. Strict `=== true` leaves older
 * proxies that do not send the flag untouched.
 */
export function toListableDeployments(data: readonly LiteLLMModelInfoEntry[]): LiteLLMModelInfoEntry[] {
    const namesWithPausedDeployment = new Set<string>();
    const namesWithLiveDeployment = new Set<string>();
    for (const entry of data) {
        if (!entry.model_name) {
            continue;
        }
        if (entry.model_info?.blocked === true) {
            namesWithPausedDeployment.add(entry.model_name);
        } else {
            namesWithLiveDeployment.add(entry.model_name);
        }
    }
    const hiddenNames = [...namesWithPausedDeployment].filter((name) => !namesWithLiveDeployment.has(name));
    if (hiddenNames.length > 0) {
        StructuredLogger.debug("discovery.paused_deployments_filtered", {
            hiddenModelNames: hiddenNames.sort(),
            hiddenCount: hiddenNames.length,
        });
    }

    const listedNames = new Set<string>();
    const listable: LiteLLMModelInfoEntry[] = [];
    for (const entry of data) {
        if (entry.model_info?.blocked === true) {
            continue;
        }
        if (entry.model_name && listedNames.has(entry.model_name)) {
            continue;
        }
        if (entry.model_name) {
            listedNames.add(entry.model_name);
        }
        listable.push(entry);
    }
    return listable;
}

export class LiteLLMProviderRegistry implements vscode.Disposable {
    private readonly configManager: RegistryDeps["configManager"];
    private readonly _userAgent: string;

    private readonly entries = new Map<string, RegistryEntry>();
    /**
     * Per-group model lists keyed by backend identity (URL + API-key hash), not
     * by URL alone, so two groups on one host cannot overwrite each other's
     * change-detection state and flip `onDidChange` on every refresh.
     */
    private readonly modelsByBackend = new Map<string, LanguageModelChatInformation[]>();
    /**
     * The exact model objects handed to VS Code, mapped to their routing entry.
     * VS Code calls `provideLanguageModelChatResponse` with the object it stored
     * for that group, so object identity resolves routing exactly even when two
     * groups share a hostname and therefore produce the same namespaced ids.
     */
    private entriesByInfo = new WeakMap<LanguageModelChatInformation, RegistryEntry>();

    /**
     * Tracks parameters that were auto-stripped after a failed request so callers
     * can proactively omit them on subsequent calls. Single source of truth for
     * dynamically-learned parameter limits.
     */
    private readonly unsupportedParamsByModel = new Map<string, Set<string>>();

    /**
     * Per-model capability caches. These are populated as a side effect of
     * discovery and feed the request hot path (`buildOpenAIChatRequest`,
     * token utilities, capability derivation). They are NOT a model list
     * cache: they cache the capability info for known models.
     */
    private readonly modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    private readonly derivedCapabilitiesCache = new Map<string, ReturnType<typeof deriveCapabilitiesFromModelInfo>>();

    private readonly _onDidChangeEmitter = new vscode.EventEmitter<void>();

    // Discovery response cache for /model/info responses
    private readonly discoveryResponseCache = new Map<string, CachedDiscoveryResult>();

    // Debounced change event emitter (initialized lazily on first use)
    private _debouncedOnDidChange: DebouncedEmitter | undefined;

    // Discovery debounce defaults
    private static readonly DEFAULT_DISCOVERY_FIRE_DEBOUNCE_MS = 250;
    private static readonly DEFAULT_DISCOVERY_FIRE_MIN_INTERVAL_MS = 2_000;

    /**
     * Emits when a backend's discovered model set has actually changed
     * since the prior delivery. The base provider subscribes once and
     * wires it to VS Code's `onDidChangeLanguageModelChatInformation`.
     */
    public readonly onDidChange: vscode.Event<void> = this._onDidChangeEmitter.event;

    constructor(deps: RegistryDeps) {
        this.configManager = deps.configManager;
        this._userAgent = deps.userAgent;
    }

    /**
     * Builds the debounced emitter used by `onDidChange` coalescing. Nothing on
     * the discovery path calls it: `discoverModels` fires the raw emitter so the
     * picker reflects a model-set change immediately.
     */
    private async getDebouncedEmitter(): Promise<DebouncedEmitter> {
        if (!this._debouncedOnDidChange) {
            const config = await this.configManager.getConfig();
            const debounceMs =
                config.discoveryFireDebounceMs ?? LiteLLMProviderRegistry.DEFAULT_DISCOVERY_FIRE_DEBOUNCE_MS;
            const minIntervalMs =
                config.discoveryFireMinIntervalMs ?? LiteLLMProviderRegistry.DEFAULT_DISCOVERY_FIRE_MIN_INTERVAL_MS;

            this._debouncedOnDidChange = new DebouncedEmitter(
                () => this._onDidChangeEmitter.fire(),
                debounceMs,
                minIntervalMs,
                (reasons) => {
                    if (reasons.length > 1) {
                        StructuredLogger.debug("discovery.fire_debounced", {
                            baseUrl: reasons[0] ?? "unknown",
                            coalescedFires: reasons.length,
                            windowMs: debounceMs,
                        });
                    }
                }
            );
        }
        return this._debouncedOnDidChange;
    }

    // Public ingress

    /**
     * The single public entry point for discovery.
     *
     * - Vendor-level calls (no `options.configuration`) return `[]` and do
     *   not fire `onDidChange`.
     * - Per-group calls fetch `/model/info` (subject to the short response
     *   cache), namespace the ids, record the per-backend view, and fire
     *   `onDidChange` if and only if the model set for that backend actually
     *   differs from the prior delivery.
     * - A transient failure with a prior successful delivery returns that
     *   group's last known models, marked with a warning, so a failed refresh
     *   does not empty the picker.
     */
    public async discoverModels(
        options: {
            silent?: boolean;
            configuration?: Record<string, unknown>;
            groupName?: string;
        },
        token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const outcome = await this.discoverInternal(options, token);
        if (outcome.changed) {
            const baseUrl = outcome.session?.baseUrl ?? "unknown";
            // Fire immediately when model set changes. The debounce logic was
            // intended to rate-limit rapid discoveries but caused test failures
            // because tests expect immediate change notifications. In production,
            // VS Code's own UI has natural debouncing from user interaction.
            Logger.debug("discovery.fire", { baseUrl, reason: "model_change" });
            this._onDidChangeEmitter.fire();
        }
        return outcome.models;
    }

    // Public read

    /**
     * Direct lookup of the routing entry for a given id. The id is the
     * namespaced id VS Code hands back at response time. Returns undefined
     * if the id is not in the registry.
     *
     * This is the response path's fallback for when VS Code does not pass
     * the per-group BYOK config on the chat call.
     */
    public lookup(id: string): RegistryEntry | undefined {
        const entry = this.entries.get(id);
        if (entry) {
            Logger.trace(
                `LiteLLMProviderRegistry.lookup HIT: id="${id}" -> baseUrl="${entry.baseUrl}" rawModelName="${entry.rawModelName}" routingIdentity="${entry.routingIdentity}"`
            );
        } else {
            const keys = [...this.entries.keys()];
            const sample = keys.slice(0, 3);
            Logger.trace(
                `LiteLLMProviderRegistry.lookup MISS: id="${id}" entryCount=${this.entries.size} sampleKeys=[${sample.join(", ")}]`
            );
        }
        return entry;
    }

    /**
     * Resolves routing from the model object VS Code passes back at request
     * time. This is the exact object returned from the group's discovery, so it
     * distinguishes groups that share a hostname and therefore a model id.
     *
     * Returns undefined for a model object this registry did not produce (for
     * example one built by a test or another provider), which lets callers fall
     * back to the id-keyed lookup.
     */
    public lookupInfo(info: LanguageModelChatInformation | undefined): RegistryEntry | undefined {
        if (!info) {
            return undefined;
        }
        const entry = this.entriesByInfo.get(info);
        if (entry) {
            Logger.trace(
                `LiteLLMProviderRegistry.lookupInfo HIT: id="${info.id}" -> baseUrl="${entry.baseUrl}" rawModelName="${entry.rawModelName}"`
            );
        }
        return entry;
    }

    /**
     * Aggregated, deduplicated model list across all registered backends. Intended
     * for read-only access (e.g., commit provider) without introducing secondary
     * caches.
     */
    public getAllModels(): LanguageModelChatInformation[] {
        const seen = new Set<string>();
        const out: LanguageModelChatInformation[] = [];
        for (const models of this.modelsByBackend.values()) {
            for (const model of models) {
                if (seen.has(model.id)) {
                    continue;
                }
                seen.add(model.id);
                out.push(model);
            }
        }
        return out;
    }

    /**
     * Splits a namespaced id into its routing identity and raw model name
     * parts. The split is on the FIRST `/` because raw model names from
     * LiteLLM commonly contain slashes (e.g. `azure_ai/gpt-5.4-mini`).
     *
     * - `<routing>/<raw>` → `{routingIdentity: "<routing>", rawModelName: "<raw>"}`
     * - `<raw>` (no `/`) → `{routingIdentity: "", rawModelName: "<raw>"}`
     */
    public extractRawName(id: string): string {
        const slash = id.indexOf("/");
        if (slash < 0) {
            return id;
        }
        return id.slice(slash + 1);
    }

    /**
     * Returns the per-model `LiteLLMModelInfo` cached during the most
     * recent discovery for this id, or `undefined` if the id has not
     * been seen (or has been cleared).
     */
    public getModelInfo(id: string): LiteLLMModelInfo | undefined {
        return this.modelInfoCache.get(id);
    }

    /**
     * Returns the derived capabilities cached during the most recent
     * discovery for this id, or `undefined` if the id has not been seen.
     */
    public getDerivedCapabilities(id: string): ReturnType<typeof deriveCapabilitiesFromModelInfo> | undefined {
        return this.derivedCapabilitiesCache.get(id);
    }

    /**
     * Number of distinct backends currently registered. Used by tests and
     * by telemetry; not a routing primitive.
     */
    public size(): number {
        return this.modelsByBackend.size;
    }

    /**
     * Wipes every routing entry, the identity map, every per-backend model list,
     * and the discovery response cache. Call on user-initiated model reload so
     * the next discovery pass starts from a clean slate. Does NOT touch the
     * per-model capability caches; call `clearCaches()` for that.
     */
    public clear(): void {
        this.entries.clear();
        this.modelsByBackend.clear();
        this.entriesByInfo = new WeakMap();
        this.discoveryResponseCache.clear();
    }

    /**
     * Wipes the per-model capability caches and the shared backoff
     * controller. Does NOT touch the routing table.
     */
    public clearCaches(): void {
        this.modelInfoCache.clear();
        this.derivedCapabilitiesCache.clear();
        this.unsupportedParamsByModel.clear();
        this.discoveryResponseCache.clear();
        sharedDiscoveryBackoff.reset();
    }

    /**
     * Records an auto-stripped parameter for a model so future requests can
     * proactively omit it. Only to be called when the transport detected a failed
     * request and removed the parameter before retrying.
     */
    public recordUnsupportedParameter(modelId: string, param: string): void {
        const trimmed = param.trim();
        if (!trimmed) {
            return;
        }
        const set = this.unsupportedParamsByModel.get(modelId) ?? new Set<string>();
        set.add(trimmed);
        this.unsupportedParamsByModel.set(modelId, set);
    }

    /**
     * Returns the set of dynamically-learned unsupported parameters for a model.
     */
    public getUnsupportedParameters(modelId: string): ReadonlySet<string> {
        return this.unsupportedParamsByModel.get(modelId) ?? new Set<string>();
    }

    public dispose(): void {
        this._debouncedOnDidChange?.dispose();
        this._onDidChangeEmitter.dispose();
    }

    // Internal write (NOT part of the public contract)

    /**
     * Records the full model list returned by a single backend's discovery
     * call. Updates the routing table (keyed by namespaced id for the fallback
     * lookup, and by object identity for exact per-group routing) and the
     * per-backend model-list view (source of truth for change detection)
     * atomically.
     *
     * INTERNAL: only `discoverInternal` calls this. Do not call from
     * outside the class.
     */
    private setModelsForBackend(
        backendKey: string,
        baseUrl: string,
        apiKey: string,
        routingIdentity: string,
        models: LanguageModelChatInformation[]
    ): void {
        const sample = models.slice(0, 3).map((m) => m.id);
        Logger.trace(
            `LiteLLMProviderRegistry.setModelsForBackend: baseUrl="${baseUrl}" routingIdentity="${routingIdentity}" ` +
                `modelCount=${models.length} sampleIds=[${sample.join(", ")}] priorBackendCount=${this.modelsByBackend.size} priorEntryCount=${this.entries.size}`
        );
        this.modelsByBackend.set(backendKey, models);
        for (const model of models) {
            const entry: RegistryEntry = {
                baseUrl,
                apiKey,
                rawModelName: this.extractRawName(model.id),
                routingIdentity,
            };
            this.entries.set(model.id, entry);
            this.entriesByInfo.set(model, entry);
        }
        Logger.trace(
            `LiteLLMProviderRegistry.setModelsForBackend: post-write backendCount=${this.modelsByBackend.size} entryCount=${this.entries.size}`
        );
    }

    private getModelsForBackend(backendKey: string): LanguageModelChatInformation[] | undefined {
        return this.modelsByBackend.get(backendKey);
    }

    private getModelIdsForBackend(backendKey: string): Set<string> | undefined {
        const models = this.modelsByBackend.get(backendKey);
        if (!models) {
            return undefined;
        }
        return new Set(models.map((m) => m.id));
    }

    /**
     * Copies a backend's last known model list with a visible warning, so a
     * failed refresh leaves the group usable instead of emptying the picker.
     * The registry's stored objects are never mutated: VS Code keeps the objects
     * it was handed, and identity is what the response path routes by. Each copy
     * inherits the original's routing entry, so a request made with a copied
     * model still resolves to this group's credentials.
     */
    private toStaleModels(
        models: readonly LanguageModelChatInformation[],
        reason: string
    ): LanguageModelChatInformation[] {
        const warningText = `Last model refresh failed: ${reason}. Showing the last known model list.`;
        return models.map((model) => {
            const staleModel: LanguageModelChatInformation = {
                ...model,
                statusIcon: new vscode.ThemeIcon("warning"),
                warningText: { ...(model.warningText ?? {}), model_refresh: warningText },
            };
            const entry = this.entriesByInfo.get(model);
            if (entry) {
                this.entriesByInfo.set(staleModel, entry);
            }
            return staleModel;
        });
    }

    // Discovery implementation

    private async discoverInternal(
        options: { silent?: boolean; configuration?: Record<string, unknown>; groupName?: string },
        token: vscode.CancellationToken
    ): Promise<DiscoveryOutcome> {
        // Set once the backend identity is known, so a transient failure can
        // fall back to the models this group last delivered.
        let backendKey: string | undefined;
        let failureBaseUrl: string | undefined;
        try {
            if (!options.configuration) {
                // Vendor-level call: nothing to discover. Return an empty list
                // without firing `onDidChange`. Each per-group call is what
                // populates the picker.
                return { models: [], changed: false, routingIdentity: "" };
            }

            const configuredBaseUrl =
                typeof options.configuration.baseUrl === "string" ? options.configuration.baseUrl.trim() : "";
            failureBaseUrl = configuredBaseUrl;
            const urlHostname = deriveGroupNameFromUrl(configuredBaseUrl).trim();
            const displayLabel = options.groupName ?? (urlHostname.length > 0 ? urlHostname : undefined) ?? "LiteLLM";

            const session = this.resolveBackendForCall(options.configuration, urlHostname || displayLabel);
            if (!session) {
                const baseUrlMissing =
                    typeof options.configuration.baseUrl !== "string" || options.configuration.baseUrl.trim() === "";
                const apiKeyMissing =
                    typeof options.configuration.apiKey !== "string" || options.configuration.apiKey.trim() === "";
                const reason = baseUrlMissing
                    ? "Server URL is empty"
                    : apiKeyMissing
                      ? "API key is empty"
                      : "Configuration is invalid or incomplete";
                Logger.warn(
                    `LiteLLMProviderRegistry.discoverModels: ${reason}; surfacing LanguageModelError to the picker`
                );
                throw vscode.LanguageModelError.Blocked(
                    `Cannot list models: ${reason}. ` +
                        `Open the LiteLLM provider settings and confirm both Server URL and API key are set.`
                );
            }
            const routingIdentity = (urlHostname.length > 0 ? urlHostname : displayLabel).replace(/\//g, "_");
            // Identity is known before the fetch, so a failed refresh can still
            // find the models this group delivered last time.
            backendKey = await toBackendIdentityKey(session.baseUrl, session.apiKey);
            const models = await this.discoverFromSession(session, token, displayLabel, routingIdentity);
            Logger.trace(
                `LiteLLMProviderRegistry.discoverModels: fetched ${models.length} models for baseUrl="${session.baseUrl}"`
            );

            // Change detection: read the PRIOR id set for this backend, compare
            // to the NEW one, then write. Writing first would make the
            // comparison read "now" against "now" and never fire.
            const newIds = new Set(models.map((m) => m.id));
            const previousIds = this.getModelIdsForBackend(backendKey);
            const changed = !previousIds || !setsEqual(previousIds, newIds);
            Logger.trace(
                `LiteLLMProviderRegistry.discoverModels: baseUrl="${session.baseUrl}" routingIdentity="${routingIdentity}" ` +
                    `modelCount=${models.length} sampleIds=[${[...newIds].slice(0, 3).join(", ")}] changed=${changed}`
            );
            if (session.apiKey) {
                this.setModelsForBackend(backendKey, session.baseUrl, session.apiKey, routingIdentity, models);
            } else {
                Logger.trace(
                    `LiteLLMProviderRegistry.discoverModels: skipping registry write (no session/apiKey) baseUrl="${session.baseUrl}" modelCount=${models.length}`
                );
            }
            return { models, changed, session, routingIdentity };
        } catch (err) {
            // Actionable configuration errors (thrown above) must reach the
            // picker unchanged so the user can see the reason. Only network /
            // server-side failures get retried-with-backoff or converted to
            // a "Blocked" error after the failure threshold.
            if (err instanceof vscode.LanguageModelError) {
                throw err;
            }
            const decision = sharedDiscoveryBackoff.recordFailure(Date.now());
            if (decision.delayMs > 0) {
                await this.sleep(decision.delayMs, token);
            }
            if (decision.shouldBlock) {
                throw vscode.LanguageModelError.Blocked(
                    `Discovery blocked after ${decision.attempt} consecutive failures. ` +
                        `The LiteLLM endpoint appears to be unhealthy. ` +
                        `Please check your configuration and retry later.`
                );
            }

            // A refresh that fails must not empty a working group: an in-flight
            // session would lose its model. Hand back the last known list, marked
            // so the failure stays visible. A misconfigured group (400, 401, 403,
            // or 404) reports the empty list instead, so the real error is not
            // hidden behind a warning icon.
            const lastKnown =
                backendKey && isTransientDiscoveryFailure(err) ? this.getModelsForBackend(backendKey) : undefined;
            if (lastKnown && lastKnown.length > 0) {
                const reason = describeDiscoveryFailure(err);
                Logger.warn(
                    `LiteLLMProviderRegistry.discoverModels: refresh failed for baseUrl="${failureBaseUrl ?? "unknown"}"; serving ${lastKnown.length} last-known model(s)`
                );
                StructuredLogger.warn("discovery.stale_models_served", {
                    baseUrl: failureBaseUrl,
                    modelCount: lastKnown.length,
                    attempt: decision.attempt,
                    reason,
                });
                return { models: this.toStaleModels(lastKnown, reason), changed: false, routingIdentity: "" };
            }
            return { models: [], changed: false, routingIdentity: "" };
        }
    }

    /**
     * Resolves the active backend session for a request by honoring the
     * per-group configuration passed on the call.
     */
    private resolveBackendForCall(
        configuration: Record<string, unknown> | undefined,
        groupName?: string
    ): BackendSession | undefined {
        if (!configuration) {
            return undefined;
        }
        Logger.trace(`LiteLLMProviderRegistry.resolveBackendForCall: groupName="${groupName ?? ""}"`);
        return this.configManager.convertProviderConfiguration(groupName ?? "", configuration);
    }

    private async discoverFromSession(
        session: BackendSession,
        token: vscode.CancellationToken,
        displayLabel: string,
        routingIdentity: string
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = await this.configManager.getConfig();
        const ttlMs = config.discoveryCacheTtlMs ?? 60_000;

        // Check cache first
        const cacheKey = await toBackendIdentityKey(session.baseUrl, session.apiKey);
        if (ttlMs > 0) {
            const cached = this.discoveryResponseCache.get(cacheKey);
            if (cached && Date.now() - cached.fetchedAtMs < ttlMs) {
                StructuredLogger.debug("discovery.cache_hit", {
                    baseUrl: session.baseUrl,
                    ageMs: Date.now() - cached.fetchedAtMs,
                    ttlMs,
                    modelCount: cached.models.length,
                    bodyHash: cached.bodyHash.slice(0, 8),
                });
                return [...cached.models];
            }
            StructuredLogger.debug("discovery.cache_miss", {
                baseUrl: session.baseUrl,
                reason: !cached ? "missing" : "expired",
            });
        }

        // Fetch fresh data
        StructuredLogger.trace("discovery.request_start", {
            baseUrl: session.baseUrl,
            url: "/model/info",
            timeoutMs: config.discoveryTimeoutMs ?? 5_000,
        });
        const startTime = Date.now();
        const models = await session.client.getModelInfo(token);
        const durationMs = Date.now() - startTime;
        StructuredLogger.debug("discovery.request_success", {
            baseUrl: session.baseUrl,
            durationMs,
            modelCount: models.data?.length ?? 0,
        });
        if (!models?.data?.length) {
            return [];
        }

        const infos = toListableDeployments(models.data)
            .map((entry) =>
                this.toVSCodeInfo(
                    entry,
                    session.backendName,
                    { url: session.baseUrl, apiKey: session.apiKey },
                    displayLabel,
                    routingIdentity,
                    config.forceResponsesEndpoint,
                    config.modelCapabilitiesOverrides,
                    config.displayPricingInPicker !== false
                )
            )
            .filter((info) => info.isUserSelectable !== false);

        // Cache the response if TTL > 0
        if (ttlMs > 0) {
            // Create a deterministic hash of the response body
            const bodyHash = await sha256HexAsync(JSON.stringify(models.data ?? []));
            this.discoveryResponseCache.set(cacheKey, {
                bodyHash,
                models: infos,
                fetchedAtMs: Date.now(),
                ttlMs,
            });
            StructuredLogger.debug("discovery.cached", {
                baseUrl: session.baseUrl,
                bodyHash: bodyHash.slice(0, 8),
                modelCount: infos.length,
                ttlMs,
            });
        }

        return infos;
    }

    private toVSCodeInfo(
        entry: LiteLLMModelInfoResponse["data"][number],
        backendName: string,
        backend: { url?: string; apiKey?: string } | undefined,
        displayLabel: string,
        routingIdentity: string,
        forceResponsesEndpoint?: boolean,
        modelCapabilitiesOverrides?: LiteLLMConfig["modelCapabilitiesOverrides"],
        displayPricingInPicker = true
    ): vscode.LanguageModelChatInformation {
        if (!entry.model_name) {
            Logger.warn(
                `Skipping model entry without model_name from backend "${backendName}". Entry keys: ${Object.keys(
                    entry
                ).join(",")}`
            );
            return {
                id: "unknown",
                name: "unknown",
                vendor: entry.model_info?.litellm_provider ?? "litellm",
                family: entry.model_info?.litellm_provider ?? "litellm",
                version: "1.0",
                maxInputTokens: 0,
                maxOutputTokens: 0,
                capabilities: { canGenerate: false },
                isUserSelectable: false,
                category: displayLabel,
                configurationSchema: undefined,
            } as unknown as vscode.LanguageModelChatInformation & { isUserSelectable: boolean };
        }

        const modelName = entry.model_name;
        // The id is the namespaced form `<routingIdentity>/<rawModelName>` so
        // the response path can recover both pieces by splitting on the first
        // `/`. Two backends on different hostnames can advertise the same raw
        // model name (e.g. `azure_ai/gpt-5.4-mini`): the routing identity
        // disambiguates them. The `name` shown to the user in the model
        // picker stays as the raw model_name (no namespace leak).
        const modelId = routingIdentity.length > 0 ? `${routingIdentity}/${modelName}` : modelName;
        let modelInfo = entry.model_info;
        if (forceResponsesEndpoint && modelInfo?.mode === "chat") {
            modelInfo = { ...modelInfo, mode: "responses" as const };
        }

        this.modelInfoCache.set(modelId, modelInfo);
        const derived = deriveCapabilitiesFromModelInfo(modelId, modelInfo);
        this.derivedCapabilitiesCache.set(modelId, derived);

        const capabilityOverrides = modelCapabilitiesOverrides?.[modelId] ?? modelCapabilitiesOverrides?.[modelName];
        const capabilities = capabilitiesToVSCode(derived, capabilityOverrides);
        const tags = getDerivedModelTags(modelId, derived, {}, capabilityOverrides);
        const supportedEfforts = getSupportedReasoningEfforts(modelInfo, modelId);
        const reasoningSchema = buildReasoningEffortConfigurationSchema(supportedEfforts, modelId, modelInfo);
        // The temperature knob is advertised only for models that accept the
        // parameter upstream; the request path re-checks the same gate before
        // sending so a stale config value cannot reach an unsupported model.
        const temperatureProperty = buildTemperatureConfigurationProperty(modelInfo, modelId);
        const configurationSchema = mergeConfigurationSchemas(reasoningSchema, temperatureProperty);

        const cacheIndicator = modelInfo?.supports_prompt_caching ? "⚡ " : "";
        const detailBase = backendName ?? "LiteLLM";

        // Pricing is optional and only shown when displayPricingInPicker is enabled.
        const pricing = displayPricingInPicker ? extractPricing(modelInfo) : undefined;
        const pricingDetail = formatPricingForDetail(pricing);
        const detail = pricingDetail
            ? `${cacheIndicator + detailBase} • ${pricingDetail}`
            : cacheIndicator + detailBase;

        // Default category remains derived picker category (string) for safety.
        const category = derivePickerCategory(derived);

        const toNumberPerMillion = (value?: number): number | undefined =>
            value !== undefined ? value * 1_000_000 : undefined;

        const info: vscode.LanguageModelChatInformation & {
            vendor?: string;
            backendName?: string;
            tags?: string[];
            detail?: string;
            tooltip?: string;
            pricing?: string;
            inputCost?: number;
            outputCost?: number;
            cacheCost?: number;
            cacheWriteCost?: number;
            longContextInputCost?: number;
            longContextOutputCost?: number;
            longContextCacheCost?: number;
            longContextCacheWriteCost?: number;
            priceCategory?: string;
        } = {
            id: modelId,
            name: modelName,
            vendor: modelInfo?.litellm_provider ?? "litellm",
            tooltip: `Provider: ${modelInfo?.litellm_provider ?? "litellm"}, Model: ${modelName} via ${detailBase}`,
            detail,
            description: modelInfo?.litellm_provider ?? "",
            family: modelInfo?.litellm_provider ?? "litellm",
            version: "1.0",
            maxInputTokens: derived.maxInputTokens,
            maxOutputTokens: derived.maxOutputTokens,
            capabilities,
            tags,
            isUserSelectable: true,
            // The picker reads this field via `getCategoryLabel(category)` and
            // crashes with `TypeError: a.charAt is not a function` when the
            // value is not a string. The picker recognizes the three literals
            // `lightweight` | `versatile` | `powerful` and handles `undefined`
            // (omit tag). We MUST return one of those or `undefined`: never a
            // grouping object, never `null`.
            //
            // Note on grouping: the picker does NOT read `category` for
            // per-backend sectioning. Per the upstream
            // `ModelPickerWidget.buildModelPickerItems()`, grouping is driven
            // by `(vendor, groupName)` resolved through the workbench
            // `ILanguageModelsService.getLanguageModelGroups()` lookup, not
            // by anything we return in `category`. Returning a string here
            // therefore does NOT regress per-backend picker sectioning; it
            // only stops the crash on `getCategoryLabel`.
            category,
            configurationSchema,
        } as unknown as vscode.LanguageModelChatInformation;

        // Populate pricing fields only when enabled and data is present.
        // These fields are per 1M tokens per VS Code proposed API.
        if (pricing) {
            const inputCost = toNumberPerMillion(pricing.inputCostPerToken);
            const outputCost = toNumberPerMillion(pricing.outputCostPerToken);
            const cacheCost = toNumberPerMillion(pricing.cacheReadCostPerToken);
            const cacheWriteCost = toNumberPerMillion(pricing.cacheCreationCostPerToken);

            // Normalize floating artifacts so tests expecting rounded values don't fail
            const round = (value?: number): number | undefined =>
                value !== undefined ? Number.parseFloat(value.toFixed(2)) : undefined;

            (info as { pricing?: string }).pricing = formatPricingForDetail(pricing);
            (info as { inputCost?: number }).inputCost = round(inputCost);
            (info as { outputCost?: number }).outputCost = round(outputCost);
            (info as { cacheCost?: number }).cacheCost = round(cacheCost);
            (info as { cacheWriteCost?: number }).cacheWriteCost = round(cacheWriteCost);
            (info as { priceCategory?: string }).priceCategory = derivePriceCategory(pricing);

            // Tooltip: append pricing breakdown
            const pricingTooltip = formatPricingForTooltip(pricing);
            if (pricingTooltip) {
                (info as { tooltip?: string }).tooltip = `${info.tooltip}\n${pricingTooltip}`;
            }
        }

        return info;
    }

    private sleep(ms: number, _token?: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

let sharedRegistry: LiteLLMProviderRegistry | undefined;

export function getOrCreateBackendRegistry(deps: RegistryDeps): LiteLLMProviderRegistry {
    if (!sharedRegistry) {
        sharedRegistry = new LiteLLMProviderRegistry(deps);
        return sharedRegistry;
    }

    return sharedRegistry;
}

/**
 * Test-only helper to reset the singleton instance. Do not call in production
 * paths.
 */
export function resetBackendRegistry(): void {
    sharedRegistry?.dispose();
    sharedRegistry = undefined;
}
