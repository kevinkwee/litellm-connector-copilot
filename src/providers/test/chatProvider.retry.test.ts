import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../types";
import { StructuredLogger } from "../../observability/structuredLogger";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import {
    findErrorTextPart,
    runChatRequest,
    seedDiscoveredBackend,
    UUID_PATTERN,
} from "../../test/utils/chatProviderTestUtils";

suite("LiteLLM Chat Provider Retry", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
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
        const provider = new LiteLLMChatProvider(userAgent);

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
        const provider = new LiteLLMChatProvider(userAgent);

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
        const provider = new LiteLLMChatProvider(userAgent);

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

    test("tool call already emitted before a transport error blocks the retry", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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

    test("retryBudgetMs 0 leaves the attempt count as the only bound", async () => {
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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

    test("reasoning-only retries do not consume the transport retry budget", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
        const provider = new LiteLLMChatProvider(userAgent);
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
});
