import type * as sinon from "sinon";
import type * as vscode from "vscode";

import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import type { ToolNameMapping } from "../../utils/toolNameUtils";
import type { EffortFallbackCache } from "../../utils/reasoningEffortFallback";
import type { LiteLLMChatProvider } from "../../providers";
import type { BackendSession } from "../../providers/backendSession";

/**
 * Typed view of protected/private members and methods used in tests. We cast once
 * to eliminate per-call `any` casts while keeping the production class API hidden
 * from callers.
 */
export interface BaseTestAccess {
    _configManager: ConfigManager;
    _registry: {
        lookup: (
            id: string
        ) => { baseUrl: string; apiKey: string; rawModelName: string; routingIdentity: string } | undefined;
        getModelInfo: (id: string) => LiteLLMModelInfo | undefined;
        clearCaches: () => void;
        size: () => number;
        recordUnsupportedParameter: (modelId: string, param: string) => void;
        getUnsupportedParameters: (modelId: string) => ReadonlySet<string>;
    };
    _transport: {
        sendRequestToLiteLLM: (
            request: OpenAIChatCompletionRequest,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            token: vscode.CancellationToken,
            caller?: string,
            modelInfo?: LiteLLMModelInfo,
            configuration?: Record<string, unknown>,
            requestId?: string,
            learnedLimitsKey?: string
        ) => Promise<ReadableStream<Uint8Array>>;
    };
    _effortFallbackCache: EffortFallbackCache;
    _usageOptOutModels: Set<string>;
    refreshModelInformation: () => void;
    buildOpenAIChatRequest: (
        messages: vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ) => Promise<{ request: OpenAIChatCompletionRequest; toolNames: ToolNameMapping }>;
    buildCapabilities: (modelInfo: LiteLLMModelInfo | undefined) => vscode.LanguageModelChatCapabilities;
    stripUnsupportedParametersFromRequest: (
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ) => void;
    isParameterSupported: (param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string) => boolean;
    sendRequestWithRetry: (
        request: OpenAIChatCompletionRequest,
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ) => Promise<ReadableStream<Uint8Array>>;
    sendRequestToLiteLLM: (
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>
    ) => Promise<ReadableStream<Uint8Array>>;
    getCallTimeConfiguration: (
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ) => Promise<Record<string, unknown> | undefined>;
    applyReasoningEffort: (
        request: OpenAIChatCompletionRequest,
        effort: OpenAIChatCompletionRequest["reasoning_effort"] | undefined
    ) => void;
}

/**
 * Builds the 4xx-shaped error the reasoning-effort fallback treats as worth
 * retrying.
 */
export function apiError(message: string, status: number): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
}

export function access(provider: LiteLLMChatProvider): BaseTestAccess {
    return provider as unknown as BaseTestAccess;
}

/**
 * Stubs the config manager so `convertProviderConfiguration` returns a known
 * session for the given configuration. Use this when a test exercises the
 * chat flow and we don't want to stub an HTTP fetch.
 */
export function seedBackendForCall(
    sandbox: sinon.SinonSandbox,
    provider: LiteLLMChatProvider,
    configuration: Record<string, unknown> | undefined,
    session: BackendSession | undefined
): void {
    const configManager = access(provider)._configManager;
    sandbox.stub(configManager, "convertProviderConfiguration").callsFake((cfg: Record<string, unknown>) => {
        if (cfg === configuration) {
            return session;
        }
        return undefined;
    });
}
