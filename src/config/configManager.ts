import * as vscode from "vscode";
import type { LiteLLMConfig } from "../types";
import { LiteLLMClient } from "../adapters/litellmClient";
import type { BackendSession } from "../providers/backendSession";
import { Logger } from "../utils/logger";
import { normalizeAnthropicPromptCachingMode } from "../utils/promptCaching";
import { deriveGroupNameFromUrl } from "../utils";
import { normalizeProxyBaseUrl } from "../utils/proxyBaseUrl";
import { DEFAULT_RETRY_BUDGET_MS } from "../utils/retryBudget";

export class ConfigManager {
    private static readonly INACTIVITY_TIMEOUT_KEY = "litellm-connector.inactivityTimeout";
    private static readonly DEFAULT_INACTIVITY_TIMEOUT_SECONDS = 60;
    private static readonly MIN_INACTIVITY_TIMEOUT_SECONDS = 1;
    private static readonly MAX_INACTIVITY_TIMEOUT_SECONDS = 3600;
    // getConfig() runs several times per request, so warn once per rejected value.
    private static lastInactivityTimeoutWarning: string | undefined;
    private static readonly DISABLE_CACHING_KEY = "litellm-connector.disableCaching";
    private static readonly ANTHROPIC_PROMPT_CACHING_KEY = "litellm-connector.anthropicPromptCaching";
    private static readonly KEY_MODEL_OVERRIDES_ENABLE = "litellm-connector.enableModelOverrides";
    private static readonly MODEL_CAPABILITIES_OVERRIDES_KEY = "litellm-connector.modelCapabilitiesOverrides";
    private static readonly FORCE_RESPONSES_ENDPOINT_KEY = "litellm-connector.forceResponsesEndpoint";
    private static readonly ALLOW_CHAT_COMPLETIONS_FALLBACK_KEY = "litellm-connector.allowChatCompletionsFallback";
    private static readonly DISPLAY_PRICING_IN_PICKER_KEY = "litellm-connector.displayPricingInPicker";
    private static readonly DISCOVERY_TIMEOUT_MS_KEY = "litellm-connector.discoveryTimeoutMs";
    private static readonly DISCOVERY_CACHE_TTL_MS_KEY = "litellm-connector.discoveryCacheTtlMs";
    private static readonly NETWORK_RETRIES_KEY = "litellm-connector.networkRetries";
    private static readonly NETWORK_RETRY_DELAY_MS_KEY = "litellm-connector.networkRetryDelayMs";
    private static readonly EMPTY_RESPONSE_RETRIES_KEY = "litellm-connector.emptyResponseRetries";
    private static readonly EMPTY_RESPONSE_RETRY_DELAY_MS_KEY = "litellm-connector.emptyResponseRetryDelayMs";
    private static readonly RATE_LIMIT_MAX_DELAY_SECONDS_KEY = "litellm-connector.rateLimitMaxDelaySeconds";
    private static readonly HEADERS_TIMEOUT_KEY = "litellm-connector.headersTimeout";
    private static readonly RETRY_BUDGET_SECONDS_KEY = "litellm-connector.retryBudgetSeconds";

    // Discovery config defaults and bounds
    private static readonly DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
    private static readonly MIN_DISCOVERY_TIMEOUT_MS = 500;
    private static readonly MAX_DISCOVERY_TIMEOUT_MS = 60_000;
    private static readonly DEFAULT_DISCOVERY_CACHE_TTL_MS = 60_000;
    private static readonly MIN_DISCOVERY_CACHE_TTL_MS = 0;
    private static readonly MAX_DISCOVERY_CACHE_TTL_MS = 300_000;

    // Rate-limit retry ceiling defaults and bounds. The setting is expressed in
    // seconds because Retry-After is a seconds-based header; the internal
    // pipeline works in milliseconds, so the clamped value is converted once
    // below. The upper bound (24h) keeps typo-scale values from effectively
    // hanging a request; the loop is cancellable at every sleep, so long
    // legitimate waits are safe.
    private static readonly DEFAULT_RATE_LIMIT_MAX_DELAY_SECONDS = 120;
    private static readonly MIN_RATE_LIMIT_MAX_DELAY_SECONDS = 0;
    private static readonly MAX_RATE_LIMIT_MAX_DELAY_SECONDS = 86_400;
    private static readonly MS_PER_SECOND = 1_000;

