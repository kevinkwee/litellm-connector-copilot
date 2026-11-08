/**
 * The `/responses` half of the stream interpreter: its event shapes, its tool-call
 * settlement, and the dispatch the interpreter hands a `/responses` frame to.
 *
 * The chat-completions handling lives in `liteLLMStreamInterpreter.ts`. The state types
 * and the helpers both halves use come from `streamingState.ts`.
 */

import { StructuredLogger } from "../../observability/structuredLogger";
import { Logger } from "../../utils/logger";
import { tryParseJSONObject } from "../../utils/messageConversion";
import { normalizeUsagePayload, type RawUsagePayload } from "./usagePayload";
import {
    ensureCurrentThinkingBlockId,
    requestTag,
    resolveToolCallName,
    type EmittedPart,
    type StreamingState,
} from "./streamingState";

/**
 * `/responses` usage object. LiteLLM reports the counters as `input_tokens` and
 * `output_tokens`; the detail objects keep the `RawUsagePayload` spellings.
 */
interface ResponsesStreamUsage extends RawUsagePayload {
    input_tokens?: number;
    output_tokens?: number;
}

/**
 * The `response` object of `response.completed` and `response.incomplete`,
 * reduced to the fields the interpreter reads.
 */
interface ResponsesStreamResponse {
    usage?: ResponsesStreamUsage;
    incomplete_details?: { reason?: string };
    /** "incomplete" marks a response cut short, by the bridge or by the Responses API itself. */
    status?: string;
}

/**
 * Maps an `/responses` `incomplete_details.reason` onto the chat-completions
 * `length` and `content_filter` finish reasons, which the provider renders as a
 * stopped-early notice. An unknown or missing reason maps to `undefined`, so the
 * turn ends without a finish part rather than claiming a cause the connector
 * cannot name.
 */
function mapIncompleteDetailsReason(reason: string | undefined): string | undefined {
    if (reason === "max_output_tokens") {
        return "length";
    }
    if (reason === "content_filter") {
        return "content_filter";
    }
    return undefined;
}

/**
 * Maps the `/responses` counters (`input_tokens`, `output_tokens`) onto the
 * chat-completions names `normalizeUsagePayload` reads. The remaining fields,
 * detail objects included, pass through in whichever spelling the gateway sent.
 */
function toRawUsage(usage: ResponsesStreamUsage): RawUsagePayload {
    const { input_tokens, output_tokens, ...rest } = usage;
    return {
        ...rest,
        prompt_tokens: input_tokens ?? rest.prompt_tokens,
        completion_tokens: output_tokens ?? rest.completion_tokens,
    };
}

/**
 * Logs a `/responses` tool call the interpreter cannot deliver. The caller owns the
 * record on `droppedToolCalls`.
 */
function logDroppedResponsesToolCall(
    state: StreamingState,
    reason: "incomplete" | "invalid_json_args",
    call: { readonly id: string | undefined; readonly toolName: string | undefined; readonly argsLength: number }
): void {
    Logger.warn(`[responsesStream] ${requestTag(state)} Dropped /responses tool call (${reason})`);
    StructuredLogger.warn("stream.responses_tool_call_buffer_dropped", {
        requestId: state.requestId,
        reason,
        toolName: call.toolName,
        id: call.id,
        argsLength: call.argsLength,
    });
}

/**
 * The call a `/responses` done frame can deliver, or `undefined` when it cannot.
 *
 * A call missing its name or its arguments was never fully declared, so it is only
 * logged and no notice names it. One whose arguments are not a JSON object cannot run,
 * so it is logged and recorded as a tool that did not run.
 */
function acceptResponsesToolCall(
    state: StreamingState,
    call: { readonly id: string; readonly name?: string; readonly args?: string }
): { readonly id: string; readonly name: string; readonly args: string } | undefined {
    if (!call.name || !call.args) {
        logDroppedResponsesToolCall(state, "incomplete", {
            id: call.id,
            toolName: call.name,
            argsLength: call.args?.length ?? 0,
        });
        return undefined;
    }
    if (!tryParseJSONObject(call.args).ok) {
        logDroppedResponsesToolCall(state, "invalid_json_args", {
            id: call.id,
            toolName: call.name,
            argsLength: call.args.length,
        });
        state.droppedToolCalls.push({ id: call.id, name: call.name });
        return undefined;
    }
    return { id: call.id, name: call.name, args: call.args };
}

/**
 * Emits the usage data part for a settled `/responses` turn. Only a usage object
 * with at least one token count produces a data part; one with no counts leaves
 * the connector's own estimate in place.
 */
