import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient } from "../../adapters/litellmClient";
import { CopilotMdManager } from "../../observability";
import type { OpenAIChatCompletionRequest } from "../../types";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { createMockSSEStream } from "../../test/utils/testStreamUtils";
import { seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";

suite("LiteLLM Chat Provider Usage", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("provideLanguageModelChatResponse emits usage data part via StreamTokenCapture after streaming", async () => {
        const provider = new LiteLLMChatProvider(userAgent);

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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
});
