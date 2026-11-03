import type { CancellationToken, LanguageModelResponsePart, Progress } from "vscode";
import { LanguageModelTextPart } from "vscode";

import { tryParseJSONObject } from "../../utils";
import { describeStoppedEarly } from "../../utils/connectorNotice";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";
import { toErrorLogFields } from "../base/errorLogFields";
import { decodeSSE } from "../../adapters/sse/sseDecoder";
import {
    createInitialStreamingState,
    flushPendingBuffers,
    hasBufferedToolCalls,
    interpretStreamEvent,
} from "../../adapters/streaming/liteLLMStreamInterpreter";
import type { EmittedPart } from "../../adapters/streaming/liteLLMStreamInterpreter";
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

    const streamingState = createInitialStreamingState(requestId, wireToDeclaredNames);
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
            }
        }
        emitPartsToVSCode(parts, progress);
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

        for await (const payload of decodeSSE(responseBody, token, controller.signal)) {
            resetWatchdog();
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
        // the stream regardless of whether reasoning was emitted.
        if (wasWatchdogAbort) {
            throw new InactivityTimeoutError(inactivityTimeoutMs, eventCount);
        }

        // A cancelled stream delivers no tool calls: the host drops the parts
        // reported after it cancels, and after a connector cancel a recovered
        // call would reach the agent loop and run a tool the user just stopped.
        if (!token.isCancellationRequested && hasBufferedToolCalls(streamingState)) {
            recoverBufferedToolCalls("stream_completed_without_finish");
        }

        // Reasoning-only detection: a cleanly-completed stream that emitted
        // ONLY thinking parts (plus perhaps a usage data part) contains
        // nothing the agent loop can act on. VS Code renders it as
        // "no response was returned" and kills the turn. Surface it to the
        // retry loop as resumable: the partial reasoning is appended to the
        // request so the model continues its thought.
        if (eventCount > 0 && !sawTextPart && !sawToolCallPart) {
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

        // Deliberately after the reasoning-only check: if the model only
        // reasoned before hitting its limit, the retry path is the better
        // answer than a notice about a response that never appeared.
        if (stoppedEarly) {
            Logger.warn(`[chatStream] request=${requestId} Stream stopped by finish reason "${stoppedEarly.reason}"`);
            StructuredLogger.warn("stream.stopped_early", {
                requestId,
                reason: stoppedEarly.reason,
                eventCount,
            });
            progress.report(new LanguageModelTextPart(stoppedEarly.notice));
        }
    } catch (error: unknown) {
        // Every error leaving this function is handled by the caller, which
        // retries the recoverable sentinels and logs the final outcome. Log the
        // attempt at warn so a recovered retry does not read as a failure in the
        // channel.
        Logger.warn(
            `[chatStream] request=${requestId} Stream attempt failed after ${eventCount} events`,
            toErrorLogFields(error)
        );
        StructuredLogger.warn("stream.attempt_failed", {
            requestId,
            eventCount,
            ...toErrorLogFields(error),
        });

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
                return;
            }
        }

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
    }
}