function appendResponsesUsage(usage: ResponsesStreamUsage | undefined, dataParts: EmittedPart[]): void {
    if (typeof usage?.input_tokens !== "number" && typeof usage?.output_tokens !== "number") {
        return;
    }
    const usageValue = normalizeUsagePayload(toRawUsage(usage));
    Logger.debug(
        `[interpretStreamEvent] Recording usage: input=${usageValue.prompt_tokens} output=${usageValue.completion_tokens}`
    );
    dataParts.push({
        type: "data",
        mimeType: "usage",
        value: usageValue,
    });
    StructuredLogger.trace("stream.responses_usage", {
        inputTokens: usageValue.prompt_tokens,
        outputTokens: usageValue.completion_tokens,
        systemPromptTokens: usageValue.system_prompt_tokens,
    });
}

/**
 * Applies one `/responses` frame to the part arrays the interpreter collects.
 *
 * The parts are pushed into the caller's arrays so the interpreter can keep one
 * emission order across the two endpoints.
 */
export function interpretResponsesEvent(
    data: Record<string, unknown>,
    state: StreamingState,
    parts: {
        readonly thinking: EmittedPart[];
        readonly text: EmittedPart[];
        readonly toolCalls: EmittedPart[];
        readonly data: EmittedPart[];
        readonly response: EmittedPart[];
        readonly finish: EmittedPart[];
    }
): void {
    // The chat-to-Responses bridge reports reasoning as a summary delta, and the
    // provider's own text form can arrive too. Both are the model thinking, so they
    // share one block id per reply, which keeps that reply's reasoning in one part.
    if (
        (data.type === "response.reasoning_summary_text.delta" || data.type === "response.reasoning_text.delta") &&
        typeof data.delta === "string" &&
        data.delta.length > 0
    ) {
        parts.thinking.push({ type: "thinking", value: data.delta, id: ensureCurrentThinkingBlockId(state) });
    }
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        Logger.trace(`[interpretStreamEvent] Emitting /responses text delta: ${data.delta.length} chars`);
        parts.text.push({ type: "text", value: data.delta });
        StructuredLogger.trace("stream.responses_text_delta", {
            length: data.delta.length,
        });
    }
    if (data.type === "response.completed" || data.type === "response.incomplete") {
        Logger.info(`[interpretStreamEvent] Received /responses ${data.type} event`);
        const response = data.response as ResponsesStreamResponse | undefined;
        parts.response.push({
            type: "response",
            usage: {
                inputTokens: response?.usage?.input_tokens,
                outputTokens: response?.usage?.output_tokens,
            },
        });
        appendResponsesUsage(response?.usage, parts.data);

        // A `response.incomplete` ends the turn like a chat `finish_reason`, so the
        // provider shows its stopped-early notice instead of presenting a truncated
        // answer as finished. A completed response reports `stop`, the only proof the
        // provider accepts that the model chose to stop, and the bridge reports every
        // one of its turns as completed, marking a cut-short one with `status`.
        const incompleteReason =
            data.type === "response.incomplete"
                ? mapIncompleteDetailsReason(response?.incomplete_details?.reason)
                : undefined;
        if (incompleteReason) {
            parts.finish.push({ type: "finish", reason: incompleteReason });
        } else if (data.type === "response.completed" && response?.status !== "incomplete") {
            parts.finish.push({ type: "finish", reason: "stop" });
        }
    }
    if (data.type === "response.output_item.done") {
        Logger.debug(`[interpretStreamEvent] Received /responses output_item.done event`);
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : undefined;
            const nameFromDone = typeof item.name === "string" ? item.name : undefined;
            const argsFromDone = typeof item.arguments === "string" ? item.arguments : undefined;
            if (!callId) {
                // No supported server sends this shape, and a call the connector cannot
                // address is a drop it has to state rather than swallow.
                logDroppedResponsesToolCall(state, "incomplete", {
                    id: undefined,
                    toolName: nameFromDone,
                    argsLength: argsFromDone?.length ?? 0,
                });
            } else {
                // The bridge sends a function call complete on `output_item.done`, so the
                // frame itself carries everything the call needs.
                const name = nameFromDone ? resolveToolCallName(state, nameFromDone) : undefined;
                Logger.trace(
                    `[interpretStreamEvent] Flushing /responses tool call on output_item.done: ${name} (id: ${callId})`
                );
                const accepted = acceptResponsesToolCall(state, { id: callId, name, args: argsFromDone });
                if (accepted) {
                    parts.toolCalls.push({
                        type: "tool_call",
                        index: parts.toolCalls.length,
                        id: accepted.id,
                        name: accepted.name,
                        args: accepted.args,
                    });
                    StructuredLogger.trace("stream.responses_tool_call_done", {
                        callId,
                        name: accepted.name,
                        argsLength: accepted.args.length,
                    });
                }
            }
        }
    }
}
