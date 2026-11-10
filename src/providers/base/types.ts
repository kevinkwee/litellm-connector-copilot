import type * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../../types";
import type { LiteLLMClient } from "../../adapters/litellmClient";
import type { ConfigManager as configMgr } from "../../config/configManager";

export interface RequestBuilderDeps {
    configManager: configMgr;
    getReasoningEffort: (options: vscode.ProvideLanguageModelChatResponseOptions) => string | undefined;
    stripUnsupportedParametersFromRequest: (
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ) => void;
    isParameterSupported: (param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string) => boolean;
    /**
     * Parameters a live rejection taught us to omit for this namespaced model id.
     * Fed by the registry's learned-unsupported store so a single failed request
     * short-circuits later ones.
     */
    getUnsupportedParameters: (modelId: string) => ReadonlySet<string>;
    getTelemetryOptions: (options: vscode.ProvideLanguageModelChatResponseOptions) => {
        caller: string;
        modelConfiguration?: Record<string, unknown>;
    };
    usageOptOutModels: Set<string>;
    /**
     * Strips the routing prefix from a model id to recover the raw
     * LiteLLM model name (e.g. `wolfram.com/azure_ai/gpt-5.4-mini` →
     * `azure_ai/gpt-5.4-mini`). Used for `request.model` in the
     * OpenAI-compatible body and for capability/parameter lookups that
     * are keyed on the raw model family.
     */
    extractRawModelName: (modelId: string) => string;
}

export interface TransportDeps {
    configManager: configMgr;
    userAgent: string;
    logger: {
        info: (msg: string, err?: unknown) => void;
        warn: (msg: string, err?: unknown) => void;
        error: (msg: string, err?: unknown) => void;
        debug: (msg: string, err?: unknown) => void;
        trace: (msg: string, err?: unknown) => void;
    };
    liteLLMClientFactory?: (backend: {
        url: string;
        key?: string;
        disableCaching?: boolean;
        rateLimitMaxDelayMs?: number;
        headersTimeoutMs?: number;
        onUnsupportedParameter?: (model: string, param: string) => void;
    }) => LiteLLMClient;
    /**
     * Invoked when a 400 or 403 response rejects a parameter this connector
     * adds, so the provider can remember the incompatibility and later requests
     * omit it. The client retries without the parameter itself; the provider
     * only records it. The model id it receives is the namespaced learned-limits
     * key, not the wire model name.
     */
    onUnsupportedParameter?: (model: string, param: string) => void;
}
