import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { TAGGED_CALL_OPENER } from "../../adapters/streaming/textToolCallParser";
import { StructuredLogger } from "../../observability/structuredLogger";
import type { OpenAIChatCompletionRequest } from "../../types";
import { ReasoningOnlyError } from "../../utils/transportRetry";
import {
    collectResponseText,
    collectToolCalls,
    createMockChatResponseOptions,
    createMockModel,
    createMockSecrets,
    createMockUserMessage,
    noop,
    TEST_USER_AGENT,
} from "../../test/utils/testMocks";
import {
    chatFinishFrame,
    chatReasoningFrame,
    chatTextFrame,
    chatToolCallArgumentsFrame,
    chatToolCallHeaderFrame,
    SSE_DONE_FRAME,
    SteppedSseStream,
} from "../../test/utils/testStreamUtils";

const DROPPED_EVENT = "stream.tool_call_buffer_dropped";
const REQUEST_ID = "req-9";
const MODEL = createMockModel({ maxOutputTokens: 4096, capabilities: { toolCalling: true, imageInput: false } });
const IGNORE_PROGRESS: vscode.Progress<vscode.LanguageModelResponsePart> = { report: noop };

interface ProviderSeams {
    _configManager: { getConfig: () => Promise<unknown> };
    processStreamingResponse: (
        body: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        requestId: string
    ) => Promise<void>;
    sendRequestWithRetry: (body: OpenAIChatCompletionRequest) => Promise<ReadableStream<Uint8Array>>;
}

function createProvider(sandbox: sinon.SinonSandbox): { provider: LiteLLMChatProvider; seams: ProviderSeams } {
    const provider = new LiteLLMChatProvider(createMockSecrets(), TEST_USER_AGENT);
    const seams = provider as unknown as ProviderSeams;
    sandbox.stub(seams._configManager, "getConfig").resolves({
        url: "http://localhost:4000",
        inactivityTimeout: 60,
        networkRetryDelayMs: 1,
    });
    return { provider, seams };
}

/** Streams `frames`, then fails the next read the way a dropped socket does. */
function createSeveredSseStream(frames: readonly string[], failure: Error): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let nextFrameIndex = 0;
    return new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (nextFrameIndex >= frames.length) {
                    controller.error(failure);
                    return;
                }
                controller.enqueue(encoder.encode(`data: ${frames[nextFrameIndex]}\n\n`));
                nextFrameIndex += 1;
            },
        },
        { highWaterMark: 0 }
    );
}

