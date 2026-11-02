import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient, LiteLLMRateLimitError } from "../../adapters/litellmClient";
import { ActiveRequestRegistry, type ActiveRequestPhase } from "../activeRequests";
import { StructuredLogger } from "../../observability/structuredLogger";
import { CopilotMdManager, type CopilotMdEntry } from "../../observability";
import type { OpenAIChatCompletionRequest } from "../../types";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { createMockSecrets } from "../../test/utils/testMocks";
import { createMockSSEStream } from "../../test/utils/testStreamUtils";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Retry backoff long enough that only a cancellation can end the request promptly. */
const BACKOFF_MS = 5_000;

/**
 * Seeds a provider with a known backend and configuration session so the
 * routing path resolves during a request flow without an HTTP discovery call.
 */
function seedDiscoveredBackend(sandbox: sinon.SinonSandbox, provider: LiteLLMChatProvider, modelId: string): void {
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

    // The BackendRegistry is the single source of truth. We reach into
    // its private `setModelsForBackend` write path to seed a known
    // (id → backend) mapping without going through the public
    // `discoverModels` ingress. This is a test-only seam: production
    // code never calls `setModelsForBackend` directly. We use a typed
    // `Internals` interface (cast via `unknown`) to keep this typed
    // and avoid `any` casts at the call site. The test cares about
    // the response-time routing path, not the discovery HTTP fetch.
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

suite("LiteLLM Chat Provider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    const mockSecrets = createMockSecrets({
        "litellm-connector.baseUrl": "http://localhost:4000",
        "litellm-connector.apiKey": "test-api-key",
    });

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("provideTokenCount handles string and message inputs", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const tokenSource = new vscode.CancellationTokenSource();

        const stringCount = await provider.provideTokenCount(
            {
                id: "gpt-4",
                name: "gpt-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            "12345",
            tokenSource.token
        );

        // "12345" -> 1-2 tokens depending on tokenizer
        assert.ok(
            stringCount >= 1 && stringCount <= 2,
            `stringCount (${stringCount}) should be within expected range [1, 2]`
        );

        const message: vscode.LanguageModelChatRequestMessage = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("1234"), new vscode.LanguageModelTextPart("abc")],
        };

        const messageCount = await provider.provideTokenCount(
            {
                id: "gpt-4",
                name: "gpt-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            message,
            tokenSource.token
        );

        // "1234" (1) + "abc" (1) + overhead (3) = 5 (or 6 depending on role/message formatting)
        assert.ok(
            messageCount >= 2 && messageCount <= 6,
            `messageCount (${messageCount}) should be within expected range [2, 6]`
        );
    });

    test("provideLanguageModelChatResponse throws when config URL is missing", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: { getConfig: () => Promise<{ url?: string }> };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: undefined });

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];

        const reportedConfig: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reportedConfig.push(part) },
            new vscode.CancellationTokenSource().token
        );
        const configErrorText = findErrorTextPart(reportedConfig);
        assert.ok(configErrorText, "missing config must surface as an error text part");
        assert.match(configErrorText, /No baseUrl|No apiKey|configure the LiteLLM provider group/i);
    });

    test("provideLanguageModelChatResponse reports an unsupported model parameter once", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        // Seed the discovered model list so the per-group routing path in
        // `sendRequestToLiteLLM` finds a backend; otherwise the request fails
        // with "LiteLLM configuration not found" before reaching the stub.
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        const errorBody = JSON.stringify({ error: { message: "Unsupported parameter: temperature" } });
        chatStub.rejects(new LiteLLMApiError(400, errorBody, `LiteLLM API error: 400 Bad Request\n${errorBody}`));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];

        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            {
                modelOptions: { temperature: 0.9, top_p: 0.8 },
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        // Resending the same body would be rejected identically, so the failure
        // surfaces once with the proxy-side fix instead of being retried.
        assert.strictEqual(chatStub.callCount, 1);
        const errorPart = parts.find(
            (part) => part instanceof vscode.LanguageModelTextPart && part.value.includes("additional_drop_params")
        );
        assert.ok(errorPart, "expected the rejection to surface with the proxy-side hint");
    });

    /**
     * Runs one chat request whose client call rejects with `error`, returning the
     * reported parts, the client call stub, and the request ids of `request.failed` logs.
     */
    async function respondWithClientFailure(error: Error): Promise<{
        parts: vscode.LanguageModelResponsePart[];
        chatStub: sinon.SinonStub;
        failedRequestIds: unknown[];
    }> {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<{ url: string }> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat").rejects(error);
        const errorLogStub = sandbox.stub(StructuredLogger, "error");

        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
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
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        const failedRequestIds = errorLogStub
            .getCalls()
            .filter((call) => call.args[0] === "request.failed")
            .map((call) => (call.args[1] as { requestId?: unknown }).requestId);
        return { parts, chatStub, failedRequestIds };
    }

    test("explains a rate-limit give-up in the error notice, naming the setting", async () => {
        const body = JSON.stringify({ error: { message: "Rate limit reached for model-1" } });
        const rateLimitError = new LiteLLMRateLimitError(
            { reason: "retry_after_exceeds_budget", waitedMs: 0, budgetMs: 120_000, retryAfterMs: 300_000 },
            "Too Many Requests",
            body
        );

        const { parts } = await respondWithClientFailure(rateLimitError);

        assert.strictEqual(
            findErrorTextPart(parts)?.trim(),
            `[litellm-connector] LiteLLM Error (model-1): Rate limit reached for model-1. ` +
                `The proxy asked to retry in 300s, more than the 120s left ` +
                `under litellm-connector.rateLimitMaxDelaySeconds, so the request was not retried. ` +
                `Try again later, or raise the setting.`
        );
    });

    test("does not add the rate-limit hint to other 429 errors", async () => {
        const body = JSON.stringify({ error: { message: "Too many requests" } });

        const { parts } = await respondWithClientFailure(
            new LiteLLMApiError(429, body, `LiteLLM API error: 429 Too Many Requests\n${body}`)
        );

        assert.strictEqual(
            findErrorTextPart(parts)?.trim(),
            "[litellm-connector] LiteLLM Error (model-1): Too many requests"
        );
    });

    test("passes its request id to the client, so rate-limit logs match the request logs", async () => {
        const body = JSON.stringify({ error: { message: "Rate limit reached" } });
        const rateLimitError = new LiteLLMRateLimitError(
            { reason: "budget_exhausted", waitedMs: 120_000, budgetMs: 120_000 },
            "Too Many Requests",
            body
        );

        const { chatStub, failedRequestIds } = await respondWithClientFailure(rateLimitError);

        const clientRequestId: unknown = chatStub.firstCall.args[3];
        assert.ok(typeof clientRequestId === "string" && clientRequestId.length > 0, "client got no request id");
        assert.deepStrictEqual(failedRequestIds, [clientRequestId]);
    });

    test("provideLanguageModelChatResponse uses the model VS Code selected without a settings override", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        const encoder = new TextEncoder();
        chatStub.callsFake(
            async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                })
        );

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        // The routed model is the one VS Code selected.
        assert.strictEqual(chatStub.calledOnce, true);
        assert.strictEqual((chatStub.firstCall.args[0] as { model?: string }).model, "model-1");
    });

    test("provideLanguageModelChatResponse throws on cancellation during request", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("boom"));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const token: vscode.CancellationToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken;

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        requestInitiator: "test",
                        configuration: {
                            baseUrl: "http://localhost:4000",
                            apiKey: "test-api-key",
                        } as unknown as Record<string, unknown>,
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    token
                ),
            /Operation cancelled by user/
        );
    });

    test("provideLanguageModelChatResponse surfaces parsed API error details", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox
            .stub(LiteLLMClient.prototype, "chat")
            .rejects(new Error('LiteLLM API error\n{"error":{"message":"temperature unsupported"}}'));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];

        const reportedParsed: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            {
                modelOptions: { temperature: 0.9 },
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: {
                    baseUrl: "http://localhost:4000",
                    apiKey: "test-api-key",
                } as unknown as Record<string, unknown>,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reportedParsed.push(part) },
            new vscode.CancellationTokenSource().token
        );
        const parsedErrorText = findErrorTextPart(reportedParsed);
        assert.ok(parsedErrorText, "parsed API error must surface as an error text part");
        assert.match(parsedErrorText, /temperature unsupported/i);
    });

    test("provideLanguageModelChatResponse decorates temperature-related API errors", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox
            .stub(LiteLLMClient.prototype, "chat")
            .rejects(new Error('LiteLLM API error\n{"error":{"message":"temperature"}}'));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const reportedDecorated: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: { temperature: 0.9 },
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: {
                    baseUrl: "http://localhost:4000",
                    apiKey: "test-api-key",
                } as unknown as Record<string, unknown>,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reportedDecorated.push(part) },
            new vscode.CancellationTokenSource().token
        );
        const decoratedErrorText = findErrorTextPart(reportedDecorated);
        assert.ok(decoratedErrorText, "decorated API error must surface as an error text part");
        assert.match(decoratedErrorText, /may not support certain parameters/i);
    });

    test("provideLanguageModelChatResponse surfaces non-API errors as response text", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: { getConfig: () => Promise<{ url: string }> };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("boom"));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const reportedNonApi: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: {
                    baseUrl: "http://localhost:4000",
                    apiKey: "test-api-key",
                } as unknown as Record<string, unknown>,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reportedNonApi.push(part) },
            new vscode.CancellationTokenSource().token
        );
        const nonApiErrorText = findErrorTextPart(reportedNonApi);
        assert.ok(nonApiErrorText, "non-API error must surface as an error text part");
        assert.match(nonApiErrorText, /boom/);
    });

    test("provideLanguageModelChatResponse handles streaming response", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const tokenSource = new vscode.CancellationTokenSource();

        // Mock LiteLLMClient.chat to return a stream.
        // Important: `decodeSSE` splits on single newlines, so each SSE line must end with `\n`.
        const encoder = new TextEncoder();
        // Note: VS Code extension host runs on Node, which doesn't always provide a global
        // Web `ReadableStream`. Use Node's implementation to ensure `.getReader()` exists.
        const { ReadableStream } = await import("node:stream/web");
        const makeStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n"));
                    controller.close();
                },
            });

        // `LiteLLMProviderBase` constructs its own `LiteLLMClient`, so stubbing the prototype
        // doesn't always intercept in the extension host test environment.
        // (Not needed for this test since we call `processStreamingResponse` directly.)

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        // We need to mock the config for inactivity timeout
        interface ProviderWithConfig {
            _configManager: {
                getConfig: () => Promise<unknown>;
            };
        }
        const pWithConfig = provider as unknown as ProviderWithConfig;
        sandbox.stub(pWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            inactivityTimeout: 60,
        });

        // Sanity-check the SSE decoder itself.
        const { decodeSSE } = await import("../../adapters/sse/sseDecoder.js");
        const decoded: string[] = [];
        for await (const payload of decodeSSE(makeStream(), tokenSource.token)) {
            decoded.push(payload);
        }
        assert.deepStrictEqual(decoded, ['{"choices":[{"delta":{"content":"Hello"}}]}']);

        // Exercise the streaming pipeline directly (deterministic unit test).
        const providerTest = provider as unknown as {
            processStreamingResponse: (
                stream: AsyncIterable<string>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken,
                requestId: string
            ) => Promise<void>;
        };

        await providerTest.processStreamingResponse(
            makeStream() as unknown as AsyncIterable<string>,
            progress,
            tokenSource.token,
            "req-hello"
        );

        // Avoid brittle `instanceof` checks in the extension host (multiple `vscode` module instances can exist).
        // Instead, assert on the structural shape of the emitted parts.
        const textParts = parts.filter(
            (p): p is vscode.LanguageModelTextPart =>
                p instanceof vscode.LanguageModelTextPart ||
                typeof (p as unknown as Record<string, unknown>)?.value === "string"
        );
        assert.ok(
            textParts.length > 0,
            `Expected at least one text part, got: ${parts.map((p) => p.constructor?.name).join(", ")}`
        );
        assert.strictEqual(textParts.map((p) => p.value).join(""), "Hello");
    });

    test("processStreamingResponse disposes its cancellation listener when the stream ends", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const { ReadableStream } = await import("node:stream/web");
        const encoder = new TextEncoder();

        const disposed: boolean[] = [];
        const token: vscode.CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: (listener: () => unknown) => {
                void listener;
                return { dispose: () => disposed.push(true) };
            },
        } as unknown as vscode.CancellationToken;

        const pWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<unknown> };
            processStreamingResponse: (
                stream: AsyncIterable<string>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken,
                requestId: string
            ) => Promise<void>;
        };
        sandbox.stub(pWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            inactivityTimeout: 60,
        });

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n'));
                controller.enqueue(encoder.encode("data: [DONE]\n"));
                controller.close();
            },
        });
        await pWithConfig.processStreamingResponse(
            stream as unknown as AsyncIterable<string>,
            { report: () => {} },
            token,
            "req-dispose"
        );

        assert.strictEqual(disposed.length, 1, "the cancellation listener must be disposed exactly once");
    });

    test("provideLanguageModelChatResponse emits usage data part via StreamTokenCapture after streaming", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(
            async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                })
        );

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const reported: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        // Usage data should now be emitted by StreamTokenCapture.flushUsage()
        const usagePart = reported.find((part) => part instanceof vscode.LanguageModelDataPart);
        assert.ok(usagePart, "Expected a usage LanguageModelDataPart to be emitted by StreamTokenCapture");
        assert.strictEqual(usagePart.mimeType, "usage");

        // Verify the usage payload has the expected structure
        const payload = JSON.parse(Buffer.from(usagePart.data).toString("utf-8")) as {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
        assert.ok(payload.prompt_tokens > 0, "Expected prompt_tokens to be positive");
        assert.ok(payload.completion_tokens > 0, "Expected completion_tokens to be positive");
        assert.strictEqual(payload.total_tokens, payload.prompt_tokens + payload.completion_tokens);
    });

    test("requests usage by default and suppresses include_usage after upstream rejects stream_options", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerAny = provider as unknown as {
            buildOpenAIChatRequest: (typeof LiteLLMChatProvider.prototype)["buildOpenAIChatRequest"];
            _configManager: { getConfig: () => Promise<{ url: string }> };
        };

        sandbox.stub(providerAny._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        // A namespaced id is what VS Code hands back, and the request body must
        // carry the raw name, so the memo is only correct if both sides agree.
        const NAMESPACED_ID = "localhost:4000/model-usage";
        seedDiscoveredBackend(sandbox, provider, NAMESPACED_ID);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];
        const model = {
            id: NAMESPACED_ID,
            name: "model-usage",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };
        const requestOptions = {
            modelOptions: {},
            tools: [],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
            configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                string,
                unknown
            >,
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

        const requestBody = (
            await providerAny.buildOpenAIChatRequest(messages, model, requestOptions, undefined, "chat")
        ).request;
        assert.deepStrictEqual(requestBody.stream_options, { include_usage: true });

        // Exercise the real retry path: the rejection must make the retry drop
        // the flag, and the memo must be keyed so the next request omits it too.
        const usageErrorBody = "Unsupported parameter: stream_options";
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub
            .onFirstCall()
            .rejects(new LiteLLMApiError(400, usageErrorBody, `LiteLLM API error: 400 Bad Request\n${usageErrorBody}`));
        chatStub.onSecondCall().callsFake(async () => createMockSSEStream(["ok"]));

        const token = new vscode.CancellationTokenSource().token;
        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            requestOptions,
            { report: () => undefined },
            token
        );

        assert.strictEqual(chatStub.callCount, 2, "one rejection plus one retry");
        const retryRequest = chatStub.getCall(1).args[0] as OpenAIChatCompletionRequest;
        assert.strictEqual(retryRequest.stream_options, undefined, "the retry must not resend stream_options");

        // A later request must not pay the same failed round trip. This is what
        // the memo is for, and it only works when both sides use the same key.
        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            requestOptions,
            { report: () => undefined },
            token
        );

        assert.strictEqual(chatStub.callCount, 3, "the second request must need a single attempt");
        const laterRequest = chatStub.getCall(2).args[0] as OpenAIChatCompletionRequest;
        assert.strictEqual(laterRequest.stream_options, undefined, "the memo must suppress the flag");
    });

    test("prefers streamed usage metrics over estimated counts", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox
            .stub(
                (
                    provider as unknown as {
                        _configManager: {
                            getConfig: () => Promise<{ url: string }>;
                        };
                    }
                )._configManager,
                "getConfig"
            )
            .resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-usage");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}' + "\n\n"));
                    controller.enqueue(
                        encoder.encode(
                            'data: {"usage":{"prompt_tokens":12,"completion_tokens":7,"input_token_details":{"cached_tokens":3},"output_token_details":{"reasoning_tokens":2},"system_tokens":5}}' +
                                "\n\n"
                        )
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const telemetrySpy = sandbox.spy(LiteLLMTelemetry, "reportMetric");
        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-usage",
                name: "model-usage",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        const usagePart = parts.find((p) => p instanceof vscode.LanguageModelDataPart) as vscode.LanguageModelDataPart;
        const payload = JSON.parse(Buffer.from(usagePart.data).toString("utf-8")) as Record<string, unknown>;
        assert.strictEqual(payload.prompt_tokens, 12);
        assert.strictEqual(payload.completion_tokens, 7);
        assert.strictEqual((payload.prompt_tokens_details as { cached_tokens: number }).cached_tokens, 3);
        assert.strictEqual(
            (payload.completion_tokens_details as { reasoning_tokens: number; tool_tokens: number }).reasoning_tokens,
            2
        );
        assert.strictEqual(
            (payload.completion_tokens_details as { reasoning_tokens: number; tool_tokens?: number }).tool_tokens,
            undefined
        );
        assert.strictEqual(payload.system_prompt_tokens, 5);
        assert.strictEqual(payload.estimated_input_cost, 0);
        assert.strictEqual(payload.estimated_output_cost, 0);
        assert.strictEqual(payload.estimated_total_cost, 0);

        sinon.assert.calledWithMatch(telemetrySpy, sinon.match({ tokensIn: 12, tokensOut: 7 }));
    });

    test("reports the request initiator as the caller", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const model = {
            id: "model-caller",
            name: "model-caller",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            // A stray `tags` property must not influence caller attribution.
            tags: ["inline-completions"],
        } as vscode.LanguageModelChatInformation;
        seedDiscoveredBackend(sandbox, provider, "model-caller");
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(createMockSSEStream(["ok"]));

        const telemetrySpy = sandbox.spy(LiteLLMTelemetry, "reportMetric");
        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "core",
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        sinon.assert.calledWithMatch(telemetrySpy, sinon.match({ caller: "core" }));
    });

    test("reports an unknown caller when VS Code sends no initiator", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const model = {
            id: "model-caller-missing",
            name: "model-caller-missing",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            // A stray `tags` property must not become a caller fallback either.
            tags: ["inline-completions"],
        } as vscode.LanguageModelChatInformation;
        seedDiscoveredBackend(sandbox, provider, "model-caller-missing");
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(createMockSSEStream(["ok"]));

        const telemetrySpy = sandbox.spy(LiteLLMTelemetry, "reportMetric");
        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        sinon.assert.calledWithMatch(telemetrySpy, sinon.match({ caller: "unknown" }));
    });

    test("names the .copilotmd export after the caller", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const model = {
            id: "model-caller-export",
            name: "model-caller-export",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        } as vscode.LanguageModelChatInformation;
        seedDiscoveredBackend(sandbox, provider, "model-caller-export");
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(createMockSSEStream(["ok"]));
        const exportStub = sandbox.stub(CopilotMdManager.instance, "exportEntry").resolves(undefined);

        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "background-summarizer",
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        sinon.assert.calledOnce(exportStub);
        assert.strictEqual(exportStub.firstCall.args[0].debugName, "background-summarizer");
    });

    test("merges partial usage frames to avoid dropping previously reported token details", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox
            .stub(
                (
                    provider as unknown as {
                        _configManager: {
                            getConfig: () => Promise<{ url: string }>;
                        };
                    }
                )._configManager,
                "getConfig"
            )
            .resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-partial-usage");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}' + "\n\n"));
                    controller.enqueue(
                        encoder.encode(
                            'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"input_token_details":{"cached_tokens":3},"output_token_details":{"reasoning_tokens":2,"tool_tokens":1},"system_tokens":5}}' +
                                "\n\n"
                        )
                    );
                    // Simulate a later sparse usage frame from upstream that omits details or sends lower values.
                    controller.enqueue(
                        encoder.encode('data: {"usage":{"prompt_tokens":12,"completion_tokens":7}}' + "\n\n")
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const usageParts: vscode.LanguageModelDataPart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-partial-usage",
                name: "model-partial-usage",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            {
                report: (part) => {
                    if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
                        usageParts.push(part);
                    }
                },
            },
            new vscode.CancellationTokenSource().token
        );

        assert.ok(usageParts.length >= 2, "Expected at least two usage data frames");
        const finalPayload = JSON.parse(Buffer.from(usageParts[usageParts.length - 1].data).toString("utf-8")) as {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            system_prompt_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number; tool_tokens?: number };
            estimated_input_cost?: number;
            estimated_output_cost?: number;
            estimated_total_cost?: number;
        };

        assert.strictEqual(finalPayload.prompt_tokens, 12);
        assert.strictEqual(finalPayload.completion_tokens, 7);
        assert.strictEqual(finalPayload.total_tokens, 19);
        assert.strictEqual(finalPayload.prompt_tokens_details?.cached_tokens, 3);
        assert.strictEqual(finalPayload.completion_tokens_details?.reasoning_tokens, 2);
        assert.strictEqual(finalPayload.completion_tokens_details?.tool_tokens, 1);
        assert.strictEqual(finalPayload.system_prompt_tokens, 5);
        assert.strictEqual(finalPayload.estimated_input_cost, 0);
        assert.strictEqual(finalPayload.estimated_output_cost, 0);
        assert.strictEqual(finalPayload.estimated_total_cost, 0);
    });

    test("counts tool-call only responses in fallback token reporting", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox
            .stub(
                (
                    provider as unknown as {
                        _configManager: {
                            getConfig: () => Promise<{ url: string }>;
                        };
                    }
                )._configManager,
                "getConfig"
            )
            .resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-tool-only");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}' +
                                "\n\n"
                        )
                    );
                    controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"tool_calls"}]}' + "\n\n"));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const telemetrySpy = sandbox.spy(LiteLLMTelemetry, "reportMetric");
        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-tool-only",
                name: "model-tool-only",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        const usagePart = parts.find((part) => part instanceof vscode.LanguageModelDataPart) as
            vscode.LanguageModelDataPart | undefined;
        if (usagePart) {
            const payload = JSON.parse(Buffer.from(usagePart.data).toString("utf-8")) as {
                completion_tokens: number;
                completion_tokens_details?: { tool_tokens?: number };
                estimated_input_cost?: number;
                estimated_output_cost?: number;
                estimated_total_cost?: number;
            };
            assert.ok(payload.completion_tokens > 0);
            assert.ok((payload.completion_tokens_details?.tool_tokens ?? 0) > 0);
            assert.strictEqual(payload.estimated_input_cost ?? 0, 0);
            assert.strictEqual(payload.estimated_output_cost ?? 0, 0);
            assert.strictEqual(payload.estimated_total_cost ?? 0, 0);
        }
        sinon.assert.calledWithMatch(
            telemetrySpy,
            sinon.match((metric: unknown) => {
                const typedMetric = metric as { tokensOut?: number; toolTokens?: number; estimatedTotalCost?: number };
                return (
                    (typedMetric.tokensOut ?? 0) > 0 &&
                    (typedMetric.toolTokens ?? 0) > 0 &&
                    (typedMetric.estimatedTotalCost ?? 0) === 0
                );
            })
        );
    });

    test("provideLanguageModelChatResponse handles empty stream without emitting parts", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            })
        );

        const reported: vscode.LanguageModelResponsePart[] = [];

        await provider.provideLanguageModelChatResponse(
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
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        // The provider completes gracefully with the failure as an error
        // text part so VS Code keeps the turn in the conversation history.
        const errorText = findErrorTextPart(reported);
        assert.ok(errorText, "a stream ending before [DONE] must surface as an error text part");
        assert.match(errorText, /Stream ended before \[DONE\] marker/);
    });

    test("provideLanguageModelChatResponse recovers pending tool calls when stream ends without [DONE] marker", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        // Simulate a stream that has complete tool calls but ends without [DONE]
        // This is the Bug #97 scenario: long-running request (63+ seconds) to Azure/Anthropic
        // that produces multiple SSE events with tool calls but then closes without [DONE]
        const { ReadableStream } = await import("node:stream/web");
        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    // Emit a complete tool call in one message (to avoid incomplete buffer)
                    // This represents a tool call that was fully received
                    controller.enqueue(
                        encoder.encode(
                            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"my_tool","arguments":"{}"}}]}}]}\n'
                        )
                    );

                    // Close stream WITHOUT sending [DONE] marker
                    // This simulates the Bug #97 scenario where stream closes after tool calls
                    controller.close();
                },
            })
        );

        const reported: vscode.LanguageModelResponsePart[] = [];
        let threwError = false;
        let errorMessage = "";

        try {
            await provider.provideLanguageModelChatResponse(
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
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                {
                    modelOptions: {},
                    tools: [
                        {
                            name: "my_tool",
                            description: "A test tool",
                            inputSchema: { type: "object", properties: { param: { type: "string" } } },
                        },
                    ],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    requestInitiator: "test",
                    configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                        string,
                        unknown
                    >,
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: (part) => reported.push(part) },
                new vscode.CancellationTokenSource().token
            );
        } catch (err) {
            threwError = true;
            errorMessage = err instanceof Error ? err.message : String(err);
        }

        // Tier 2: Recovery should succeed (stream ended cleanly after tool calls, just no [DONE])
        // If there WAS incomplete data, recovery would still attempt to emit buffered tool calls
        if (threwError) {
            // If error thrown, it means there was incomplete data in buffer
            // Recovery code should have attempted to flush, but let's just verify the error happened
            assert.ok(
                errorMessage.includes("Stream ended before [DONE] marker"),
                `Expected stream-end error but got: ${errorMessage}`
            );
        } else {
            // No error means stream closed cleanly after events (Tier 1 or recovery success)
            // Verify tool call was emitted
            const toolCallParts = reported.filter(
                (p): p is vscode.LanguageModelToolCallPart =>
                    p instanceof vscode.LanguageModelToolCallPart ||
                    typeof (p as unknown as Record<string, unknown>)?.name === "string"
            );
            assert.strictEqual(toolCallParts.length, 1, "Should emit tool call part");
            assert.strictEqual(toolCallParts[0].name, "my_tool", "Tool call should have correct name");
        }
    });

    /**
     * Shared harness for the mid-stream resume tests: stubs the transport so
     * attempt 1 emits a partial response then dies with a retriable error,
     * attempt 2 completes the response, and records the wire bodies sent.
     */
    function runResumeScenario(opts: { firstAttemptEvents: string[]; firstAttemptError: Error }): {
        sentRequests: OpenAIChatCompletionRequest[];
        reported: vscode.LanguageModelResponsePart[];
    } {
        const encoder = new TextEncoder();
        const sentRequests: OpenAIChatCompletionRequest[] = [];
        const reported: vscode.LanguageModelResponsePart[] = [];

        // Erroring a ReadableStream clears its queued chunks, so the error
        // must be raised from `pull` (which runs only after the queue is
        // drained), not from `start`: otherwise the streamed events are lost
        // before the consumer reads them and there is nothing to resume from.
        const makeDyingStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const event of opts.firstAttemptEvents) {
                        controller.enqueue(encoder.encode(event));
                    }
                },
                pull(controller) {
                    controller.error(opts.firstAttemptError);
                },
            });

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.onFirstCall().callsFake(async (request: OpenAIChatCompletionRequest) => {
            sentRequests.push(request);
            return makeDyingStream();
        });
        chatStub.onSecondCall().callsFake(async (request: OpenAIChatCompletionRequest) => {
            sentRequests.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" done."}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        return { sentRequests, reported };
    }

    test("transport retry sends the streamed text as the trailing assistant message", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string } & Record<string, unknown>>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const { sentRequests, reported } = runResumeScenario({
            firstAttemptEvents: [
                'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"lo wor"}}]}\n\n',
            ],
            firstAttemptError: new TypeError("terminated"),
        });

        await provider.provideLanguageModelChatResponse(
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
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sentRequests.length, 2, "Expected two HTTP attempts");
        const first = sentRequests[0].messages;
        const second = sentRequests[1].messages;
        assert.strictEqual(first.length, 1, "First attempt carries only the user message");
        assert.strictEqual(second.length, 3, "Resume appends a trailing assistant message plus the Continue nudge");
        assert.strictEqual(second[1].role, "assistant");
        assert.strictEqual(second[1].content, "Hello wor");
        assert.strictEqual(second[2].role, "user");
        assert.strictEqual(second[2].content, "Continue");
    });

    test("transport retry sends the streamed reasoning as reasoning_content", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string } & Record<string, unknown>>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const { sentRequests, reported } = runResumeScenario({
            firstAttemptEvents: [
                'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
                'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}\n\n',
            ],
            firstAttemptError: new TypeError("terminated"),
        });

        await provider.provideLanguageModelChatResponse(
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
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sentRequests.length, 2, "Expected two HTTP attempts");
        const second = sentRequests[1].messages;
        assert.strictEqual(second.length, 3, "Resume appends a trailing assistant message plus the Continue nudge");
        assert.strictEqual(second[1].reasoning_content, "thinking hard");
        assert.strictEqual(second[1].content, "Hel");
        assert.strictEqual(second[2].role, "user");
        assert.strictEqual(second[2].content, "Continue");
    });

    test("reasoning-only retry sends the streamed reasoning as reasoning_content", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string } & Record<string, unknown>>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 2,
            emptyResponseRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const encoder = new TextEncoder();
        const sentRequests: OpenAIChatCompletionRequest[] = [];

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.onFirstCall().callsFake(async (request: OpenAIChatCompletionRequest) => {
            sentRequests.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"cut-off thought"}}]}\n\n')
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });
        chatStub.onSecondCall().callsFake(async (request: OpenAIChatCompletionRequest) => {
            sentRequests.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Answer."}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        const reported: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
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
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sentRequests.length, 2, "Expected two HTTP attempts");
        const second = sentRequests[1].messages;
        assert.strictEqual(second.length, 3, "Retry appends a trailing assistant message plus the Continue nudge");
        assert.strictEqual(second[1].reasoning_content, "cut-off thought");
        assert.strictEqual(second[1].content, "", "reasoning-only retry must carry empty-string content");
        assert.strictEqual(second[2].role, "user");
        assert.strictEqual(second[2].content, "Continue");
    });

    /**
     * Returns the graceful-error text part the provider reports instead of
     * throwing (structural check, no instanceof: the extension host test
     * environment can load multiple vscode module instances).
     */
    function findErrorTextPart(reported: vscode.LanguageModelResponsePart[]): string | undefined {
        for (const part of reported) {
            const value = (part as unknown as Record<string, unknown>)?.value;
            if (typeof value === "string" && value.includes("[litellm-connector]")) {
                return value;
            }
        }
        return undefined;
    }

    /** Waits until `predicate` holds, failing the test after `timeoutMs`. */
    async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
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
    function waitForReportedText(reported: vscode.LanguageModelResponsePart[], fragment: string): Promise<void> {
        return waitFor(
            () =>
                reported.some((part) => part instanceof vscode.LanguageModelTextPart && part.value.includes(fragment)),
            `the provider never reported text containing "${fragment}"`
        );
    }

    /** Every text the provider reported, joined in report order. */
    function reportedText(reported: vscode.LanguageModelResponsePart[]): string {
        return reported
            .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value)
            .join("");
    }

    /** Awaits `work`, failing the test if it has not settled within `timeoutMs`. */
    async function settleWithin(work: Promise<void>, timeoutMs: number, message: string): Promise<void> {
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

    function runChatRequest(
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
            { report: (part) => reported.push(part) },
            token ?? new vscode.CancellationTokenSource().token
        );
    }

    function stubConfigAndDiscovery(sandbox: sinon.SinonSandbox, provider: LiteLLMChatProvider): void {
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");
    }

    function stubCleanChatStream(sandbox: sinon.SinonSandbox, sent: OpenAIChatCompletionRequest[]): void {
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

    test("tool call already emitted before a transport error blocks the retry", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const localReported: vscode.LanguageModelResponsePart[] = [];
        const localSent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            localSent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n'
                        )
                    );
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        });

        await runChatRequest(provider, localReported);
        assert.strictEqual(localSent.length, 1, "A tool call was already emitted, so no second attempt is sent");
        const toolCall = localReported.find(
            (p): p is vscode.LanguageModelToolCallPart =>
                p instanceof vscode.LanguageModelToolCallPart ||
                typeof (p as unknown as Record<string, unknown>)?.name === "string"
        );
        assert.ok(toolCall, "the tool call reached VS Code before the transport death");
        const blockedErrorText = findErrorTextPart(localReported);
        assert.ok(blockedErrorText, "the blocked transport error must still surface as an error text part");
        assert.match(blockedErrorText, /terminated/);
    });

    test("transport retries exhausted after the budget surfaces the transport error", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 2,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        });

        await runChatRequest(provider, reported);
        // attempt 0 + networkRetries 2 = 3 total requests
        assert.strictEqual(sent.length, 3, "transport budget must be exhausted");
        const exhaustedErrorText = findErrorTextPart(reported);
        assert.ok(exhaustedErrorText, "exhausted transport retries must surface as an error text part");
        assert.match(exhaustedErrorText, /terminated/);
    });

    test("transport retry resends the unchanged request when the attempt produced nothing", async () => {
        // The history ends with an assistant turn, which is the case where a resume
        // would append a "Continue" nudge even though the failed attempt produced
        // nothing to continue.
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const encoder = new TextEncoder();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            if (sent.length === 1) {
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new Error("fetch failed"));
                    },
                });
            }
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        await runChatRequest(provider, reported, undefined, {}, [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("an earlier answer")],
            },
        ]);

        assert.strictEqual(sent.length, 2, "Expected two HTTP attempts");
        assert.deepStrictEqual(
            sent[1].messages,
            sent[0].messages,
            "an attempt that produced nothing has nothing to continue, so the request is resent unchanged"
        );
    });

    test("retry budget stops starting attempts once the time is spent", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 5,
            networkRetryDelayMs: 1,
            retryBudgetMs: 5,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            // Spend the budget before failing, so the next attempt is refused.
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new TypeError("terminated");
        });

        await runChatRequest(provider, reported);

        // The first failure starts the clock, so one retry is allowed. The second
        // failure spends the budget and no third attempt starts.
        assert.strictEqual(sent.length, 2, "no attempt may start after the retry budget is spent");
        const budgetText = findErrorTextPart(reported);
        assert.ok(budgetText, "the exhausted budget must surface as an error text part");
        assert.match(budgetText, /retryBudgetSeconds/);
    });

    test("clips the transport backoff to the time the budget has left", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 1,
            networkRetryDelayMs: 60_000,
            retryBudgetMs: 100,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        // A fixed clock keeps the two reads inside markFailure/clipDelay identical.
        sandbox.stub(Date, "now").returns(1_000);
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new TypeError("terminated");
        });

        await runChatRequest(provider, reported);

        const retryLog = warnStub
            .getCalls()
            .find((call) => call.args[0] === "request.transport_retry" && typeof call.args[1] === "object");
        assert.ok(retryLog, "the retry must be logged");
        assert.strictEqual(
            (retryLog.args[1] as { delayMs: number }).delayMs,
            100,
            "the 60s backoff is clipped to the 100ms the budget allows"
        );
    });

    test("clips the reasoning-only backoff to the time the budget has left", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 1,
            emptyResponseRetryDelayMs: 60_000,
            retryBudgetMs: 100,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        // A fixed clock keeps the two reads inside markFailure/clipDelay identical.
        sandbox.stub(Date, "now").returns(1_000);
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"more thought"}}]}\n\n')
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        await runChatRequest(provider, reported);

        const retryLog = warnStub
            .getCalls()
            .find((call) => call.args[0] === "request.reasoning_only_retry" && typeof call.args[1] === "object");
        assert.ok(retryLog, "the reasoning-only retry must be logged");
        assert.strictEqual(
            (retryLog.args[1] as { delayMs: number }).delayMs,
            100,
            "the 60s backoff is clipped to the 100ms the budget allows"
        );
    });

    test("reports the retry budget, not the reasoning-only count, when the budget stops that retry", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 5,
            emptyResponseRetryDelayMs: 1,
            retryBudgetMs: 5,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        // The clock advances per attempt, so the budget is spent deterministically.
        let now = 1_000;
        sandbox.stub(Date, "now").callsFake(() => now);
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            now += 10;
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"more thought"}}]}\n\n')
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        await runChatRequest(provider, reported);

        const text = findErrorTextPart(reported);
        assert.ok(text, "the failure must surface as an error text part");
        assert.match(text, /retryBudgetSeconds/, "the user must learn which setting ended the turn");
        assert.doesNotMatch(text, /reasoning-only response persisted/);
    });

    test("resends an unchanged request when the attempt streamed only whitespace", async () => {
        // Whitespace trims to nothing, so the attempt produced no output to continue.
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const encoder = new TextEncoder();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            if (sent.length === 1) {
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"\\n\\n"}}]}\n\n'));
                    },
                    pull(controller) {
                        controller.error(new TypeError("terminated"));
                    },
                });
            }
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        await runChatRequest(provider, reported, undefined, {}, [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("an earlier answer")],
            },
        ]);

        assert.strictEqual(sent.length, 2, "Expected two HTTP attempts");
        assert.deepStrictEqual(
            sent[1].messages,
            sent[0].messages,
            "whitespace-only output is nothing to continue, so the request is resent unchanged"
        );
    });

    test("surfaces the headers timeout setting when the proxy never answers", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 0,
            retryBudgetMs: 0,
            headersTimeoutMs: 5,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        // The request only settles when the connector's header timer aborts it.
        sandbox.stub(global, "fetch").callsFake(
            (_input: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                })
        );

        await runChatRequest(provider, reported);

        const text = findErrorTextPart(reported);
        assert.ok(text, "the timeout must surface as an error text part");
        assert.match(text, /litellm-connector\.headersTimeout/);
        assert.match(text, /after 5ms/, "the connector timer produced the failure, not the runner timeout");
    });

    /**
     * Cancels a request from the connector once its stream has delivered one delta,
     * and returns the stubs that recorded the outcome. The stream never finishes on
     * its own, so the cancellation is the only thing that can end this request.
     */
    async function runConnectorCancelledRequest(): Promise<{
        registry: ActiveRequestRegistry;
        reported: vscode.LanguageModelResponsePart[];
        phaseAtCancel: ActiveRequestPhase | undefined;
        metricStub: sinon.SinonStub;
        exportStub: sinon.SinonStub;
        chatCalls: number;
    }> {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, undefined, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const encoder = new TextEncoder();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const exportStub = sandbox.stub(CopilotMdManager.instance, "exportEntry").resolves(undefined);
        let chatCalls = 0;
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            chatCalls += 1;
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                },
            });
        });

        const host = new vscode.CancellationTokenSource();
        const request = runChatRequest(provider, reported, host.token).catch(() => undefined);
        let phaseAtCancel: ActiveRequestPhase | undefined;
        try {
            // The cancel has to land mid-stream rather than during request construction.
            await waitForReportedText(reported, "partial");
            const [entry] = registry.list();
            assert.ok(entry, "the live request must be listed while it streams");
            phaseAtCancel = entry.phase;
            entry.cancel();
            await request;
        } finally {
            // Settles the request if the precondition failed before the cancel landed.
            host.cancel();
            await request;
            host.dispose();
        }

        return { registry, reported, phaseAtCancel, metricStub, exportStub, chatCalls };
    }

    /** The entry the provider wrote to the `.copilotmd` transcript. */
    function transcriptOf(exportStub: sinon.SinonStub): CopilotMdEntry {
        const transcript = exportStub.firstCall?.args[0] as CopilotMdEntry | undefined;
        assert.ok(transcript, "the turn must be written to the transcript");
        return transcript;
    }

    test("ends the turn with a notice when the connector cancels the request", async () => {
        const { reported } = await runConnectorCancelledRequest();

        assert.match(reportedText(reported), /cancelled from the LiteLLM connector/i);
    });

    test("does not retry a request the connector cancelled", async () => {
        const { chatCalls } = await runConnectorCancelledRequest();

        assert.strictEqual(chatCalls, 1);
    });

    test("lists a request as streaming once its stream starts", async () => {
        const { phaseAtCancel } = await runConnectorCancelledRequest();

        assert.strictEqual(phaseAtCancel, "streaming");
    });

    test("reports a connector cancellation as cancelled, not failed", async () => {
        const { metricStub } = await runConnectorCancelledRequest();

        const statuses = metricStub.getCalls().map((call) => (call.args[0] as { status?: string }).status);
        assert.deepStrictEqual(statuses, ["cancelled"]);
    });

    test("records a connector cancellation in the transcript", async () => {
        const { exportStub } = await runConnectorCancelledRequest();

        const transcript = transcriptOf(exportStub);
        assert.strictEqual(transcript.status, "canceled");
        assert.match(String(transcript.statusReason), /Cancelled from the LiteLLM connector/);
    });

    test("keeps the connector notice out of the transcript", async () => {
        const { exportStub } = await runConnectorCancelledRequest();

        // The transcript records what the model produced, before the notice is added.
        const parts = transcriptOf(exportStub).responseParts;
        assert.deepStrictEqual(
            parts.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "<not text>")),
            ["partial"]
        );
    });

    test("releases its host cancellation listener when the request ends", async () => {
        let registrations = 0;
        let disposeCalls = 0;
        const hostToken: vscode.CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => {
                registrations += 1;
                return {
                    dispose: (): void => {
                        disposeCalls += 1;
                    },
                };
            },
        };
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        stubConfigAndDiscovery(sandbox, provider);
        stubCleanChatStream(sandbox, []);
        const reported: vscode.LanguageModelResponsePart[] = [];

        await runChatRequest(provider, reported, hostToken);

        assert.ok(registrations > 0, "the request must register a host listener");
        assert.strictEqual(disposeCalls, registrations, "every listener left on the host token must be released");
    });

    test("leaves the registry empty after a connector cancellation", async () => {
        const { registry } = await runConnectorCancelledRequest();

        assert.deepStrictEqual(registry.list(), []);
    });

    /**
     * Runs a request whose attempts end the way `attemptBehaviour` decides, and
     * cancels it from the connector while the provider sits in its backoff. Only a
     * cancellation that reaches that sleep can end the turn inside 500 ms.
     */
    async function runBackoffCancelledRequest(
        attemptBehaviour: () => ReadableStream<Uint8Array>
    ): Promise<{ reported: vscode.LanguageModelResponsePart[]; chatCalls: number }> {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, undefined, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: BACKOFF_MS,
            emptyResponseRetries: 3,
            emptyResponseRetryDelayMs: BACKOFF_MS,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        let chatCalls = 0;
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            chatCalls += 1;
            return attemptBehaviour();
        });

        const host = new vscode.CancellationTokenSource();
        const request = runChatRequest(provider, reported, host.token).catch(() => undefined);
        try {
            await waitFor(() => chatCalls === 1, "the first attempt was never sent");
            // The cancel has to land once the backoff is armed. Cancelling before it
            // starts would end the turn without ever exercising the sleep.
            await new Promise((resolve) => setTimeout(resolve, 50));
            const [entry] = registry.list();
            assert.ok(entry, "a request waiting to retry must still be listed");
            entry.cancel();
            await settleWithin(request, 500, "the backoff ignored the cancellation");
        } finally {
            host.cancel();
            await request;
            host.dispose();
        }

        return { reported, chatCalls };
    }

    test("ends the transport backoff at once when the connector cancels", async () => {
        const { reported } = await runBackoffCancelledRequest(() => {
            throw new TypeError("terminated");
        });

        assert.match(reportedText(reported), /cancelled from the LiteLLM connector/i);
    });

    test("sends no further request after a backoff cancel", async () => {
        const { chatCalls } = await runBackoffCancelledRequest(() => {
            throw new TypeError("terminated");
        });

        assert.strictEqual(chatCalls, 1);
    });

    test("ends the reasoning-only backoff at once when the connector cancels", async () => {
        const encoder = new TextEncoder();
        const { reported } = await runBackoffCancelledRequest(
            () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n')
                        );
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                })
        );

        assert.match(reportedText(reported), /cancelled from the LiteLLM connector/i);
    });

    test("cancels a request that is still waiting for response headers", async () => {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, undefined, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            headersTimeoutMs: 60_000,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const host = new vscode.CancellationTokenSource();
        // A request that only settles when its signal is aborted, so nothing but a
        // cancellation that reaches the client can end it.
        let fetchStarted = false;
        let fetchSignal: AbortSignal | undefined;
        sandbox.stub(global, "fetch").callsFake(
            (_input: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    fetchSignal = init?.signal ?? undefined;
                    fetchStarted = true;
                    fetchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                })
        );

        const request = runChatRequest(provider, reported, host.token).catch(() => undefined);
        try {
            await waitFor(() => fetchStarted, "the request never reached fetch");
            const [entry] = registry.list();
            assert.ok(entry, "a request that has not received headers must still be listed");
            entry.cancel();

            // Asserted directly, so a wiring that leaves the fetch with the host
            // token fails here instead of hanging until the runner gives up.
            await waitFor(() => fetchSignal?.aborted === true, "the fetch was never aborted", 500);
            await request;

            assert.match(reportedText(reported), /cancelled from the LiteLLM connector/i);
            assert.deepStrictEqual(registry.list(), []);
        } finally {
            // Settles the request if an assertion above failed before the cancel
            // reached the client.
            host.cancel();
            await request;
            host.dispose();
        }
    });

    test("reports the sending phase again when a retry starts a new header wait", async () => {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, undefined, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 2,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const encoder = new TextEncoder();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const phasesAtSend: (string | undefined)[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            phasesAtSend.push(registry.list()[0]?.phase);
            if (phasesAtSend.length === 1) {
                // A stream that dies without output, so the retry resends it.
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new TypeError("terminated"));
                    },
                });
            }
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        await runChatRequest(provider, reported);

        assert.deepStrictEqual(
            phasesAtSend,
            ["sending", "sending"],
            "the second attempt must be listed as waiting for headers, not as streaming"
        );
    });

    test("leaves the registry empty after a failed request", async () => {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, undefined, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new LiteLLMApiError(400, "bad request", "LiteLLM API error: 400 Bad Request\nbad request");
        });

        await runChatRequest(provider, reported);

        assert.deepStrictEqual(registry.list(), [], "a thrown error must not leave a phantom entry");
    });

    test("retryBudgetMs 0 leaves the attempt count as the only bound", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 1,
            networkRetryDelayMs: 1,
            retryBudgetMs: 0,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            throw new TypeError("terminated");
        });

        await runChatRequest(provider, reported);

        assert.strictEqual(sent.length, 2, "a disabled budget must not shorten the attempt count");
        const text = findErrorTextPart(reported);
        assert.ok(text, "the failure must surface as an error text part");
        assert.match(text, /terminated/, "the real failure is reported, not a budget stop");
        assert.doesNotMatch(text, /retryBudgetSeconds/);
    });

    test("reasoning-only retries exhausted after the budget surfaces the descriptive error", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 1,
            emptyResponseRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const reasoningOnlyStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"more thought"}}]}\n\n')
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return reasoningOnlyStream();
        });

        await runChatRequest(provider, reported);
        // attempt 0 + emptyResponseRetries 1 = 2 total requests, and the
        // empty budget must not spill into the transport budget
        assert.strictEqual(sent.length, 2, "reasoning-only budget must be exhausted");
        const emptyExhaustedText = findErrorTextPart(reported);
        assert.ok(emptyExhaustedText, "exhausted reasoning-only retries must surface as an error text part");
        assert.match(emptyExhaustedText, /reasoning-only response.*after 1 resume attempt/);
    });

    test("cancellation during a reasoning-only stream surfaces cancellation, not retry exhaustion", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 2,
            emptyResponseRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const tokenSource = new vscode.CancellationTokenSource();
        // The abort fires while the stream is still open, so decodeSSE ends
        // cleanly and the reasoning-only detector runs on a cancelled request.
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n')
                    );
                },
                pull(controller) {
                    tokenSource.cancel();
                    controller.close();
                },
            });
        });

        await assert.rejects(() => runChatRequest(provider, reported, tokenSource.token), /Operation cancelled/);
        assert.strictEqual(sent.length, 1, "a cancelled request must not be resumed");
    });

    test("reasoning-only retries do not consume the transport retry budget", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 2,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 2,
            emptyResponseRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const reasoningOnlyStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n')
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        const dyingStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return sent.length === 1 ? reasoningOnlyStream() : dyingStream();
        });

        // 1 reasoning-only retry from the empty budget, then the full
        // transport budget must still be available: 2 more requests after the
        // first transport death (networkRetries 2), 4 in total.
        await runChatRequest(provider, reported);
        assert.strictEqual(sent.length, 4, "empty-budget retry must not shrink the transport budget");
        const budgetErrorText = findErrorTextPart(reported);
        assert.ok(budgetErrorText, "the final transport error must surface as an error text part");
        assert.match(budgetErrorText, /terminated/);
    });

    test("inactivity timeout mid-stream triggers a resume attempt", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            // sub-second watchdog so the test does not wait 60s
            inactivityTimeout: 0.05,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const stalledStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
                    // never closes and never enqueues again: the watchdog must abort it
                },
            });
        const doneStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done."}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return sent.length === 1 ? stalledStream() : doneStream();
        });

        await runChatRequest(provider, reported);
        assert.strictEqual(sent.length, 2, "watchdog abort must trigger one resume attempt");
        const second = sent[1].messages;
        assert.strictEqual(
            second.length,
            3,
            "resume after inactivity timeout appends the partial text plus the Continue nudge"
        );
        assert.strictEqual(second[1].content, "par");
        assert.strictEqual(second[2].role, "user");
        assert.strictEqual(second[2].content, "Continue");
    });

    test("transport retry resumes across consecutive attempts without duplicating the assistant turn", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const dyingStream = (chunk: string) =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${chunk}"}}]}\n\n`));
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        const doneStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" done"}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        const chunks = ["Hel", "lo "];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            const index = sent.length - 1;
            return index < chunks.length ? dyingStream(chunks[index]) : doneStream();
        });

        await runChatRequest(provider, reported);
        assert.strictEqual(sent.length, 3, "two failed attempts then success");
        const third = sent[2].messages;
        assert.strictEqual(third.length, 3, "still exactly one appended assistant turn plus one Continue nudge");
        assert.strictEqual(third[1].content, "Hello ");
        assert.strictEqual(third[2].role, "user");
        assert.strictEqual(third[2].content, "Continue");
        // the second request appends only the first attempt's chunk, and the
        // first request is the untouched original
        assert.strictEqual(sent[0].messages.length, 1);
        assert.strictEqual(sent[1].messages.length, 3, "each resumed attempt carries exactly one nudge");
        assert.strictEqual(sent[1].messages[1].content, "Hel");
        assert.strictEqual(sent[1].messages[2].content, "Continue");
        // Resumed attempts rebuild the body, so the session id has to be
        // carried over explicitly; otherwise one request would span two
        // LiteLLM sessions.
        const sessionIds = sent.map((request) => request.metadata?.session_id);
        assert.match(String(sessionIds[0]), UUID_PATTERN);
        assert.strictEqual(new Set(sessionIds).size, 1, "every resumed attempt keeps the original session id");
    });

    test("cancellation between attempts aborts instead of sending another request", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            // The backoff sleep must still be pending when cancellation fires,
            // so the delay (200ms) strictly exceeds the cancel timer (50ms).
            networkRetryDelayMs: 200,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const tokenSource = new vscode.CancellationTokenSource();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        });

        setTimeout(() => tokenSource.cancel(), 50);

        await assert.rejects(
            () => runChatRequest(provider, reported, tokenSource.token),
            /Operation cancelled by user/
        );
        assert.strictEqual(sent.length, 1, "no new request after cancellation during backoff");
    });

    test("sends the host conversation id as metadata.session_id", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        stubConfigAndDiscovery(sandbox, provider);
        const sent: OpenAIChatCompletionRequest[] = [];
        stubCleanChatStream(sandbox, sent);

        const hostConversationId = "3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11";
        await runChatRequest(provider, [], undefined, { _conversationId: hostConversationId });

        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].metadata?.session_id, hostConversationId);
    });

    test("sends a stable fingerprint as metadata.session_id when the host sends no conversation id", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        stubConfigAndDiscovery(sandbox, provider);
        const sent: OpenAIChatCompletionRequest[] = [];
        stubCleanChatStream(sandbox, sent);

        await runChatRequest(provider, []);
        await runChatRequest(provider, []);

        assert.strictEqual(sent.length, 2);
        const firstSessionId = sent[0].metadata?.session_id;
        assert.match(String(firstSessionId), UUID_PATTERN);
        assert.strictEqual(sent[1].metadata?.session_id, firstSessionId);
    });
});
