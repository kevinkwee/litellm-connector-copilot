import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import { createMockSecrets, TEST_USER_AGENT } from "../../test/utils/testMocks";
import { access, apiError, seedBackendForCall } from "../../test/utils/providerBaseTestUtils";
import { EffortFallbackCache } from "../../utils/reasoningEffortFallback";

suite("LiteLLMProviderBase", () => {
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

    suite("reasoning effort handling", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "reasoning-model",
            name: "reasoning-model",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        suite("applyReasoningEffort", () => {
            test("sends reasoning_effort='none' as a real value", () => {
                const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
                const request = { model: "test-model", messages: [] } as OpenAIChatCompletionRequest;

                access(provider).applyReasoningEffort(request, "none");

                const recordRequest = request as unknown as Record<string, unknown>;
                assert.strictEqual(recordRequest.reasoning_effort, "none");
            });

            test("sets reasoning_effort field for non-none values", () => {
                const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
                const request = { model: "test-model", messages: [] } as OpenAIChatCompletionRequest;

                access(provider).applyReasoningEffort(request, "high");

                const recordRequest = request as unknown as Record<string, unknown>;
                assert.strictEqual(recordRequest.reasoning_effort, "high");
            });
        });

        test("applies reasoning effort from modelConfiguration", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const request = (
                await access(provider).buildOpenAIChatRequest(
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    {
                        configuration: { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "medium" },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    undefined,
                    "test"
                )
            ).request;

            assert.strictEqual(request.reasoning_effort, "medium");
        });

        test("applies picker xhigh when fallback cache is empty", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const modelInfo: LiteLLMModelInfo = {
                mode: "chat",
                supports_reasoning: true,
                supports_reasoning_effort: true,
            };
            const request = (
                await access(provider).buildOpenAIChatRequest(
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    {
                        configuration: { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "xhigh" },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    modelInfo,
                    "test"
                )
            ).request;

            assert.strictEqual(request.reasoning_effort, "xhigh");
        });

        test("omits reasoning_effort when user has not picked one", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const request = (
                await access(provider).buildOpenAIChatRequest(
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    {
                        configuration: { baseUrl: "https://wolfram.example", apiKey: "k" },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    undefined,
                    "test"
                )
            ).request;
            assert.strictEqual(request.reasoning_effort, undefined);
        });

        test("sends picker 'none' as reasoning_effort value", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const request = (
                await access(provider).buildOpenAIChatRequest(
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    {
                        configuration: { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "none" },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    undefined,
                    "test"
                )
            ).request;
            assert.strictEqual(request.reasoning_effort, "none");
        });
    });

    suite("sendRequestWithRetry: reasoning fallback", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "model-reasoning",
            name: "model-reasoning",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        function setupProvider(): LiteLLMChatProvider {
            return new LiteLLMChatProvider(mockSecrets, userAgent, new EffortFallbackCache());
        }

        test("retries once on reasoning 4xx and succeeds", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            const stream = await access(provider).sendRequestWithRetry(
                { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(stream);
            assert.ok(sendStub.calledTwice);
        });

        test("a context overflow surfaces the proxy error once, with no silent retry", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const overflow = apiError("LiteLLM API error 400: maximum context length exceeded", 400);
            const sendStub = sandbox.stub(access(provider)._transport, "sendRequestToLiteLLM").rejects(overflow);

            await assert.rejects(
                () =>
                    access(provider).sendRequestWithRetry(
                        { model: "overflow-model", messages: [], stream: true, max_tokens: 5 },
                        model,
                        { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                        new vscode.CancellationTokenSource().token,
                        "test"
                    ),
                (err: unknown) => err === overflow
            );
            sinon.assert.calledOnce(sendStub);
        });

        test("notifies once per model and original effort", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const showInfo = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);

            sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            await access(provider).sendRequestWithRetry(
                // The learned-limit key is the namespaced model id, so this test
                // uses its own model object to avoid sharing the notification key
                // with the "retries once on reasoning 4xx" test.
                { model: "notify-once-model", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                { ...model, id: "notify-once-model" },
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(showInfo.called);
        });

        test("does not retry on non-reasoning 5xx errors", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .rejects(new Error("Internal server error 500"));

            await assert.rejects(() =>
                access(provider).sendRequestWithRetry(
                    { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                    model,
                    { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "test"
                )
            );

            assert.ok(sendStub.calledOnce, "should not retry on non-reasoning 5xx");
        });

        test("does not retry on 4xx errors that are unrelated to reasoning", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .rejects(apiError("LiteLLM API error 401: invalid api key", 401));

            await assert.rejects(() =>
                access(provider).sendRequestWithRetry(
                    { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                    model,
                    { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "test"
                )
            );

            assert.ok(sendStub.calledOnce);
        });

        test("reaches the omitted-parameter step when the model rejects every effort", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });

            const attemptedEfforts: unknown[] = [];
            const sendStub = sandbox.stub(access(provider)._transport, "sendRequestToLiteLLM").callsFake((request) => {
                attemptedEfforts.push(request.reasoning_effort);
                // A model that does not accept the parameter at all: every
                // effort value is rejected, and only its absence works.
                if (request.reasoning_effort !== undefined) {
                    return Promise.reject(apiError("LiteLLM API error 400: reasoning_effort not supported", 400));
                }
                return Promise.resolve(new ReadableStream());
            });

            const stream = await access(provider).sendRequestWithRetry(
                { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(stream);
            assert.strictEqual(attemptedEfforts.at(-1), undefined);
            // high, medium, low, minimal, none, omitted.
            assert.strictEqual(sendStub.callCount, 6);
        });

        test("attempts no more than the ladder plus the omitted step", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400));

            await assert.rejects(() =>
                access(provider).sendRequestWithRetry(
                    { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "max" },
                    model,
                    { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "test"
                )
            );

            // max, xhigh, high, medium, low, minimal, none, omitted.
            assert.strictEqual(sendStub.callCount, 8);
        });

        test("retries once without stream_options include_usage on unknown parameter rejection", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: stream_options.include_usage is not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            await access(provider).sendRequestWithRetry(
                {
                    model: "model-reasoning",
                    messages: [],
                    stream: true,
                    max_tokens: 100,
                    stream_options: { include_usage: true },
                },
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(sendStub.calledTwice);
        });

        test("applies cached lower effort when prior failure recorded", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            // Pre-seed fallback cache: prior "high" failure → next "low"
            access(provider)._effortFallbackCache.recordFailure("model-reasoning", "high");

            const capturedRequests: OpenAIChatCompletionRequest[] = [];
            sandbox.stub(access(provider)._transport, "sendRequestToLiteLLM").callsFake(async (req) => {
                capturedRequests.push(req);
                return new ReadableStream();
            });

            await access(provider).sendRequestWithRetry(
                { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(capturedRequests[0].reasoning_effort !== "high", "should have downgraded before first send");
        });
    });

    suite("constructor", () => {
        test("constructing a provider creates its registry and transport", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

            assert.ok(access(provider)._registry);
            assert.ok(access(provider)._transport);
        });

        test("dispose stops forwarding registry changes to VS Code", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const fired: number[] = [];
            provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));
            const registryEmitter = access(provider)._registry as unknown as {
                _onDidChangeEmitter: vscode.EventEmitter<void>;
            };

            provider.dispose();
            registryEmitter._onDidChangeEmitter.fire();

            assert.deepStrictEqual(fired, [], "a disposed provider must not answer after deactivation");
        });

        test("dispose is safe to call twice", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

            provider.dispose();

            assert.doesNotThrow(() => provider.dispose());
        });
    });

    suite("provideTokenCount", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "gpt-4",
            name: "gpt-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        test("returns the local estimate for small strings", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const tokenSource = new vscode.CancellationTokenSource();
            const count = await provider.provideTokenCount(model, "hi", tokenSource.token, {
                baseUrl: "https://wolfram.example",
                apiKey: "k",
            });
            assert.strictEqual(count, 2);
        });

        test("returns the same local estimate when cancellation is already requested", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const tokenSource = new vscode.CancellationTokenSource();
            tokenSource.cancel();
            const count = await provider.provideTokenCount(model, "hi", tokenSource.token, {
                baseUrl: "https://wolfram.example",
                apiKey: "k",
            });
            assert.strictEqual(count, 2);
        });

        test("estimates a large string from its character count", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const tokenSource = new vscode.CancellationTokenSource();

            const count = await provider.provideTokenCount(model, "x".repeat(1000), tokenSource.token, {
                baseUrl: "https://wolfram.example",
                apiKey: "k",
            });
            assert.strictEqual(count, 286);
        });
    });

    suite("getCallTimeConfiguration: per-group config at response time", () => {
        test("prefers options.configuration when present", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const optionsConfig = { baseUrl: "https://from-options", apiKey: "k-options" };
            const modelConfig = { baseUrl: "https://from-model", apiKey: "k-model" };
            sandbox
                .stub(access(provider)._configManager, "getConfig")
                .resolves({ allowChatCompletionsFallback: false, headersTimeoutMs: 45_000 });
            const result = await access(provider).getCallTimeConfiguration(
                { configuration: optionsConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                    configuration: modelConfig,
                } as unknown as vscode.LanguageModelChatInformation
            );
            assert.ok(result);
            assert.strictEqual(result!.baseUrl, optionsConfig.baseUrl);
            assert.strictEqual(result!.apiKey, optionsConfig.apiKey);
            // merged config toggles should also be present
            assert.strictEqual(result!.allowChatCompletionsFallback, false);
            assert.strictEqual(result!.headersTimeoutMs, 45_000);
        });

        test("falls back to the BackendRegistry when options.configuration is missing", async () => {
            // VS Code 1.120 does NOT carry the per-group config on
            // `ProvideLanguageModelChatResponseOptions`. The response path
            // falls back to the in-memory `LiteLLMProviderRegistry` keyed
            // by the namespaced model id. The model object on the wire no
            // longer needs to carry `configuration` because the registry
            // is the single source of truth.
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const registryEntry = { baseUrl: "https://from-registry", apiKey: "k-registry" };
            sandbox
                .stub(access(provider)._configManager, "getConfig")
                .resolves({ allowChatCompletionsFallback: false, headersTimeoutMs: 30_000 });
            sandbox.stub(access(provider)._registry, "lookup").withArgs("m").returns({
                baseUrl: registryEntry.baseUrl,
                apiKey: registryEntry.apiKey,
                rawModelName: "m",
                routingIdentity: "",
            });
            const result = await access(provider).getCallTimeConfiguration(
                {} as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                } as unknown as vscode.LanguageModelChatInformation
            );
            assert.ok(result);
            assert.deepStrictEqual(result!.baseUrl, registryEntry.baseUrl);
            assert.strictEqual(result!.apiKey, registryEntry.apiKey);
            // merged config toggles should also be present
            assert.strictEqual(result!.allowChatCompletionsFallback, false);
            assert.strictEqual(result!.headersTimeoutMs, 30_000);
        });

        test("returns undefined when neither options nor model carry configuration", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = await access(provider).getCallTimeConfiguration(
                {} as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                } as unknown as vscode.LanguageModelChatInformation
            );
            assert.strictEqual(result, undefined);
        });

        test("a learned cache rejection turns the directive off for that model", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const internals = access(provider);
            sandbox.stub(internals._configManager, "getConfig").resolves({ disableCaching: true });
            internals._registry.recordUnsupportedParameter("host.example/m", "cache");
            const configuration = { baseUrl: "https://host.example", apiKey: "k" };

            const result = await internals.getCallTimeConfiguration(
                { configuration } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "host.example/m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                } as unknown as vscode.LanguageModelChatInformation
            );

            assert.ok(result);
            assert.strictEqual(
                result!.disableCaching,
                false,
                "a key that already refused the directive must not pay for it on every request"
            );
        });
    });

    suite("stripUnsupportedParametersFromRequest", () => {
        test("removes known unsupported params", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5, top_p: 1, model: "claude-3-5-sonnet" };
            access(provider).stripUnsupportedParametersFromRequest(
                body,
                { supports_function_calling: true } as LiteLLMModelInfo,
                "claude-3-5-sonnet"
            );
            assert.strictEqual(body.temperature, undefined);
        });

        test("handles o1 models", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5, top_p: 1, model: "o1-mini" };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "o1-mini");
            assert.strictEqual(body.temperature, undefined);
            assert.strictEqual(body.top_p, undefined);
        });

        test("handles gpt-5-mini models", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5, top_p: 1, frequency_penalty: 0 };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "gpt-5-mini");
            assert.strictEqual(body.temperature, undefined);
        });

        test("leaves extra_body and a top-level cache key untouched", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const cache = { "no-cache": true, other: "x" };
            const extraBody = { cache };
            const body: Record<string, unknown> = { extra_body: extraBody, cache };

            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "m");

            // The client adds the cache directive after the body is built, so
            // stripping must not reach `extra_body` or `cache`.
            assert.strictEqual(body.extra_body, extraBody);
            assert.strictEqual((body.extra_body as { cache: unknown }).cache, cache);
            assert.strictEqual(body.cache, cache);
            // An in-place scrub would keep the identities above, so pin the contents too.
            assert.deepStrictEqual(cache, { "no-cache": true, other: "x" });
        });

        test("preserves supported fields when model has no limitations", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5 };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "any-model");
            assert.strictEqual(body.temperature, 0.5);
        });

        test("removes tool_choice when not in supported_openai_params", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { tools: [], tool_choice: "auto", model: "gpt-5.6" };
            const modelInfo: LiteLLMModelInfo = { model: "gpt-5.6", supported_openai_params: ["tools"] };
            access(provider).stripUnsupportedParametersFromRequest(body, modelInfo, "gpt-5.6");
            assert.strictEqual(body.tool_choice, undefined);
        });

        test("preserves tool_choice when model supports it", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { tools: [], tool_choice: "auto", model: "gpt-4" };
            const modelInfo: LiteLLMModelInfo = { model: "gpt-4", supported_openai_params: ["tools", "tool_choice"] };
            access(provider).stripUnsupportedParametersFromRequest(body, modelInfo, "gpt-4");
            assert.strictEqual(body.tool_choice, "auto");
        });
    });

    suite("isParameterSupported", () => {
        test("returns false when modelId matches known model limitations substring", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.strictEqual(
                access(provider).isParameterSupported("temperature", undefined, "claude-3-5-sonnet-2024"),
                false
            );
        });

        test("returns true when parameter is explicitly supported and not blocked", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.strictEqual(
                access(provider).isParameterSupported(
                    "temperature",
                    { supported_openai_params: ["temperature"] } as LiteLLMModelInfo,
                    "m"
                ),
                true
            );
        });
    });

    suite("buildCapabilities", () => {
        test("buildCapabilities maps model_info flags correctly", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const caps = access(provider).buildCapabilities({
                supports_function_calling: true,
                supports_vision: true,
            } as LiteLLMModelInfo);
            assert.strictEqual(caps.toolCalling, true);
            assert.strictEqual(caps.imageInput, true);
        });

        test("buildCapabilities defaults to { toolCalling: true, imageInput: false } when no model_info", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const caps = access(provider).buildCapabilities(undefined);
            assert.strictEqual(caps.toolCalling, true);
            assert.strictEqual(caps.imageInput, false);
        });
    });
});
