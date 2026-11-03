import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { processResponseStream } from "../responseStream";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { Logger } from "../../../utils/logger";
import { ReasoningOnlyError, UpstreamStreamError } from "../../../utils/transportRetry";
import { collectResponseText, collectToolCalls, noop } from "../../../test/utils/testMocks";
import {
    chatFinishFrame,
    chatReasoningFrame,
    chatTextFrame,
    chatToolCallArgumentsFrame,
    chatToolCallHeaderFrame,
    SSE_DONE_FRAME,
    SteppedSseStream,
    createPartRecorder,
    createSeveredSseStream,
} from "../../../test/utils/testStreamUtils";

const DROPPED_EVENT = "stream.tool_call_buffer_dropped";
const REQUEST_ID = "req-9";
/** Inactivity bound the provider would pass from config; these tests read the stream directly. */
const STREAM_INACTIVITY_MS = 60_000;
const IGNORE_PROGRESS: vscode.Progress<vscode.LanguageModelResponsePart> = { report: noop };

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

suite("processResponseStream", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("delivers a complete tool call when the stream completes without a finish frame", async () => {
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

        await processResponseStream({
            responseBody: stream.body,
            progress: recorder.progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.deepStrictEqual(collectToolCalls(recorder.parts), [{ name: "read_file", input: { path: "a.ts" } }]);
    });

    test("completes a stream whose only output is a tool call left without a finish frame", async () => {
        const stream = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("call_open", "read_file"),
                chatToolCallArgumentsFrame('{"path":"a.ts"}'),
                SSE_DONE_FRAME,
            ],
            []
        );

        await assert.doesNotReject(
            processResponseStream({
                responseBody: stream.body,
                progress: IGNORE_PROGRESS,
                token: new vscode.CancellationTokenSource().token,
                requestId: REQUEST_ID,
                inactivityTimeoutMs: STREAM_INACTIVITY_MS,
            })
        );
    });

    test("tags a tool call dropped at stream end with its request id", async () => {
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

        await processResponseStream({
            responseBody: stream.body,
            progress: IGNORE_PROGRESS,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.deepStrictEqual(
            droppedEventsOf(warnStub).map((fields) => [fields.requestId, fields.reason]),
            [[REQUEST_ID, "invalid_json_args"]]
        );
    });

    test("rethrows a truncated stream whose buffered fragment cannot be recovered", async () => {
        const stream = createUnterminatedSseStream(chatToolCallArgumentsFrame('{"mode":"background"}'));

        await assert.rejects(
            processResponseStream({
                responseBody: stream,
                progress: IGNORE_PROGRESS,
                token: new vscode.CancellationTokenSource().token,
                requestId: REQUEST_ID,
                inactivityTimeoutMs: STREAM_INACTIVITY_MS,
            }),
            /Stream ended before \[DONE\] marker/
        );
    });

    test("skips tool call recovery for a cancelled stream", async () => {
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

        const processing = processResponseStream({
            responseBody: stream.body,
            progress: recorder.progress,
            token: tokenSource.token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });
        await stream.reached(3);
        tokenSource.cancel();
        await processing;

        assert.deepStrictEqual(collectToolCalls(recorder.parts), []);
    });

    test("reports the streamed reasoning length when a stream carries only reasoning", async () => {
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
            processResponseStream({
                responseBody: stream.body,
                progress: IGNORE_PROGRESS,
                token: new vscode.CancellationTokenSource().token,
                requestId: REQUEST_ID,
                inactivityTimeoutMs: STREAM_INACTIVITY_MS,
            }),
            (error: unknown) => error instanceof ReasoningOnlyError && error.reasoningChars === "abcdef".length
        );
    });

    test("logs a failed attempt at warn", async () => {
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const loggerErrorStub = sandbox.stub(Logger, "error");
        const stream = createSeveredSseStream([chatTextFrame("partial")], new TypeError("terminated"));

        await assert.rejects(() =>
            processResponseStream({
                responseBody: stream,
                progress: IGNORE_PROGRESS,
                token: new vscode.CancellationTokenSource().token,
                requestId: REQUEST_ID,
                inactivityTimeoutMs: STREAM_INACTIVITY_MS,
            })
        );

        const attempts = warnStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.attempt_failed")
            .map((call) => call.args[1] as Record<string, unknown>);
        assert.strictEqual(attempts.length, 1);
        assert.strictEqual(attempts[0].requestId, REQUEST_ID);
        assert.strictEqual(errorStub.called, false);
        assert.strictEqual(loggerErrorStub.called, false);
    });

    test("reports a cut-short reasoning-only attempt without a normal finish", async () => {
        const stream = new SteppedSseStream(
            [chatReasoningFrame("thinking"), chatFinishFrame("length"), SSE_DONE_FRAME],
            []
        );

        await assert.rejects(
            () =>
                processResponseStream({
                    responseBody: stream.body,
                    progress: IGNORE_PROGRESS,
                    token: new vscode.CancellationTokenSource().token,
                    requestId: REQUEST_ID,
                    inactivityTimeoutMs: STREAM_INACTIVITY_MS,
                }),
            (err: unknown) => err instanceof ReasoningOnlyError && !err.normalFinish
        );
    });

    test("reports a normally finished reasoning-only attempt as a normal finish", async () => {
        const stream = new SteppedSseStream(
            [chatReasoningFrame("thinking"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            []
        );

        await assert.rejects(
            () =>
                processResponseStream({
                    responseBody: stream.body,
                    progress: IGNORE_PROGRESS,
                    token: new vscode.CancellationTokenSource().token,
                    requestId: REQUEST_ID,
                    inactivityTimeoutMs: STREAM_INACTIVITY_MS,
                }),
            (err: unknown) => err instanceof ReasoningOnlyError && err.normalFinish
        );
    });

    test("tells the user when the model stops at its output token limit", async () => {
        const recorder = createPartRecorder();
        const stream = new SteppedSseStream(
            [chatTextFrame("Half an answer"), chatFinishFrame("length"), SSE_DONE_FRAME],
            []
        );

        await processResponseStream({
            responseBody: stream.body,
            progress: recorder.progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        const text = collectResponseText(recorder.parts);
        assert.ok(text.startsWith("Half an answer"), `unexpected text: ${text}`);
        assert.match(text, /output token limit/);
        const notice = recorder.parts.find(
            (part) => part instanceof vscode.LanguageModelTextPart && part.value.includes("output token limit")
        );
        assert.ok(notice instanceof vscode.LanguageModelTextPart);
        assert.ok(
            notice.value.startsWith("\n\n[litellm-connector] "),
            "the notice must start a new block, not stick to the last word"
        );
    });

    test("tells the user when a content filter ends the response", async () => {
        const recorder = createPartRecorder();
        const stream = new SteppedSseStream(
            [chatTextFrame("Half an answer"), chatFinishFrame("content_filter"), SSE_DONE_FRAME],
            []
        );

        await processResponseStream({
            responseBody: stream.body,
            progress: recorder.progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.match(collectResponseText(recorder.parts), /content filter/);
        const notice = recorder.parts.find(
            (part) => part instanceof vscode.LanguageModelTextPart && part.value.includes("content filter")
        );
        assert.ok(notice instanceof vscode.LanguageModelTextPart);
        assert.ok(notice.value.startsWith("\n\n[litellm-connector] "));
    });

    test("does not recover buffered tool calls from an upstream failure that mentions a stream end", async () => {
        const recorder = createPartRecorder();
        const failureFrame = JSON.stringify({
            error: { message: "stream ended unexpectedly", type: "invalid_request_error", code: 400 },
        });
        const stream = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("toolu_done", "view"),
                chatToolCallArgumentsFrame('{"path":"README.md"}'),
                failureFrame,
            ],
            []
        );

        await assert.rejects(
            processResponseStream({
                responseBody: stream.body,
                progress: recorder.progress,
                token: new vscode.CancellationTokenSource().token,
                requestId: REQUEST_ID,
                inactivityTimeoutMs: STREAM_INACTIVITY_MS,
            }),
            UpstreamStreamError
        );

        assert.deepStrictEqual(
            collectToolCalls(recorder.parts),
            [],
            "a failed attempt must not deliver its buffered tool call"
        );
    });

    test("cancels the upstream body when the stream ends on an error frame", async () => {
        const rejectedFrame = JSON.stringify({
            error: { message: "bad request", type: "invalid_request_error", code: 400 },
        });
        let bodyCancelled = false;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(`data: ${rejectedFrame}\n\n`));
            },
            cancel() {
                bodyCancelled = true;
            },
        });

        await assert.rejects(
            processResponseStream({
                responseBody: body,
                progress: IGNORE_PROGRESS,
                token: new vscode.CancellationTokenSource().token,
                requestId: REQUEST_ID,
                inactivityTimeoutMs: STREAM_INACTIVITY_MS,
            }),
            UpstreamStreamError
        );

        assert.strictEqual(bodyCancelled, true, "an abandoned upstream must stop generating");
    });

    test("reports the text of a streamed answer", async () => {
        const tokenSource = new vscode.CancellationTokenSource();

        const encoder = new TextEncoder();
        const makeStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n"));
                    controller.close();
                },
            });

        const { parts, progress } = createPartRecorder();

        await processResponseStream({
            responseBody: makeStream(),
            progress,
            token: tokenSource.token,
            requestId: "req-hello",
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.strictEqual(collectResponseText(parts), "Hello");
    });

    test("disposes its cancellation listener when the stream ends", async () => {
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

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n'));
                controller.enqueue(encoder.encode("data: [DONE]\n"));
                controller.close();
            },
        });
        await processResponseStream({
            responseBody: stream,
            progress: { report: () => {} },
            token,
            requestId: "req-dispose",
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.strictEqual(disposed.length, 1, "the cancellation listener must be disposed exactly once");
    });
});
