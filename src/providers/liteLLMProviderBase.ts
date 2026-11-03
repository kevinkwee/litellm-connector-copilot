import * as vscode from "vscode";
import { LiteLLMClient } from "../adapters/litellmClient";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../types";
import { countTokens } from "../adapters/tokenUtils";
import { ConfigManager } from "../config/configManager";
import { Logger } from "../utils/logger";
import { isOpenAIParamSupported } from "../utils/modelCapabilities";
import type { SupportedReasoningEffort } from "../types";
import {
    EFFORT_LADDER_LENGTH,
    EffortFallbackCache,
    hasShownReasoningFallbackNotification,
    isReasoningError,
    markReasoningFallbackNotified,
} from "../utils/reasoningEffortFallback";
import { RequestBuilder } from "./base/requestBuilder";
import { describeFailureForLog } from "./base/errorLogFields";
import { Transport } from "./base/transport";
import type { RequestBuilderDeps, TransportDeps } from "./base/types";
import type { ToolNameMapping } from "../utils/toolNameUtils";
import { LiteLLMProviderRegistry } from "./liteLLMProviderRegistry";
import { ActiveRequestRegistry } from "./activeRequests";

/**
 * Shared orchestration base for all LiteLLM-backed VS Code language model providers.
 *
 * Single-provider architecture: every request is routed to the backend whose
 * configuration VS Code passes on the originating call (`options.configuration`).
 * We do NOT maintain a global cross-backend model list or parse model IDs to
 * resolve a backend. VS Code already isolates per-group calls; our job is to
 * honor that and not second-guess it.
 *
 * Responsibilities:
 * - Wiring the BackendRegistry's `onDidChange` event to VS Code's
 *   `onDidChangeLanguageModelChatInformation` so the picker refreshes when
 *   a backend's model set actually changes.
 * - Shared request ingress pipeline (normalize, validate, filter)
 * - Endpoint routing (via call-time configuration)
 * - Shared error parsing and capability mapping
 *
 * Non-responsibilities:
 * - Model discovery (lives in the BackendRegistry, see
 *   `LiteLLMProviderRegistry.discoverModels`).
 * - VS Code protocol specifics (stream parsing, response part emission)
 * - Cross-backend routing (handled by VS Code 1.120 per-group config)
 */
export abstract class LiteLLMProviderBase {
    protected readonly _configManager: ConfigManager;
    protected readonly _onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformationEmitter.event;

    /**
     * The BackendRegistry is the single source of truth for backends and their
     * associated models. The base provider subscribes to its `onDidChange`
     * event and forwards it to VS Code. The provider does NOT have a
     * separate discovery class; the registry owns discovery, namespacing,
     * change detection, and the per-model capability caches.
     */
    protected readonly _registry: LiteLLMProviderRegistry;

