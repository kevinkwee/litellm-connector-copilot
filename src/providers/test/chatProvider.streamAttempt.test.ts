import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import * as responseStreamModule from "../chat/responseStream";
import { StructuredLogger } from "../../observability/structuredLogger";
import type { OpenAIChatCompletionRequest } from "../../types";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { findErrorTextPart, seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";
import { Logger } from "../../utils/logger";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { CopilotMdManager } from "../../observability/copilotMdManager";
import {
    collectResponseText,
    collectToolCalls,
    createMockChatResponseOptions,
    createMockModel,
    createMockUserMessage,
    TEST_USER_AGENT,
} from "../../test/utils/testMocks";
import {
    chatFinishFrame,
    chatReasoningFrame,
    chatTextFrame,
    chatToolCallArgumentsFrame,
    chatToolCallHeaderFrame,
    createMockSSEStream,
    SSE_DONE_FRAME,
    SteppedSseStream,
    createPartRecorder,
    createSeveredSseStream,
} from "../../test/utils/testStreamUtils";

const MODEL = createMockModel({ maxOutputTokens: 4096, capabilities: { toolCalling: true, imageInput: false } });

interface ProviderSeams {
    _configManager: { getConfig: () => Promise<unknown> };
    sendRequestWithRetry: (body: OpenAIChatCompletionRequest) => Promise<ReadableStream<Uint8Array>>;
}

function createProvider(sandbox: sinon.SinonSandbox): { provider: LiteLLMChatProvider; seams: ProviderSeams } {
    const provider = new LiteLLMChatProvider(TEST_USER_AGENT);
    const seams = provider as unknown as ProviderSeams;
    sandbox.stub(seams._configManager, "getConfig").resolves({
        url: "http://localhost:4000",
        inactivityTimeout: 60,
        networkRetryDelayMs: 1,
        emptyResponseRetryDelayMs: 1,
    });
    return { provider, seams };
}

suite("LiteLLMChatProvider stream attempt", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("emits the declared tool name when the advertised name had to change", async () => {
        const { provider, seams } = createProvider(sandbox);
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .resolves(
                new SteppedSseStream(
                    [
                        chatToolCallHeaderFrame("call_renamed", "search_files"),
                        chatToolCallArgumentsFrame('{"q":"x"}'),
                        SSE_DONE_FRAME,
                    ],
                    []
                ).body
            );
        const recorder = createPartRecorder();
        const options = {
            ...createMockChatResponseOptions(),
            tools: [{ name: "search files", description: "", inputSchema: {} }],
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("find it")],
            options,
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(collectToolCalls(recorder.parts), [{ name: "search files", input: { q: "x" } }]);
    });

    test("starts a resumed attempt without the failed attempt's open tool call", async () => {
        const { provider, seams } = createProvider(sandbox);
        const severedAttempt = createSeveredSseStream(
            [chatToolCallHeaderFrame("toolu_cut", "task"), chatToolCallArgumentsFrame('{"description":"half')],
            new TypeError("terminated")
        );
        const resumedAttempt = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("toolu_full", "view"),
                chatToolCallArgumentsFrame('{"path":"README.md"}'),
                chatFinishFrame("tool_calls"),
                SSE_DONE_FRAME,
            ],
            []
        );
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(severedAttempt)
            .onSecondCall()
            .resolves(resumedAttempt.body);
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("check the file")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(collectToolCalls(recorder.parts), [{ name: "view", input: { path: "README.md" } }]);
    });

    test("logs a failure that is surfaced as chat text", async () => {
        const { provider, seams } = createProvider(sandbox);
        sandbox.stub(seams, "sendRequestWithRetry").rejects(new Error("LiteLLM API error: 500 upstream exploded"));
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const recorder = createPartRecorder();
        const options = {
            ...createMockChatResponseOptions(),
            requestInitiator: "background-summarizer",
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("summarize")],
            options,
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        const surfaced = warnStub
            .getCalls()
            .filter((call) => call.args[0] === "request.error_surfaced_as_text")
            .map((call) => call.args[1] as Record<string, unknown>);
        assert.strictEqual(surfaced.length, 1);
        assert.strictEqual(surfaced[0].caller, "background-summarizer");
        assert.strictEqual(surfaced[0].status, 500);
        assert.strictEqual(surfaced[0].errorMessage, undefined, "upstream error text must not reach the log");
        // The turn still completes as an assistant message.
        assert.ok(collectResponseText(recorder.parts).includes("[litellm-connector]"));
    });

    test("reports a cancelled request as cancelled instead of failed", async () => {
        const { provider, seams } = createProvider(sandbox);
        sandbox.stub(seams, "sendRequestWithRetry").rejects(new Error("LiteLLM API error: 500 upstream exploded"));
        const errorStub = sandbox.stub(Logger, "error");
        const structuredErrorStub = sandbox.stub(StructuredLogger, "error");
        const infoStub = sandbox.stub(StructuredLogger, "info");
        const reportMetric = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel();

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    MODEL,
                    [createMockUserMessage("hi")],
                    createMockChatResponseOptions(),
                    createPartRecorder().progress,
                    tokenSource.token
                ),
            (err: Error) => err.name === "CancellationError"
        );

        const statuses = reportMetric.getCalls().map((call) => call.args[0].status);
        assert.deepStrictEqual(statuses, ["cancelled"]);
        assert.strictEqual(errorStub.called, false);

        const cancelledEvents = infoStub.getCalls().filter((call) => call.args[0] === "request.cancelled");
        assert.strictEqual(cancelledEvents.length, 1);
        assert.strictEqual(structuredErrorStub.called, false);
    });

    test("reports a stream that was cancelled after it ended cleanly as cancelled", async () => {
        const { provider, seams } = createProvider(sandbox);
        sandbox.stub(seams, "sendRequestWithRetry").resolves(createMockSSEStream(["answer"]));
        const exportEntry = sandbox.stub(CopilotMdManager.instance, "exportEntry").resolves(undefined);
        const reportMetric = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const tokenSource = new vscode.CancellationTokenSource();
        // The token is cancelled once the stream body has been consumed, which is
        // the window where a clean stream end would otherwise read as a success.
        sandbox.stub(responseStreamModule, "processResponseStream").callsFake(async () => {
            tokenSource.cancel();
        });

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    MODEL,
                    [createMockUserMessage("hi")],
                    createMockChatResponseOptions(),
                    createPartRecorder().progress,
                    tokenSource.token
                ),
            (err: Error) => err.name === "CancellationError"
        );

        const statuses = reportMetric.getCalls().map((call) => call.args[0].status);
        assert.deepStrictEqual(statuses, ["cancelled"], "a cancelled stream is never reported as a success");
        sinon.assert.calledOnce(exportEntry);
        assert.strictEqual(exportEntry.firstCall.args[0].status, "canceled");
    });

    test("completes a request whose resumed attempt ends with a stop finish", async () => {
        const { provider, seams } = createProvider(sandbox);
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(createSeveredSseStream([chatTextFrame("answer")], new TypeError("terminated")))
            .onSecondCall()
            .resolves(new SteppedSseStream([chatFinishFrame("stop"), SSE_DONE_FRAME], []).body);
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("hi")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sendStub.callCount, 2, "the dropped attempt must resume once");
        assert.strictEqual(collectResponseText(recorder.parts), "answer");
        assert.ok(!collectResponseText(recorder.parts).includes("[litellm-connector]"), "no failure notice is due");
    });

    test("keeps retrying a resumed attempt that closes without a finish frame", async () => {
        const { provider, seams } = createProvider(sandbox);
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(createSeveredSseStream([chatTextFrame("answer")], new TypeError("terminated")))
            .onSecondCall()
            .resolves(new SteppedSseStream([chatTextFrame("")], []).body)
            .onThirdCall()
            .resolves(new SteppedSseStream([chatTextFrame("!"), chatFinishFrame("stop"), SSE_DONE_FRAME], []).body);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("hi")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        const reasoningRetries = warnStub.getCalls().filter((call) => call.args[0] === "request.reasoning_only_retry");
        assert.strictEqual(reasoningRetries.length, 1, "a clean close is not proof of a completed answer");
        assert.strictEqual(sendStub.callCount, 3);
        assert.strictEqual(collectResponseText(recorder.parts), "answer!");
    });

    test("keeps retrying a resumed attempt that ends on a cut-short finish", async () => {
        const { provider, seams } = createProvider(sandbox);
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(createSeveredSseStream([chatTextFrame("answer")], new TypeError("terminated")))
            .onSecondCall()
            .resolves(new SteppedSseStream([chatFinishFrame("length"), SSE_DONE_FRAME], []).body)
            .onThirdCall()
            .resolves(new SteppedSseStream([chatTextFrame("!"), chatFinishFrame("stop"), SSE_DONE_FRAME], []).body);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("hi")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        const reasoningRetries = warnStub.getCalls().filter((call) => call.args[0] === "request.reasoning_only_retry");
        assert.strictEqual(reasoningRetries.length, 1, "a truncated answer is not a completed answer");
        assert.strictEqual(collectResponseText(recorder.parts), "answer!");
    });

    test("keeps retrying a resumed attempt that reasons and then stops", async () => {
        const { provider, seams } = createProvider(sandbox);
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(createSeveredSseStream([chatTextFrame("answer")], new TypeError("terminated")))
            .onSecondCall()
            .resolves(
                new SteppedSseStream([chatReasoningFrame("more thinking"), chatFinishFrame("stop"), SSE_DONE_FRAME], [])
                    .body
            )
            .onThirdCall()
            .resolves(new SteppedSseStream([chatTextFrame("!"), chatFinishFrame("stop"), SSE_DONE_FRAME], []).body);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("hi")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        const reasoningRetries = warnStub.getCalls().filter((call) => call.args[0] === "request.reasoning_only_retry");
        assert.strictEqual(reasoningRetries.length, 1, "an attempt that kept reasoning has not finished the answer");
        assert.strictEqual(collectResponseText(recorder.parts), "answer!");
    });

    test("keeps retrying a resumed attempt when no text arrived before it", async () => {
        // A first attempt that only reasoned never delivered an answer, so a bare
        // stop finish on the resume cannot complete the turn.
        const { provider, seams } = createProvider(sandbox);
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(createSeveredSseStream([chatReasoningFrame("thinking")], new TypeError("terminated")))
            .onSecondCall()
            .resolves(new SteppedSseStream([chatFinishFrame("stop"), SSE_DONE_FRAME], []).body)
            .onThirdCall()
            .resolves(
                new SteppedSseStream([chatTextFrame("answer"), chatFinishFrame("stop"), SSE_DONE_FRAME], []).body
            );
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("hi")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        const reasoningRetries = warnStub.getCalls().filter((call) => call.args[0] === "request.reasoning_only_retry");
        assert.strictEqual(reasoningRetries.length, 1, "completion needs text from the earlier attempt");
        assert.strictEqual(collectResponseText(recorder.parts), "answer");
    });

    test("completes a resumed /responses attempt that ends with a completed response", async () => {
        const { provider, seams } = createProvider(sandbox);
        const completed = JSON.stringify({ type: "response.completed", response: {} });
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(createSeveredSseStream([chatTextFrame("answer")], new TypeError("terminated")))
            .onSecondCall()
            .resolves(new SteppedSseStream([completed, SSE_DONE_FRAME], []).body);
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("hi")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sendStub.callCount, 2, "a completed response needs no further attempt");
        assert.strictEqual(collectResponseText(recorder.parts), "answer");
        assert.ok(!collectResponseText(recorder.parts).includes("[litellm-connector]"), "no failure notice is due");
    });

    test("resumes after a transient upstream error frame instead of failing the turn", async () => {
        const { provider, seams } = createProvider(sandbox);
        const overloadedFrame = JSON.stringify({
            error: { message: "Overloaded", type: "overloaded_error", code: 529 },
        });
        const failedAttempt = new SteppedSseStream([chatTextFrame("Partial "), overloadedFrame], []);
        const resumedAttempt = new SteppedSseStream(
            [chatTextFrame("and done"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            []
        );
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(failedAttempt.body)
            .onSecondCall()
            .resolves(resumedAttempt.body);
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("write the answer")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sendStub.callCount, 2);
        assert.strictEqual(collectResponseText(recorder.parts), "Partial and done");
    });

    test("surfaces a rejected request from an error frame without retrying", async () => {
        const { provider, seams } = createProvider(sandbox);
        const rejectedFrame = JSON.stringify({
            error: {
                message: "Unsupported parameter: temperature",
                type: "invalid_request_error",
                code: 400,
            },
        });
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .resolves(new SteppedSseStream([rejectedFrame], []).body);
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("write the answer")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sendStub.callCount, 1);
        const text = collectResponseText(recorder.parts);
        assert.match(text, /Upstream stream error/);
        assert.match(text, /Unsupported parameter: temperature/);
    });

    test("does not retry an error frame after a tool call was already delivered", async () => {
        const { provider, seams } = createProvider(sandbox);
        const overloadedFrame = JSON.stringify({
            error: { message: "Overloaded", type: "overloaded_error", code: 529 },
        });
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .resolves(
                new SteppedSseStream(
                    [
                        chatToolCallHeaderFrame("toolu_done", "view"),
                        chatToolCallArgumentsFrame('{"path":"README.md"}'),
                        chatFinishFrame("tool_calls"),
                        overloadedFrame,
                    ],
                    []
                ).body
            );
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("read it")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sendStub.callCount, 1, "resending could execute the tool twice");
        assert.deepStrictEqual(collectToolCalls(recorder.parts), [{ name: "view", input: { path: "README.md" } }]);
    });

    test("resumes an error frame that follows reasoning-only output instead of treating it as empty", async () => {
        const { provider, seams } = createProvider(sandbox);
        const overloadedFrame = JSON.stringify({
            error: { message: "Overloaded", type: "overloaded_error", code: 529 },
        });
        const failedAttempt = new SteppedSseStream([chatReasoningFrame("thinking"), overloadedFrame], []);
        const resumedAttempt = new SteppedSseStream(
            [chatTextFrame("answer"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            []
        );
        const sendStub = sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(failedAttempt.body)
            .onSecondCall()
            .resolves(resumedAttempt.body);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const recorder = createPartRecorder();

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("think it through")],
            createMockChatResponseOptions(),
            recorder.progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(sendStub.callCount, 2, "the upstream failure must resume the request");
        const reasoningOnlyRetries = warnStub
            .getCalls()
            .filter((call) => call.args[0] === "request.reasoning_only_retry");
        assert.deepStrictEqual(reasoningOnlyRetries, [], "an upstream error is not an empty response");
        assert.strictEqual(collectResponseText(recorder.parts), "answer");
    });

    test("reports a truncated stream as an error instead of a blank reply", async () => {
        const provider = new LiteLLMChatProvider(userAgent);

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

    test("delivers a complete buffered tool call when the stream closes without [DONE]", async () => {
        const provider = new LiteLLMChatProvider(userAgent);

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

        // A stream that closes after a complete tool call, without the [DONE] marker.
        const { ReadableStream } = await import("node:stream/web");
        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"my_tool","arguments":"{}"}}]}}]}\n'
                        )
                    );

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

        // The buffered call was complete, so the clean close settles it and reports it
        // instead of failing the turn for the missing marker.
        const toolCallParts = reported.filter(
            (part): part is vscode.LanguageModelToolCallPart =>
                part instanceof vscode.LanguageModelToolCallPart ||
                typeof (part as unknown as Record<string, unknown>)?.name === "string"
        );
        assert.deepStrictEqual(
            toolCallParts.map((part) => part.name),
            ["my_tool"],
            "the buffered call reaches VS Code instead of ending the turn"
        );
    });
});
