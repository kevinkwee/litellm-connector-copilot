import type { CancellationToken, LanguageModelResponsePart, Progress } from "vscode";
import { LanguageModelTextPart } from "vscode";

import { tryParseJSONObject } from "../../utils/messageConversion";
import { describeDroppedToolCalls, describeStoppedEarly } from "../../utils/connectorNotice";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";
import { toErrorLogFields } from "../base/errorLogFields";
import { decodeSSE } from "../../adapters/sse/sseDecoder";
import {
    flushPendingBuffers,
    hasBufferedToolCalls,
    interpretStreamEvent,
} from "../../adapters/streaming/liteLLMStreamInterpreter";
import { createInitialStreamingState, type EmittedPart } from "../../adapters/streaming/streamingState";
import { emitPartsToVSCode } from "../../adapters/streaming/vscodePartEmitter";
import { InactivityTimeoutError, ReasoningOnlyError, UpstreamStreamError } from "../../utils/transportRetry";

/** Everything one upstream response contributes to a chat turn. */
export interface ResponseStreamContext {
    readonly responseBody: ReadableStream<Uint8Array>;
    readonly progress: Progress<LanguageModelResponsePart>;
    readonly token: CancellationToken;
    readonly requestId: string;
    /** Wire name to declared name, so a tool call reaches VS Code under a name it declared. */
    readonly wireToDeclaredNames?: ReadonlyMap<string, string>;
    /**
     * Thinking-block ids already used by earlier attempts of this request. Read as the
     * starting number and updated with the last one used, so a retry never reuses an id.
     */
    readonly thinkingBlockIds?: { used: number };
    readonly inactivityTimeoutMs: number;
}

/**
 * Closes an upstream response body the stream loop may have stopped reading.
 * `decodeSSE` releases its reader lock before returning, so this is safe for an
 * open body (cancels the transfer), a closed one (no-op), or a locked or errored
 * one (the rejection is ignored, because there is nothing else to do about it).
 */
function cancelUpstreamBody(body: ReadableStream<Uint8Array>): void {
    void body.cancel().catch(() => undefined);
}

/**
 * Reads one upstream SSE response and emits VS Code response parts for it.
 *
 * A resumed retry is a new upstream response, so every buffer here is created per
 * call and nothing survives into the next attempt. The recovery sentinels
 * (`InactivityTimeoutError`, `ReasoningOnlyError`, `UpstreamStreamError`) are
 * thrown for the caller's retry loop to classify. A truncated stream that recovers
 * any buffered tool call completes normally instead.
 */
