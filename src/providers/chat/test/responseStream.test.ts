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
    createKeepAliveSseStream,
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

    test("drops a tool call whose arguments do not parse and explains it", async () => {
        const { parts, progress } = createPartRecorder();
        const stream = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("call_bad", "read_file"),
                chatToolCallArgumentsFrame("{not json"),
                chatFinishFrame("tool_calls"),
                SSE_DONE_FRAME,
            ],
            []
        ).body;

        await processResponseStream({
            responseBody: stream,
            progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.deepStrictEqual(collectToolCalls(parts), [], "the tool must not run on guessed arguments");
        assert.match(collectResponseText(parts), /\[litellm-connector\].*"read_file" tool was not run/);
    });

    test("treats a dropped call as the answer when the stream stopped", async () => {
        // Nothing but an unreadable call arrives, and the stop finish proves the model
        // finished writing it, so the turn is answered rather than resumed.
        const { parts, progress } = createPartRecorder();
        const stream = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("call_bad", "read_file"),
                chatToolCallArgumentsFrame("{not json"),
                chatFinishFrame("stop"),
                SSE_DONE_FRAME,
            ],
            []
        ).body;

        await processResponseStream({
            responseBody: stream,
            progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.match(collectResponseText(parts), /was not run/);
    });

    test("explains a /responses call dropped for unreadable arguments", async () => {
        const { parts, progress } = createPartRecorder();
        const done = JSON.stringify({
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_bad", name: "search_files", arguments: "{not json" },
        });
        const completed = JSON.stringify({ type: "response.completed", response: {} });
        const stream = new SteppedSseStream([done, completed, SSE_DONE_FRAME], []).body;

        await processResponseStream({
            responseBody: stream,
            progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.deepStrictEqual(collectToolCalls(parts), []);
        assert.match(collectResponseText(parts), /"search_files" tool was not run/);
    });

    test("reports the stop notice before the dropped-call notice", async () => {
        const { parts, progress } = createPartRecorder();
        const stream = new SteppedSseStream(
            [
                chatTextFrame("the answer starts"),
                chatToolCallHeaderFrame("call_bad", "search_files"),
                chatToolCallArgumentsFrame("{not json"),
                chatFinishFrame("length"),
                SSE_DONE_FRAME,
            ],
            []
        ).body;

        await processResponseStream({
            responseBody: stream,
            progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        const text = collectResponseText(parts);
        assert.ok(text.includes("output token limit"), "the stop notice must be present");
        assert.ok(
            text.indexOf("output token limit") < text.indexOf("was not run"),
            "the cause has to read before the loss it explains"
        );
    });

    for (const [label, frames] of [
        [
            "a length finish",
            [
                chatReasoningFrame("thinking"),
                chatToolCallHeaderFrame("call_bad", "read_file"),
                chatToolCallArgumentsFrame("{not json"),
                chatFinishFrame("length"),
                SSE_DONE_FRAME,
            ],
        ],
        [
            "a close with no finish frame",
            [
                chatReasoningFrame("thinking"),
                chatToolCallHeaderFrame("call_bad", "read_file"),
                chatToolCallArgumentsFrame("{not json"),
                SSE_DONE_FRAME,
            ],
        ],
    ] as const) {
        test(`retries a call that ${label} cut short instead of reporting it`, async () => {
            const { progress } = createPartRecorder();
            const stream = new SteppedSseStream(frames, []).body;

            await assert.rejects(
                () =>
                    processResponseStream({
                        responseBody: stream,
                        progress,
                        token: new vscode.CancellationTokenSource().token,
                        requestId: REQUEST_ID,
                        inactivityTimeoutMs: STREAM_INACTIVITY_MS,
                    }),
                ReasoningOnlyError,
                "a truncated call is not an answer, so the turn has to be resumable"
            );
        });
    }

    test("reports the loss after recovering a call from a truncated stream", async () => {
        const { parts, progress } = createPartRecorder();
        const encoder = new TextEncoder();
        // One readable call is recovered when the stream dies mid-frame. The other call
        // arrived complete but its arguments do not parse, so it is dropped and explained.
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const frame of [
                    chatToolCallHeaderFrame("call_good", "read_file"),
                    chatToolCallArgumentsFrame('{"path":"a.ts"}'),
                    chatToolCallHeaderFrame("call_bad", "search_files", 1),
                    chatToolCallArgumentsFrame("{not json", 1),
                ]) {
                    controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
                }
                // A frame with no closing blank line: decodeSSE reports a truncated stream.
                controller.enqueue(encoder.encode(`data: {"choices":[{"delta":`));
                controller.close();
            },
        });

        await processResponseStream({
            responseBody: stream,
            progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: STREAM_INACTIVITY_MS,
        });

        assert.deepStrictEqual(
            collectToolCalls(parts).map((call) => call.name),
            ["read_file"],
            "the readable call survives the truncation"
        );
        assert.match(collectResponseText(parts), /"search_files" tool was not run/);
    });

    test("keeps reading while keep-alive comments arrive and no event completes", async () => {
        // Comment frames yield no payload, so only a per-chunk reset keeps a healthy
        // stream that outlasts the bound from being aborted. Twenty frames, one every
        // KEEP_ALIVE_GAP_MS, span twice the bound set below, and no gap exceeds a tenth
        // of it.
        const KEEP_ALIVE_COUNT = 20;
        const KEEP_ALIVE_GAP_MS = 25;
        const { parts, progress } = createPartRecorder();
        const stream = createKeepAliveSseStream(KEEP_ALIVE_COUNT, KEEP_ALIVE_GAP_MS, [
            chatTextFrame("Still here"),
            SSE_DONE_FRAME,
        ]);

        await processResponseStream({
            responseBody: stream,
            progress,
            token: new vscode.CancellationTokenSource().token,
            requestId: REQUEST_ID,
            inactivityTimeoutMs: KEEP_ALIVE_GAP_MS * 10,
        });

        assert.strictEqual(collectResponseText(parts), "Still here");
    });
});