    // Time bounds for one chat request. Both are expressed in seconds because
    // they describe a user-observable wait; the internal pipeline works in
    // milliseconds. The headers bound is the connector's own guard on the phase
    // before the body watchdog starts. The retry budget bounds the time spent
    // retrying a request the host never cancels.
    //
    // The headers ceiling matches the 300 s header limit of the runtime's fetch,
    // which would clamp a larger value anyway, so the setting does not accept one.
    private static readonly DEFAULT_HEADERS_TIMEOUT_SECONDS = 120;
    private static readonly MIN_HEADERS_TIMEOUT_SECONDS = 1;
    private static readonly MAX_HEADERS_TIMEOUT_SECONDS = 300;
    private static readonly DEFAULT_RETRY_BUDGET_SECONDS = DEFAULT_RETRY_BUDGET_MS / 1_000;
    private static readonly MIN_RETRY_BUDGET_SECONDS = 0;
    private static readonly MAX_RETRY_BUDGET_SECONDS = 3_600;

    /**
     * Clamps the inactivity timeout to the range the manifest declares. A value
     * of 0 or less would otherwise fire the stream watchdog as soon as a
     * response starts and abort every response.
     */
    private static clampInactivityTimeoutSeconds(value: number | undefined): number {
        const fallback = ConfigManager.DEFAULT_INACTIVITY_TIMEOUT_SECONDS;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            ConfigManager.warnAboutInactivityTimeout(String(value), fallback);
            return fallback;
        }
        const clamped = Math.min(
            ConfigManager.MAX_INACTIVITY_TIMEOUT_SECONDS,
            Math.max(ConfigManager.MIN_INACTIVITY_TIMEOUT_SECONDS, value)
        );
        if (clamped !== value) {
            ConfigManager.warnAboutInactivityTimeout(String(value), clamped);
        } else {
            ConfigManager.lastInactivityTimeoutWarning = undefined;
        }
        return clamped;
    }

    private static warnAboutInactivityTimeout(rejected: string, used: number): void {
        if (ConfigManager.lastInactivityTimeoutWarning === rejected) {
            return;
        }
        ConfigManager.lastInactivityTimeoutWarning = rejected;
        Logger.warn(
            `litellm-connector.inactivityTimeout is ${rejected}, which is not a number between ` +
                `${ConfigManager.MIN_INACTIVITY_TIMEOUT_SECONDS} and ` +
                `${ConfigManager.MAX_INACTIVITY_TIMEOUT_SECONDS} seconds; using ${used}s`
        );
    }

    /**
     * Clamps a discovery timeout value to valid bounds.
     */
    private clampDiscoveryTimeoutMs(value: number | undefined): number {
        if (typeof value !== "number" || Number.isNaN(value)) {
            return ConfigManager.DEFAULT_DISCOVERY_TIMEOUT_MS;
        }
        return Math.min(
            ConfigManager.MAX_DISCOVERY_TIMEOUT_MS,
            Math.max(ConfigManager.MIN_DISCOVERY_TIMEOUT_MS, value)
        );
    }

    /**
     * Clamps a discovery cache TTL value to valid bounds.
     */
    private clampDiscoveryCacheTtlMs(value: number | undefined): number {
        if (typeof value !== "number" || Number.isNaN(value)) {
            return ConfigManager.DEFAULT_DISCOVERY_CACHE_TTL_MS;
        }
        return Math.min(
            ConfigManager.MAX_DISCOVERY_CACHE_TTL_MS,
            Math.max(ConfigManager.MIN_DISCOVERY_CACHE_TTL_MS, value)
        );
    }

    /**
     * Generic range clamp for discovery settings.
     */
    private clampRange(value: number | undefined, min: number, max: number, defaultValue: number): number {
        if (typeof value !== "number" || Number.isNaN(value)) {
            return defaultValue;
        }
        return Math.min(max, Math.max(min, value));
    }

    /**
     * Retrieves the current LiteLLM workspace-level configuration.
     *
     * Backend connection details (baseUrl, apiKey) are NOT read here. They are
     * delivered by VS Code per-group `options.configuration` payloads on every
     * provider call. This method returns only workspace-scoped ergonomic toggles
     * and overrides.
     */
    async getConfig(): Promise<LiteLLMConfig> {
        const workspaceConfig = vscode.workspace.getConfiguration();

        const inactivityTimeout = ConfigManager.clampInactivityTimeoutSeconds(
            workspaceConfig.get<number>(
                ConfigManager.INACTIVITY_TIMEOUT_KEY,
                ConfigManager.DEFAULT_INACTIVITY_TIMEOUT_SECONDS
            )
        );
        const disableCaching = workspaceConfig.get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);
        const anthropicPromptCaching = normalizeAnthropicPromptCachingMode(
            workspaceConfig.get<unknown>(ConfigManager.ANTHROPIC_PROMPT_CACHING_KEY)
        );
        const enableModelOverrides = workspaceConfig.get<boolean>(ConfigManager.KEY_MODEL_OVERRIDES_ENABLE, true);

        const modelCapabilitiesOverridesRaw = workspaceConfig.get<Record<string, string | string[]>>(
            ConfigManager.MODEL_CAPABILITIES_OVERRIDES_KEY,
            {}
        );

        const modelCapabilitiesOverrides: Record<string, { toolCalling?: boolean; imageInput?: boolean }> = {};
        if (
            modelCapabilitiesOverridesRaw &&
            typeof modelCapabilitiesOverridesRaw === "object" &&
            !Array.isArray(modelCapabilitiesOverridesRaw)
        ) {
            for (const [modelId, value] of Object.entries(modelCapabilitiesOverridesRaw)) {
                let caps: string[] = [];
                if (Array.isArray(value)) {
                    caps = value.map(String);
                } else if (typeof value === "string") {
                    caps = value
                        .split(",")
                        .map((c) => c.trim())
                        .filter((c) => c.length > 0);
                }

                if (caps.length > 0) {
                    const entry: { toolCalling?: boolean; imageInput?: boolean } = {};
                    if (caps.some((c) => c.toLowerCase() === "toolcalling" || c.toLowerCase() === "tools")) {
                        entry.toolCalling = true;
                    }
                    if (caps.some((c) => c.toLowerCase() === "imageinput" || c.toLowerCase() === "vision")) {
                        entry.imageInput = true;
                    }
                    if (Object.keys(entry).length > 0) {
                        modelCapabilitiesOverrides[modelId] = entry;
                    }
                }
            }
        }

        const forceResponsesEndpoint = workspaceConfig.get<boolean>(ConfigManager.FORCE_RESPONSES_ENDPOINT_KEY, false);
        const allowChatCompletionsFallback = workspaceConfig.get<boolean>(
            ConfigManager.ALLOW_CHAT_COMPLETIONS_FALLBACK_KEY,
            false
        );
        const displayPricingInPicker = workspaceConfig.get<boolean>(ConfigManager.DISPLAY_PRICING_IN_PICKER_KEY, true); // Ensure config precedence for displayPricingInPicker

        const discoveryTimeoutMs = this.clampDiscoveryTimeoutMs(
            workspaceConfig.get<number>(ConfigManager.DISCOVERY_TIMEOUT_MS_KEY)
        );
        const discoveryCacheTtlMs = this.clampDiscoveryCacheTtlMs(
            workspaceConfig.get<number>(ConfigManager.DISCOVERY_CACHE_TTL_MS_KEY)
        );

        const networkRetries = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.NETWORK_RETRIES_KEY),
            0,
            Number.MAX_SAFE_INTEGER,
            3
        );
        const networkRetryDelayMs = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.NETWORK_RETRY_DELAY_MS_KEY),
            0,
            30_000,
            2_000
        );

        const emptyResponseRetries = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.EMPTY_RESPONSE_RETRIES_KEY),
            0,
            10,
            2
        );
        const emptyResponseRetryDelayMs = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.EMPTY_RESPONSE_RETRY_DELAY_MS_KEY),
            0,
            30_000,
            1_000
        );

        const rateLimitMaxDelaySeconds = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.RATE_LIMIT_MAX_DELAY_SECONDS_KEY),
            ConfigManager.MIN_RATE_LIMIT_MAX_DELAY_SECONDS,
            ConfigManager.MAX_RATE_LIMIT_MAX_DELAY_SECONDS,
            ConfigManager.DEFAULT_RATE_LIMIT_MAX_DELAY_SECONDS
        );
        const rateLimitMaxDelayMs = Math.round(rateLimitMaxDelaySeconds * ConfigManager.MS_PER_SECOND);

        const headersTimeoutSeconds = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.HEADERS_TIMEOUT_KEY),
            ConfigManager.MIN_HEADERS_TIMEOUT_SECONDS,
            ConfigManager.MAX_HEADERS_TIMEOUT_SECONDS,
            ConfigManager.DEFAULT_HEADERS_TIMEOUT_SECONDS
        );
        const headersTimeoutMs = Math.round(headersTimeoutSeconds * ConfigManager.MS_PER_SECOND);

        const retryBudgetSeconds = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.RETRY_BUDGET_SECONDS_KEY),
            ConfigManager.MIN_RETRY_BUDGET_SECONDS,
            ConfigManager.MAX_RETRY_BUDGET_SECONDS,
            ConfigManager.DEFAULT_RETRY_BUDGET_SECONDS
        );
        const retryBudgetMs = Math.ceil(retryBudgetSeconds * ConfigManager.MS_PER_SECOND);

        const config: LiteLLMConfig = {
            inactivityTimeout,
            disableCaching,
            anthropicPromptCaching,
            enableModelOverrides,
            modelCapabilitiesOverrides,
            forceResponsesEndpoint,
            allowChatCompletionsFallback,
            displayPricingInPicker,
            discoveryTimeoutMs,
            discoveryCacheTtlMs,
            networkRetries,
            networkRetryDelayMs,
            emptyResponseRetries,
            emptyResponseRetryDelayMs,
            rateLimitMaxDelayMs,
            headersTimeoutMs,
            retryBudgetMs,
        };
        return { ...config };
    }

    /**
     * Converts VS Code per-group provider configuration into a BackendSession.
     *
     * Required fields (per `package.json` `languageModelChatProviders.configuration`):
     *   - `baseUrl`: must start with http:// or https://
     *   - `apiKey`: non-empty string (encrypted by VS Code)
     *
     * `providerName` (if present in the payload) is not part of the schema
     * and is ignored.
     */
    convertProviderConfiguration(
        configuration: Record<string, unknown>,
        clientOptions: { discoveryTimeoutMs: number | undefined; userAgent: string }
    ): BackendSession | undefined {
        const baseUrl = normalizeProxyBaseUrl(typeof configuration.baseUrl === "string" ? configuration.baseUrl : "");
        const apiKey = typeof configuration.apiKey === "string" ? configuration.apiKey.trim() : "";

        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            Logger.warn(
                "convertProviderConfiguration: rejected: baseUrl must start with http:// or https:// (got a non-http value)"
            );
            return undefined;
        }

        if (!apiKey) {
            Logger.warn("convertProviderConfiguration: rejected: apiKey is empty in per-group configuration");
            return undefined;
        }

        // Stable label for the model `detail` and `tooltip`, derived from the URL
        // because VS Code does not pass the user's group name to the provider.
        const backendName = deriveGroupNameFromUrl(baseUrl) || baseUrl;

        return {
            backendName,
            baseUrl,
            apiKey,
            client: new LiteLLMClient(
                {
                    url: baseUrl,
                    key: apiKey,
                    discoveryTimeoutMs: clientOptions.discoveryTimeoutMs,
                },
                clientOptions.userAgent
            ),
        };
    }
}