export async function processResponseStream(context: ResponseStreamContext): Promise<void> {
    const { responseBody, progress, token, requestId, wireToDeclaredNames, inactivityTimeoutMs } = context;

    Logger.info(`[chatStream] request=${requestId} Starting stream processing`);
    StructuredLogger.info("stream.processing_start", {
        requestId,
        timestamp: new Date().toISOString(),
    });

    const streamingState = createInitialStreamingState(
        requestId,
        wireToDeclaredNames,
        context.thinkingBlockIds?.used ?? 0
    );
    let watchdog: NodeJS.Timeout | undefined;
    let eventCount = 0;
    let wasWatchdogAbort = false;
    // Content tracking for the reasoning-only detection: a cleanly-completed
    // stream whose ONLY emissions were thinking parts is not a success for
    // the agent loop (VS Code renders "no response was returned").
    let sawTextPart = false;
    let sawToolCallPart = false;
    let sawUsagePart = false;
    let reasoningChars = 0;
    // Set by a `finish` part that ends the turn without completing it.
    let stoppedEarly: { reason: string; notice: string } | undefined;
    // Proof that the model chose to end its turn, not merely that bytes stopped.
    let sawNormalFinish = false;
    // Set by any finish that ends the turn: `stop` or a `tool_calls` set the model
    // declared complete. A failure after one of them cannot be repaired by resending.
    let sawTurnEndingFinish = false;
    const controller = new AbortController();

    const emitParts = (parts: EmittedPart[]): void => {
        for (const part of parts) {
            if (part.type === "text") {
                sawTextPart = true;
            } else if (part.type === "tool_call") {
                sawToolCallPart = true;
            } else if (part.type === "data" && part.mimeType === "usage") {
                sawUsagePart = true;
            } else if (part.type === "thinking") {
                reasoningChars += typeof part.value === "string" ? part.value.length : part.value.join("").length;
            } else if (part.type === "finish") {
                stoppedEarly = describeStoppedEarly(part.reason) ?? stoppedEarly;
                if (part.reason === "stop") {
                    sawNormalFinish = true;
                }
                if (part.reason === "stop" || part.reason === "tool_calls") {
                    sawTurnEndingFinish = true;
                }
            }
        }
        // The state also holds the drops the interpreter made, so one notice can name
        // them all.
        streamingState.droppedToolCalls.push(...emitPartsToVSCode(parts, progress));
    };

    // A stream that stops without a finish frame, whether it closes cleanly
    // or is truncated, still holds tool calls the model fully streamed.
    // Delivering them keeps the agent loop going instead of stalling it.
    const recoverBufferedToolCalls = (reason: "stream_completed_without_finish" | "stream_incomplete"): number => {
        const recoveredToolCalls = flushPendingBuffers(streamingState).filter((part) => part.type === "tool_call");
        emitParts(recoveredToolCalls);
        Logger.info(
            `[chatStream] request=${requestId} Recovered ${recoveredToolCalls.length} buffered tool calls (${reason})`
        );
        StructuredLogger.info("stream.tool_calls_recovered", {
            requestId,
            reason,
            eventCount,
            toolCallsRecovered: recoveredToolCalls.length,
        });
        return recoveredToolCalls.length;
    };

    /**
     * Tells the user about the tool calls dropped for unreadable arguments. They never
     * ran, so without it the turn would read as a complete answer. Each attempt owns its
     * own state, so the notice is reported once per attempt and a replaced attempt's drops
     * are discarded with it.
     */
    const reportDroppedToolCalls = (): void => {
        if (streamingState.droppedToolCalls.length === 0) {
            return;
        }
        Logger.warn(`[chatStream] request=${requestId} ${streamingState.droppedToolCalls.length} tool call(s) dropped`);
        // Informational: the drop itself was recorded where it happened, and this entry
        // records that the notice was shown.
        StructuredLogger.info("stream.tool_calls_dropped", {
            requestId,
            eventCount,
            droppedToolCalls: streamingState.droppedToolCalls.map((call) => ({ id: call.id, name: call.name })),
        });
        progress.report(new LanguageModelTextPart(describeDroppedToolCalls(streamingState.droppedToolCalls)));
    };
    /**
     * Closes a turn whose stream has ended: recovers the tool calls it still holds, raises
     * the reasoning-only sentinel for a reply that carried nothing but reasoning, then
     * reports the notices the turn earned. A transport failure after a proven `stop` or
     * `tool_calls` finish runs this too, because that turn had already delivered its answer
     * or its calls, and only its terminator or its socket was lost.
     */
    const settleCompletedTurn = (): void => {
        // A cancelled stream delivers no tool calls: the host drops the parts
        // reported after it cancels, and after a connector cancel a recovered
        // call would reach the agent loop and run a tool the user just stopped.
        if (!token.isCancellationRequested && hasBufferedToolCalls(streamingState)) {
            recoverBufferedToolCalls("stream_completed_without_finish");
        }

        // `sawNormalFinish` is the `stop` proof, and it is the only proof this flag reads.
        // A chat `tool_calls` finish never needs it: that call set `sawToolCallPart` before
        // the emitter dropped it, so the reasoning-only guard below already leaves that turn
        // alone. Apart from that finish, a call dropped without a `stop` was cut short by a
        // length limit, a content filter or a closed stream.
        const dropIsTheAnswer = streamingState.droppedToolCalls.length > 0 && sawNormalFinish;

        // Reasoning-only detection needs all of: an event, no text, no call part either way,
        // and no drop the `stop` proved. A turn that streamed text, or that produced such a
        // drop, continues to its notices instead. It runs before the stop notice because a
        // retried turn must not carry the notice of the attempt it replaced.
        if (eventCount > 0 && !sawTextPart && !sawToolCallPart && !dropIsTheAnswer) {
            Logger.warn(
                `[chatStream] request=${requestId} Reasoning-only stream detected (${eventCount} events, ` +
                    `no text/tool parts); surfacing as resumable empty-content error`
            );
            StructuredLogger.warn("stream.reasoning_only_response", {
                requestId,
                eventCount,
                sawUsagePart,
            });
            throw new ReasoningOnlyError(eventCount, reasoningChars, sawNormalFinish);
        }

        // The stop notice comes first: it names the cause, and the drop notice reads
        // as a consequence of it.
        if (stoppedEarly) {
            Logger.warn(`[chatStream] request=${requestId} Stream stopped by finish reason "${stoppedEarly.reason}"`);
            StructuredLogger.warn("stream.stopped_early", {
                requestId,
                reason: stoppedEarly.reason,
                eventCount,
            });
            progress.report(new LanguageModelTextPart(stoppedEarly.notice));
        }

        reportDroppedToolCalls();
    };

    const resetWatchdog = () => {
        if (watchdog) {
            clearTimeout(watchdog);
        }
        watchdog = setTimeout(() => {
            Logger.warn(
                `[chatStream] request=${requestId} Inactivity timeout after ${inactivityTimeoutMs}ms (after ${eventCount} events)`
            );
            StructuredLogger.warn("stream.inactivity_timeout", {
                requestId,
                timeoutMs: inactivityTimeoutMs,
                eventCount,
            });
            wasWatchdogAbort = true;
            controller.abort();
        }, inactivityTimeoutMs);
    };

    const cancellationListener = token.onCancellationRequested(() => {
        // The listener runs synchronously inside whoever called cancel(),
        // so this stack is the only fingerprint of the canceller, e.g.
        // user action, Copilot agent-loop retry, session teardown, or the
        // connector's own command, which the CancellationToken API itself
        // does not expose.
        const cancellationStack = new Error().stack;
        Logger.warn(
            `[chatStream] request=${requestId} Cancellation requested after ${eventCount} events (text=${sawTextPart}, toolCall=${sawToolCallPart}, usage=${sawUsagePart})`
        );
        StructuredLogger.warn("stream.cancellation_requested", {
            requestId,
            eventCount,
            sawTextPart,
            sawToolCallPart,
            sawUsagePart,
            stack: cancellationStack,
        });
        if (watchdog) {
            clearTimeout(watchdog);
        }
        controller.abort();
    });

    try {
        resetWatchdog();
        Logger.debug(`[chatStream] Starting SSE decoder loop`);

        // Only a chunk read resets the watchdog. The loop must not reset it per payload:
        // a payload carries no new bytes, and a chunk that yields several events would push
        // the deadline past the last byte that justifies it.
        for await (const payload of decodeSSE(responseBody, token, controller.signal, resetWatchdog)) {
            eventCount++;

            Logger.trace(`[chatStream] Event #${eventCount} received, length=${payload.length}`);

            const jsonResult = tryParseJSONObject(payload);
            if (!jsonResult.ok) {
                Logger.trace(`[chatStream] Event #${eventCount}: Skipped (JSON parse failed)`);
                StructuredLogger.trace("stream.event_parse_skipped", {
                    eventNumber: eventCount,
                    payloadLength: payload.length,
                });
                continue;
            }
            const json = jsonResult.value;

            Logger.trace(`[chatStream] Event #${eventCount}: Interpreting event`);
            const parts = interpretStreamEvent(json, streamingState);
            Logger.trace(`[chatStream] Event #${eventCount}: Got ${parts.length} parts, emitting to VS Code`);
            StructuredLogger.trace("stream.event_processed", {
                eventNumber: eventCount,
                partCount: parts.length,
            });
            emitParts(parts);
        }

        Logger.info(`[chatStream] Stream loop completed after ${eventCount} events`);
        StructuredLogger.info("stream.processing_complete", {
            eventCount,
            reason: "stream_ended",
        });

        // A watchdog abort causes decodeSSE to END CLEANLY (the aborted flag
        // there suppresses its endError), so the abort lands HERE on the
        // normal path, not in the catch block. Surface it as the retryable
        // sentinel BEFORE reasoning-only detection: a watchdog abort kills
        // the stream regardless of whether reasoning was emitted. A turn that
        // already declared its end is settled instead, because the silence came
        // after the answer, not in place of it.
        if (wasWatchdogAbort && !sawTurnEndingFinish) {
            throw new InactivityTimeoutError(inactivityTimeoutMs, eventCount);
        }

        settleCompletedTurn();
    } catch (error: unknown) {
        // The reader's own sentinel is thrown by the settlement inside the try, so it must
        // leave here untouched: the retry loop owns it, and letting it reach the
        // post-finish branch below would record a failure for a turn that simply had
        // nothing to say.
        if (error instanceof ReasoningOnlyError) {
            throw error;
        }

        const isStreamEndError =
            !(error instanceof UpstreamStreamError) &&
            error instanceof Error &&
            (error.message.includes("Stream ended before [DONE] marker") ||
                error.message.includes("stream ended") ||
                error.message.includes("unexpected end"));

        // A partial response with its tool calls beats a hard failure, so a
        // truncated stream that recovers any call completes normally.
        if (isStreamEndError && hasBufferedToolCalls(streamingState)) {
            const recoveredCount = recoverBufferedToolCalls("stream_incomplete");
            if (recoveredCount > 0) {
                reportDroppedToolCalls();
                return;
            }
        }

        // A turn that already declared its end is finished, whatever transport failure came
        // afterwards: a lost terminator or a read error. Resending it would pay for a full
        // prompt and could append text to an answer the model had ended, and for a
        // `tool_calls` finish the calls have already run.
        //
        // An upstream error frame is not a transport failure: the proxy reported that the
        // request failed, and the rejection has to reach the turn instead of being hidden
        // behind a completed reply.
        if (sawTurnEndingFinish && !(error instanceof UpstreamStreamError)) {
            // Sanitized fields only: a mid-stream failure detail can carry generated content,
            // so the structured fields below are the record, not the message.
            Logger.debug(`[chatStream] request=${requestId} ignoring a transport failure after the turn's finish`);
            StructuredLogger.info("stream.failure_after_finish", {
                requestId,
                eventCount,
                ...toErrorLogFields(error),
            });
            settleCompletedTurn();
            return;
        }

        // The attempt really failed, and it is about to leave this layer: record it
        // once here. The turn's outcome is recorded separately at the provider
        // boundary, so a recovered retry never reads as a failure in the channel.
        Logger.warn(
            `[chatStream] request=${requestId} Stream attempt failed after ${eventCount} events`,
            toErrorLogFields(error)
        );
        StructuredLogger.warn("stream.attempt_failed", {
            requestId,
            eventCount,
            ...toErrorLogFields(error),
        });

        // Belt-and-suspenders: if a watchdog abort coincided with an actual
        // stream error, classify it as the retryable inactivity sentinel.
        if (wasWatchdogAbort) {
            throw new InactivityTimeoutError(inactivityTimeoutMs, eventCount);
        }

        throw error;
    } finally {
        // The retry loop re-enters this function per attempt on the same token, so
        // the listener must not outlive this call, or earlier attempts would log
        // duplicate cancellation events.
        cancellationListener.dispose();
        if (watchdog) {
            clearTimeout(watchdog);
        }
        // Every exit path releases the reader, but an early exit (error
        // frame, reasoning-only retry, recovered tool calls) would otherwise
        // leave the upstream generating and billing until it finishes.
        cancelUpstreamBody(responseBody);
        if (context.thinkingBlockIds) {
            context.thinkingBlockIds.used = streamingState.thinkingBlockCounter;
        }
    }
}
