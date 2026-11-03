import * as assert from "assert";
import type * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMClient } from "../../adapters/litellmClient";
import type { LiteLLMChatProvider } from "../../providers";
import type { OpenAIChatCompletionRequest } from "../../types";

/** Canonical lowercase UUID, the shape the connector sends as `metadata.session_id`. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Seeds a provider with a known backend and configuration session so the routing
 * path resolves during a request flow without an HTTP discovery call.
 */
export function seedDiscoveredBackend(
    sandbox: sinon.SinonSandbox,
    provider: LiteLLMChatProvider,
    modelId: string
): void {
    const seededModel = {
        id: modelId,
        name: modelId,
        tooltip: "",
        family: "litellm",
        version: "1.0.0",
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        capabilities: { toolCalling: true, imageInput: false },
    } as unknown as vscode.LanguageModelChatInformation;

    // The BackendRegistry is the single source of truth. We reach into its private
    // `setModelsForBackend` write path to seed a known (id to backend) mapping
    // without going through the public `discoverModels` ingress. This is a
    // test-only seam: production code never calls `setModelsForBackend` directly.
    interface Internals {
        _registry: {
            setModelsForBackend: (
                backendKey: string,
                baseUrl: string,
                apiKey: string,
                routingIdentity: string,
                models: vscode.LanguageModelChatInformation[]
            ) => void;
        };
        _configManager: {
            convertProviderConfiguration: (
                configuration: Record<string, unknown>,
                clientOptions: { discoveryTimeoutMs: number; userAgent: string }
            ) => { backendName: string; baseUrl: string; apiKey: string } | undefined;
        };
    }
    const providerInternals = provider as unknown as Internals;
    providerInternals._registry.setModelsForBackend(
        "http://localhost:4000#seeded",
        "http://localhost:4000",
        "test-api-key",
        "localhost:4000",
        [seededModel]
    );
    sandbox.stub(providerInternals._configManager, "convertProviderConfiguration").returns({
        backendName: "localhost:4000",
        baseUrl: "http://localhost:4000",
        apiKey: "test-api-key",
        client: {} as never,
    } as never);
}

/**
 * Returns the graceful-error text part the provider reports instead of throwing.
 *
 * A structural check, not `instanceof`: the extension host test environment can
 * load multiple `vscode` module instances.
 */
export function findErrorTextPart(reported: vscode.LanguageModelResponsePart[]): string | undefined {
    for (const part of reported) {
        const value = (part as unknown as Record<string, unknown>)?.value;
        if (typeof value === "string" && value.includes("[litellm-connector]")) {
            return value;
        }
    }
    return undefined;
}

/** Waits until `predicate` holds, failing the test after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(message);
}

/** Waits until the provider has reported a text part containing `fragment`. */
export function waitForReportedText(reported: vscode.LanguageModelResponsePart[], fragment: string): Promise<void> {
    return waitFor(
        () => reported.some((part) => part instanceof vscode.LanguageModelTextPart && part.value.includes(fragment)),
        `the provider never reported text containing "${fragment}"`
    );
}

/** Awaits `work`, failing the test if it has not settled within `timeoutMs`. */
export async function settleWithin(work: Promise<void>, timeoutMs: number, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        await Promise.race([work, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/** Runs one chat request against `provider`, collecting every reported part. */
export function runChatRequest(
    provider: LiteLLMChatProvider,
    reported: vscode.LanguageModelResponsePart[],
    token?: vscode.CancellationToken,
    modelOptions: Record<string, unknown> = {},
    messages?: vscode.LanguageModelChatRequestMessage[]
): Promise<void> {
    return provider.provideLanguageModelChatResponse(
        {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        },
        messages ?? [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ],
        {
            modelOptions,
            tools: [],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
            configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                string,
                unknown
            >,
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        { report: (part: vscode.LanguageModelResponsePart) => reported.push(part) },
        token ?? new vscode.CancellationTokenSource().token
    );
}

/** Gives `provider` a working config and a seeded backend for `model-1`. */
export function stubConfigAndDiscovery(sandbox: sinon.SinonSandbox, provider: LiteLLMChatProvider): void {
    const providerWithConfig = provider as unknown as {
        _configManager: { getConfig: () => Promise<Record<string, unknown>> };
    };
    sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
    seedDiscoveredBackend(sandbox, provider, "model-1");
}

/** Answers every chat call with a stream that carries no content, recording it. */
export function stubCleanChatStream(sandbox: sinon.SinonSandbox, sent: OpenAIChatCompletionRequest[]): void {
    const encoder = new TextEncoder();
    sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
        sent.push(request);
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
    });
}