    private readonly _requestBuilder: RequestBuilder;
    private readonly _transport: Transport;
    protected readonly _effortFallbackCache: EffortFallbackCache;
    // Per-session memo of models that have rejected `stream_options.include_usage`
    // on a live upstream call. NOT a model-info cache: it cannot be corrupted by
    // stale capability data. Keyed by the namespaced picker id, because a learned
    // limit describes one proxy's model config. Without this, the request builder
    // would re-send `include_usage: true` on every request to a model that
    // previously rejected it, causing an infinite retry loop.
    private readonly _usageOptOutModels = new Set<string>();
    private _registrySubscription: vscode.Disposable | undefined;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string,
        effortFallbackCache?: EffortFallbackCache,
        protected readonly activeRequests: ActiveRequestRegistry = new ActiveRequestRegistry()
    ) {
        this._configManager = new ConfigManager(secrets);
        this._effortFallbackCache = effortFallbackCache ?? new EffortFallbackCache();
        this._registry = new LiteLLMProviderRegistry({
            configManager: this._configManager,
            userAgent: this.userAgent,
        });

        // Forward the registry's `onDidChange` event to VS Code so the
        // picker refreshes when a backend's model set actually changes.
        this._registrySubscription = this._registry.onDidChange(() => {
            Logger.info("Firing onDidChangeLanguageModelChatInformation (from BackendRegistry.onDidChange)");
            this._onDidChangeLanguageModelChatInformationEmitter.fire();
        });

        const requestBuilderDeps: RequestBuilderDeps = {
            configManager: this._configManager,
            getReasoningEffort: this.getReasoningEffort.bind(this),
            stripUnsupportedParametersFromRequest: this.stripUnsupportedParametersFromRequest.bind(this),
            isParameterSupported: this.isParameterSupported.bind(this),
            getUnsupportedParameters: (modelId: string) => this._registry.getUnsupportedParameters(modelId),
            getTelemetryOptions: this.getTelemetryOptions.bind(this),
            usageOptOutModels: this._usageOptOutModels,
            extractRawModelName: (modelId: string) => this.getRawModelName(modelId),
        };
        this._requestBuilder = new RequestBuilder(requestBuilderDeps);

        const transportDeps: TransportDeps = {
            configManager: this._configManager,
            userAgent: this.userAgent,
            logger: Logger,
            onUnsupportedParameter: (model: string, param: string) => {
                this._registry.recordUnsupportedParameter(model, param);
            },
            liteLLMClientFactory: (backend) =>
                new LiteLLMClient(
                    {
                        url: backend.url,
                        key: backend.key,
                        disableCaching: backend.disableCaching,
                        rateLimitMaxDelayMs: backend.rateLimitMaxDelayMs,
                        headersTimeoutMs: backend.headersTimeoutMs,
                        onUnsupportedParameter: backend.onUnsupportedParameter,
                    },
                    this.userAgent
                ),
        };
        this._transport = new Transport(transportDeps);
    }

    /** Exposes the ConfigManager for external access (e.g., commands that need configuration). */
    public getConfigManager(): ConfigManager {
        return this._configManager;
    }

    /** Signals VS Code to refresh the Language Models view for this provider. */
    public refreshModelInformation(): void {
        Logger.info("Firing onDidChangeLanguageModelChatInformation");
        this._onDidChangeLanguageModelChatInformationEmitter.fire();
    }

    /**
     * Reloads model discovery without dropping routing. The discovery response
     * cache and the backoff histories are cleared, then VS Code re-queries every
     * group, so an in-flight request keeps resolving while the picker refills.
     */
    public reloadModelDiscovery(): void {
        Logger.info("Reloading model discovery");
        this._registry.clearDiscoveryCaches();
        this.refreshModelInformation();
    }

    /**
     * Reloads the model list and forgets what live rejections taught this session.
     * A user-initiated reload means the proxy's model config may have changed, so
     * a parameter rejected before is worth trying again.
     */
    public reloadModels(): void {
        this.clearLearnedLimits();
        this.reloadModelDiscovery();
    }

    /**
     * Forgets every per-proxy limit learned from a live request: the effort
     * fallback ladder, the `include_usage` opt-out, and the unsupported parameters.
     */
    private clearLearnedLimits(): void {
        this._effortFallbackCache.clear();
        this._usageOptOutModels.clear();
        this._registry.clearUnsupportedParameters();
    }

    /**
     * Clears the reasoning-effort fallback cache on extension deactivation.
     */
    public clearSessionCaches(): void {
        Logger.info("Clearing reasoning-effort fallback cache");
        this._effortFallbackCache.clear();
        Logger.info("Reasoning-effort fallback cache cleared");
    }

    /**
     * Public access to model info from the registry's capability cache.
     */
    public getModelInfo(modelId: string): LiteLLMModelInfo | undefined {
        return this._registry.getModelInfo(modelId);
    }

    /**
     * Releases everything this provider holds, so nothing outlives deactivation.
     * Safe to call more than once.
     */
    public dispose(): void {
        this._registrySubscription?.dispose();
        this._registrySubscription = undefined;
        this._onDidChangeLanguageModelChatInformationEmitter.dispose();
        this._registry.dispose();
    }

    /**
     * Estimates the token count for a prompt, message, or attachment.
     *
     * VS Code calls this while building each prompt, before any request is
     * sent, so it must answer immediately from the local tokenizer. The
     * upstream usage report that arrives with the reply remains the
     * authoritative count.
     */
    public async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken,
        _configuration?: Record<string, unknown>
    ): Promise<number> {
        // `model.id` is the namespaced `<routing>/<raw>` form. The capability
        // cache is keyed by the namespaced id, while the tokenizer heuristics
        // key off the raw model family.
        const modelInfo = this._registry.getModelInfo(model.id);
        const rawModelId = this.getRawModelName(model.id);
        return countTokens(text, rawModelId, modelInfo);
    }

    /**
     * Fetches the model list from the LiteLLM proxy for a specific group.
     *
     * Thin pass-through to the `BackendRegistry.discoverModels` ingress.
     * The registry owns the HTTP fetch, the per-group namespacing, and the
     * change detection; this method just refreshes the per-model
     * capability cache for downstream consumers (request builder, token
     * utilities) and returns the model list.
     *
     * Vendor-level calls (no `options.configuration`) return `[]`
     * immediately, matching the single-provider architecture: only
     * per-group calls have anything to discover.
     */
    public async discoverModels(
        options: {
            silent?: boolean;
            configuration?: Record<string, unknown>;
        },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // Vendor-level calls (no options.configuration) must return [] immediately
        // without firing onDidChangeLanguageModelChatInformation.
        if (!options.configuration) {
            return [];
        }

        // The registry is the single source of truth: it owns discovery,
        // namespacing, change detection, AND the per-model capability cache.
        // It also fires its `onDidChange` event when the model set for a
        // given baseUrl actually changes; we subscribed in the constructor
        // and forward that to VS Code. There is no mirror cache on the base
        // provider, so every `getModelInfo` call goes straight to the registry.
        return await this._registry.discoverModels(options, token);
    }

    /**
     * Returns the telemetry context for one request.
     *
     * `caller` is VS Code's `requestInitiator`, the extension that started the
     * request (`"core"` for the Agents window's Copilot SDK harness).
     */
    protected getTelemetryOptions(options: vscode.ProvideLanguageModelChatResponseOptions): {
        caller: string;
        modelConfiguration?: Record<string, unknown>;
    } {
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            // Per-model configuration on the SDK harness, or a group's credentials
            // when the host passes them.
            configuration?: Record<string, unknown>;
        };

        const modelConfig: Record<string, unknown> = {
            ...(opt.configuration ?? {}),
            ...(opt.modelConfiguration ?? {}),
        };

        return {
            caller:
                typeof opt.requestInitiator === "string" && opt.requestInitiator.length > 0
                    ? opt.requestInitiator
                    : "unknown",
            modelConfiguration: modelConfig,
        };
    }

    /**
     * Returns the reasoning effort the picker reports for this request, or
     * `undefined` when it reports none.
     *
     * The effort arrives in the per-model configuration, which reaches the
     * provider as `modelConfiguration` or as `configuration` depending on the
     * caller. `getTelemetryOptions` merges both.
     */
    protected getReasoningEffort(options: ProvideLanguageModelChatResponseOptions): string | undefined {
        const pickerEffort = this.getTelemetryOptions(options).modelConfiguration?.reasoningEffort;
        if (typeof pickerEffort !== "string") {
            return undefined;
        }
        Logger.debug(`[getReasoningEffort] effort from model configuration: ${pickerEffort}`);
        return pickerEffort;
    }

    /**
     * Shared request builder used by all providers. Returns the body together
     * with the tool-name mapping that body advertised, which the response path
     * needs to translate a model's tool call back to the declared name.
     */
    protected async buildOpenAIChatRequest(
        messages: readonly LanguageModelChatRequestMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ): Promise<{ request: OpenAIChatCompletionRequest; toolNames: ToolNameMapping }> {
        return this._requestBuilder.buildOpenAIChatRequest(messages, model, options, modelInfo, caller);
    }

    /**
     * Sends a request to LiteLLM. Honors the per-group `options.configuration`
     * passed by VS Code: baseUrl/apiKey are read from there, NEVER from
     * global state. If `configuration` is missing, the request fails with a
     * configuration-required error rather than silently mis-routing.
     */
    protected async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>,
        requestId?: string,
        learnedLimitsKey?: string
    ): Promise<ReadableStream<Uint8Array>> {
        return this._transport.sendRequestToLiteLLM(
            request,
            _progress,
            token,
            caller,
            modelInfo,
            configuration,
            requestId,
            learnedLimitsKey
        );
    }

    /**
     * Sends a LiteLLM request, walking the reasoning-effort ladder when the
     * upstream rejects the effort the request carries, and retrying once without
     * `stream_options.include_usage` when the upstream rejects that flag.
     */
    protected async sendRequestWithRetry(
        request: OpenAIChatCompletionRequest,
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        requestId?: string
    ): Promise<ReadableStream<Uint8Array>> {
        // A learned limit describes one proxy's model config, so every store is
        // keyed by the namespaced picker id rather than the wire model name.
        const modelId = model.id;
        Logger.debug(`[sendRequestWithRetry] modelId: ${modelId}, reasoning_effort: ${request.reasoning_effort}`);
        const originalEffort = (request as { reasoning_effort?: SupportedReasoningEffort }).reasoning_effort;
        let effectiveEffort = this._effortFallbackCache.getEffectiveEffort(modelId, originalEffort);
        Logger.debug(`[sendRequestWithRetry] originalEffort: ${originalEffort}, effectiveEffort: ${effectiveEffort}`);
        this.applyReasoningEffort(request, effectiveEffort);

        const notificationKeyEffort = originalEffort ?? effectiveEffort;
        let attempts = 0;
        let lastError: unknown;
        let usageRetryAttempted = false;

        const clearUsageFlag = () => {
            delete (request as { stream_options?: { include_usage?: boolean } }).stream_options;
        };

        // One attempt per ladder step plus the final omitted-parameter attempt.
        // The give-up check below ends the walk on the last of those.
        while (attempts <= EFFORT_LADDER_LENGTH) {
            try {
                return await this.sendRequestToLiteLLM(
                    request,
                    progress,
                    token,
                    caller,
                    modelInfo,
                    await this.getCallTimeConfiguration(options, model),
                    requestId,
                    modelId
                );
            } catch (err) {
                this.logRequestPayloadOnFailure(request, err, {
                    stage: "sendRequestWithRetry",
                    modelId: model.id,
                    caller,
                    modelInfoMode: modelInfo?.mode,
                });

                const errorMessage = err instanceof Error ? err.message : String(err);
                if (this.isUsageIncludeUsageParameterError(errorMessage)) {
                    this._usageOptOutModels.add(modelId);
                    clearUsageFlag();

                    if (!usageRetryAttempted) {
                        usageRetryAttempted = true;
                        Logger.warn(
                            `[sendRequestWithRetry] Retrying once without stream_options.include_usage after upstream rejection for model ${model.id}`
                        );
                        continue;
                    }
                }

                Logger.debug(`[sendRequestWithRetry] Caught error, checking isReasoningError...`);
                const isReasoning = isReasoningError(err);
                Logger.debug(`[sendRequestWithRetry] isReasoningError result: ${isReasoning}`);
                if (!isReasoning) {
                    Logger.debug("[sendRequestWithRetry] Not a reasoning error, throwing immediately");
                    throw err;
                }

                lastError = err;
                const nextEffort = this._effortFallbackCache.recordFailure(modelId, effectiveEffort);
                attempts += 1;
                Logger.debug(
                    `[sendRequestWithRetry] After recordFailure: nextEffort: ${nextEffort}, attempts: ${attempts}`
                );

                if (nextEffort === effectiveEffort || attempts > EFFORT_LADDER_LENGTH) {
                    Logger.debug("[sendRequestWithRetry] Condition met - throwing toMeaningfulError");
                    throw this.toMeaningfulError(err, "Reasoning effort fallback exhausted");
                }

                const previous = effectiveEffort;
                effectiveEffort = nextEffort;
                this.applyReasoningEffort(request, effectiveEffort);

                if (notificationKeyEffort && previous && previous !== effectiveEffort) {
                    this.notifyReasoningFallback(modelId, model.name, notificationKeyEffort, effectiveEffort);
                }

                Logger.info(
                    `[reasoning] ${modelId}: retrying with downgraded effort ${effectiveEffort ?? "(omitted)"} after failure`
                );
            }
        }

        throw this.toMeaningfulError(lastError, "Reasoning effort fallback exhausted");
    }

    private isUsageIncludeUsageParameterError(errorMessage: string): boolean {
        const lower = errorMessage.toLowerCase();
        return (
            (lower.includes("stream_options") || lower.includes("include_usage")) &&
            (lower.includes("unsupported parameter") ||
                lower.includes("not supported") ||
                lower.includes("unknown parameter") ||
                lower.includes("unexpected keyword argument"))
        );
    }

    private toMeaningfulError(error: unknown, fallbackMessage: string): Error {
        if (error instanceof Error) {
            return error;
        }

        if (typeof error === "string") {
            return new Error(error);
        }

        if (typeof error === "object" && error !== null && "message" in error) {
            const message = (error as { message?: unknown }).message;
            if (typeof message === "string" && message.trim().length > 0) {
                return new Error(message);
            }
        }

        return new Error(fallbackMessage);
    }

    private applyReasoningEffort(
        request: OpenAIChatCompletionRequest,
        effort: SupportedReasoningEffort | undefined,
        summary?: "auto" | "concise" | "detailed"
    ): void {
        if (!effort) {
            const requestRecord = request as unknown as Record<string, unknown>;
            delete requestRecord.reasoning_effort;
            return;
        }
        // Object form is used by `gpt-5.4+` callers (and the OpenAI Responses API
        // in general) to control whether summary text is returned alongside the
        // reasoning text. The OpenAI Chat Completions spec still accepts the
        // legacy string form; both are forwarded to LiteLLM unchanged.
        request.reasoning_effort = summary ? { effort, summary } : effort;
    }

    private notifyReasoningFallback(
        modelId: string,
        modelDisplayName: string,
        originalEffort: SupportedReasoningEffort,
        fallbackEffort: SupportedReasoningEffort | undefined
    ): void {
        if (hasShownReasoningFallbackNotification(modelId, originalEffort)) {
            return;
        }

        const fallbackLabel = fallbackEffort ?? "omitted";
        void vscode.window.showInformationMessage(
            `Effort '${originalEffort}' is not supported by ${modelDisplayName}; using '${fallbackLabel}' for this session.`
        );
        markReasoningFallbackNotified(modelId, originalEffort);
    }

    /**
     * Decides whether a request should carry the proxy cache directive. A key
     * that already rejected it must not pay for the rejection on every request,
     * so the learned refusal turns the directive off for that model.
     */
    private resolveCacheDirective(cfg: { disableCaching?: boolean }, modelId: string): boolean {
        return cfg.disableCaching === true && !this._registry.getUnsupportedParameters(modelId).has("cache");
    }

    /**
     * Resolves the per-group configuration for a response-time call.
     *
     * Discovery calls receive the per-group config on `options.configuration`.
     * The proposed type for `ProvideLanguageModelChatResponseOptions` does not
     * declare that field, so a response-time call may pass no per-group config
     * at all, or an object that is not one.
     *
     * The registry is the fallback. It records every model object it returns, so
     * the object VS Code hands back at request time resolves to its own group
     * even when two groups share a hostname. An object the registry did not
     * produce falls back to the id lookup, which is enough for a single group per
     * host.
     */
    private async getCallTimeConfiguration(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ): Promise<Record<string, unknown> | undefined> {
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            configuration?: Record<string, unknown>;
        };
        // VS Code may pass `options.configuration` at response time with no
        // `baseUrl`/`apiKey`: absent entirely, or present but empty. An empty
        // object is truthy and would otherwise short-circuit the registry
        // fallback and fail with "No baseUrl provided". Trust the field only
        // when both strings are non-empty; anything else falls through to the
        // registry.
        const optBaseUrl = typeof opt.configuration?.baseUrl === "string" ? opt.configuration.baseUrl.trim() : "";
        const optApiKey = typeof opt.configuration?.apiKey === "string" ? opt.configuration.apiKey.trim() : "";

        // Fetch workspace-config toggles once so both paths can merge them.
        const cfg = await this._configManager.getConfig();

        if (opt.configuration && optBaseUrl.length > 0 && optApiKey.length > 0) {
            Logger.trace(
                `getCallTimeConfiguration: HIT via options.configuration modelId="${model.id}" baseUrl="${optBaseUrl}"`
            );
            // Merge workspace-config ergonomic toggles onto the per-group
            // configuration so the transport can read them without a separate
            // config fetch on the hot path.
            return {
                ...opt.configuration,
                allowChatCompletionsFallback: cfg.allowChatCompletionsFallback,
                disableCaching: this.resolveCacheDirective(cfg, model.id),
                rateLimitMaxDelayMs: cfg.rateLimitMaxDelayMs,
                headersTimeoutMs: cfg.headersTimeoutMs,
            };
        }
        if (opt.configuration) {
            // Object is present but malformed (empty or missing fields), so it
            // cannot be trusted.
            Logger.trace(
                `getCallTimeConfiguration: options.configuration present but invalid (empty baseUrl or apiKey) modelId="${model.id}"; falling back to registry`
            );
        } else {
            Logger.trace(
                `getCallTimeConfiguration: options.configuration missing; falling back to registry lookup for modelId="${model.id}" modelName="${model.name}"`
            );
        }
        // No usable group credentials at response time. Fall back to the
        // registry, preferring the model object VS Code passed back over its id:
        // the object is the exact one this group's discovery returned, so it
        // routes correctly even when two groups share a hostname and therefore
        // produce the same ids.
        const entry = this._registry.lookupInfo(model) ?? this._registry.lookup(model.id);
        if (entry) {
            Logger.trace(`getCallTimeConfiguration: registry HIT modelId="${model.id}" -> baseUrl="${entry.baseUrl}"`);
            // Same ergonomic-toggle merge as the options.configuration path
            // above, so both call-time resolution paths behave identically.
            return {
                baseUrl: entry.baseUrl,
                apiKey: entry.apiKey,
                allowChatCompletionsFallback: cfg.allowChatCompletionsFallback,
                disableCaching: this.resolveCacheDirective(cfg, model.id),
                rateLimitMaxDelayMs: cfg.rateLimitMaxDelayMs,
                headersTimeoutMs: cfg.headersTimeoutMs,
            };
        }
        Logger.warn(
            `getCallTimeConfiguration: registry MISS modelId="${model.id}" modelName="${model.name}", so the request will fail with a configuration error`
        );
        return undefined;
    }

    /**
     * Returns the raw LiteLLM model name (the part after the routing prefix)
     * for a given model id. Strips the `<routing>/` prefix if present,
     * otherwise returns the id unchanged.
     *
     * Used by the request building and transport paths so that
     * `request.model` in the OpenAI-compatible body is always the raw name.
     * LiteLLM does NOT understand the namespaced id format that VS Code
     * sees in the picker.
     */
    protected getRawModelName(modelId: string): string {
        const entry = this._registry.lookup(modelId);
        if (entry) {
            return entry.rawModelName;
        }
        // No entry in the registry: assume the id is already raw. Vendor ids
        // handed to VS Code before discovery are not namespaced.
        return this._registry.extractRawName(modelId);
    }

    /**
     * Decides whether a given OpenAI parameter can be sent to a model.
     *
     * Source of truth: the `supported_openai_params` array on the model's
     * `LiteLLMModelInfo` (delivered by the registry). There is no probe
     * cache here, because the registry's per-model capability data is authoritative
     * and re-validated on every discovery call, so a stale cache layer
     * would only ever shadow correct information and (as observed in
     * production) cause a model to silently drop parameters it actually
     * supports.
     */
    protected isParameterSupported(param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string): boolean {
        return isOpenAIParamSupported(param, modelInfo, modelId);
    }

    protected stripUnsupportedParametersFromRequest(
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ): void {
        const paramsToCheck = [
            "temperature",
            "top_p",
            "cache_control",
            "tool_choice", // Added for GPT-5.6 Azure and similar models that don't support tool_choice
        ];
        for (const p of paramsToCheck) {
            if (!this.isParameterSupported(p, modelInfo, modelId) && p in requestBody) {
                delete requestBody[p];
            }
        }
    }

    protected logRequestPayloadOnFailure(
        request: OpenAIChatCompletionRequest,
        error: unknown,
        context: {
            stage: "sendRequestWithRetry" | "provideLanguageModelChatResponse";
            modelId: string;
            caller?: string;
            modelInfoMode?: string;
        }
    ): void {
        const payloadSummary = this.summarizeRequestPayloadForLogs(request);

        // The error message is left out on purpose: an upstream error can echo
        // the request body, and this trace-level entry exists to show the shape
        // of the payload that failed.
        Logger.trace(
            `[request-failure] stage=${context.stage} model=${context.modelId} caller=${context.caller ?? "unknown"} mode=${context.modelInfoMode ?? "unknown"} error=${describeFailureForLog(error)}`,
            payloadSummary
        );
    }

    private summarizeRequestPayloadForLogs(request: OpenAIChatCompletionRequest): Record<string, unknown> {
        const summarizeMessages = (request.messages ?? []).map(
            (message: { role?: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }) => {
                const content = message.content;
                const contentSummary =
                    typeof content === "string"
                        ? `text(${content.length})`
                        : Array.isArray(content)
                          ? `parts(${content.length})`
                          : typeof content;

                return {
                    role: message.role,
                    content: contentSummary,
                    hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
                    toolCallId: message.tool_call_id,
                };
            }
        );

        const summarizeTools = (request.tools ?? []).map((tool) => ({
            type: tool.type,
            name: tool.function?.name,
            hasDescription: typeof tool.function?.description === "string" && tool.function.description.length > 0,
        }));

        return {
            model: request.model,
            stream: request.stream,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            reasoning_effort: request.reasoning_effort,
            stream_options: request.stream_options,
            tool_choice: request.tool_choice,
            messageCount: request.messages?.length ?? 0,
            messages: summarizeMessages,
            toolCount: request.tools?.length ?? 0,
            tools: summarizeTools,
        };
    }

    protected buildCapabilities(modelInfo: LiteLLMModelInfo | undefined): vscode.LanguageModelChatCapabilities {
        if (!modelInfo) {
            return {
                toolCalling: true,
                imageInput: false,
            };
        }

        return {
            toolCalling: modelInfo.supports_function_calling !== false,
            imageInput: modelInfo.supports_vision === true,
        };
    }
}
