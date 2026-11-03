import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient, LiteLLMRateLimitError } from "../../adapters/litellmClient";
import { StructuredLogger } from "../../observability/structuredLogger";
import { createMockSecrets, TEST_USER_AGENT } from "../../test/utils/testMocks";
import { findErrorTextPart, seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";

suite("LiteLLM Chat Provider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    const mockSecrets = createMockSecrets({
        "litellm-connector.baseUrl": "http://localhost:4000",
        "litellm-connector.apiKey": "test-api-key",
    });

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("reports a request that has no base URL as an error", async () => {
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
});