/** Wraps one frame without its closing blank line, so decodeSSE treats the stream as truncated. */
function createUnterminatedSseStream(frame: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${frame}\n`));
            controller.close();
        },
    });
}

function droppedEventsOf(warnStub: sinon.SinonStub): Record<string, unknown>[] {
    return warnStub
        .getCalls()
        .filter((call) => call.args[0] === DROPPED_EVENT)
        .map((call) => call.args[1] as Record<string, unknown>);
}

function createPartRecorder(): {
    parts: vscode.LanguageModelResponsePart[];
    progress: vscode.Progress<vscode.LanguageModelResponsePart>;
} {
    const parts: vscode.LanguageModelResponsePart[] = [];
    return { parts, progress: { report: (part) => parts.push(part) } };
}

suite("LiteLLMChatProvider stream attempt", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("delivers a complete tool call when the stream completes without a finish frame", async () => {
        const { seams } = createProvider(sandbox);
        const recorder = createPartRecorder();
        const stream = new SteppedSseStream(
            [
                chatTextFrame("Checking"),
                chatToolCallHeaderFrame("call_open", "read_file"),
                chatToolCallArgumentsFrame('{"path":"a.ts"}'),
                SSE_DONE_FRAME,
            ],
            []
        );

        await seams.processStreamingResponse(
            stream.body,
            recorder.progress,
            new vscode.CancellationTokenSource().token,
            REQUEST_ID
        );

        assert.deepStrictEqual(collectToolCalls(recorder.parts), [{ name: "read_file", input: { path: "a.ts" } }]);
    });

    test("completes a stream whose only output is a tool call left without a finish frame", async () => {
        const { seams } = createProvider(sandbox);
        const stream = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("call_open", "read_file"),
                chatToolCallArgumentsFrame('{"path":"a.ts"}'),
                SSE_DONE_FRAME,
            ],
            []
        );

        await assert.doesNotReject(
            seams.processStreamingResponse(
                stream.body,
                IGNORE_PROGRESS,
                new vscode.CancellationTokenSource().token,
                REQUEST_ID
            )
        );
    });

    test("tags a tool call dropped at stream end with its request id", async () => {
        const { seams } = createProvider(sandbox);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const stream = new SteppedSseStream(
            [
                chatTextFrame("Writing"),
                chatToolCallHeaderFrame("call_cut", "write_file"),
                chatToolCallArgumentsFrame('{"path":"a.ts","con'),
                SSE_DONE_FRAME,
            ],
            []
        );

        await seams.processStreamingResponse(
            stream.body,
            IGNORE_PROGRESS,
            new vscode.CancellationTokenSource().token,
            REQUEST_ID
        );

        assert.deepStrictEqual(
            droppedEventsOf(warnStub).map((fields) => [fields.requestId, fields.reason]),
            [[REQUEST_ID, "invalid_json_args"]]
        );
    });

    test("rethrows a truncated stream whose buffered fragment cannot be recovered", async () => {
        const { seams } = createProvider(sandbox);
        const stream = createUnterminatedSseStream(chatToolCallArgumentsFrame('{"mode":"background"}'));

        await assert.rejects(
            seams.processStreamingResponse(
                stream,
                IGNORE_PROGRESS,
                new vscode.CancellationTokenSource().token,
                REQUEST_ID
            ),
            /Stream ended before \[DONE\] marker/
        );
    });

    test("skips tool call recovery for a cancelled stream", async () => {
        const { seams } = createProvider(sandbox);
        const recorder = createPartRecorder();
        const tokenSource = new vscode.CancellationTokenSource();
        const stream = new SteppedSseStream(
            [
                chatTextFrame("Checking"),
                chatToolCallHeaderFrame("call_open", "read_file"),
                chatToolCallArgumentsFrame('{"path":"a.ts"}'),
                SSE_DONE_FRAME,
            ],
            [3]
        );

        const processing = seams.processStreamingResponse(
            stream.body,
            recorder.progress,
            tokenSource.token,
            REQUEST_ID
        );
        await stream.reached(3);
        tokenSource.cancel();
        await processing;

        assert.deepStrictEqual(collectToolCalls(recorder.parts), []);
    });

    test("reports the streamed reasoning length when a stream carries only reasoning", async () => {
        const { seams } = createProvider(sandbox);
        // The sealing frame carries the block text only in its metadata, so the
        // count must come from the reasoning deltas.
        const sealingFrame = JSON.stringify({
            choices: [{ delta: { thinking_blocks: [{ type: "thinking", thinking: "abcdef", signature: "SIG" }] } }],
        });
        const stream = new SteppedSseStream(
            [
                chatReasoningFrame("abcd"),
                chatReasoningFrame("ef"),
                sealingFrame,
                chatFinishFrame("stop"),
                SSE_DONE_FRAME,
            ],
            []
        );

        await assert.rejects(
            seams.processStreamingResponse(
                stream.body,
                IGNORE_PROGRESS,
                new vscode.CancellationTokenSource().token,
                REQUEST_ID
            ),
            (error: unknown) => error instanceof ReasoningOnlyError && error.reasoningChars === "abcdef".length
        );
    });

    test("starts a resumed attempt without the failed attempt's pending tagged fragment", async () => {
        const { provider, seams } = createProvider(sandbox);
        const severedAttempt = createSeveredSseStream(
            [chatTextFrame(`Checking ${TAGGED_CALL_OPENER}{"name":"task",`)],
            new TypeError("terminated")
        );
        const resumedAttempt = new SteppedSseStream(
            [chatTextFrame("done"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            []
        );
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(severedAttempt)
            .onSecondCall()
            .resolves(resumedAttempt.body);
        const parts: vscode.LanguageModelResponsePart[] = [];

        await provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage("check the file")],
            createMockChatResponseOptions(),
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(collectResponseText(parts), "Checking done");
    });
});
