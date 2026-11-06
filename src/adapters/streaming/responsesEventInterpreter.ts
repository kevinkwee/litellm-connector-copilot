/**
 * The `/responses` half of the stream interpreter: its event shapes, its tool-call
 * flush, and the dispatch the interpreter hands a `/responses` frame to.
 *
 * The chat-completions handling and the buffered state live in
 * `liteLLMStreamInterpreter.ts`. The two state types come from there as type-only
 * imports, erased at compile time, so the runtime dependency runs one way.
 */

import { StructuredLogger } from "../../observability/structuredLogger";
import { Logger } from "../../utils/logger";
import { sanitizeToolName } from "../../utils/toolNameUtils";
import type { EmittedPart, StreamingState } from "./liteLLMStreamInterpreter";
import { normalizeUsagePayload, type RawUsagePayload } from "./usagePayload";

/**
 * Translates a tool name the model sent into the name VS Code declared for it.
 *
 * The request advertised sanitized, deduplicated names, so the model's call
 * carries a wire name. A model-invented or mangled name is normalized again so
 * it stays wire-safe, and the per-request map then recovers the declared
 * spelling.
 */
export function resolveToolCallName(state: StreamingState, modelName: string): string {
    if (modelName.length === 0) {
        // A call that never carried a name cannot be executed, and
        // `sanitizeToolName("")` would invent the placeholder "tool", which the
        // agent loop would then try to run. Settlement drops an unnamed buffer.
        return "";
    }
    const wireName = sanitizeToolName(modelName);
    return state.wireToDeclaredNames?.get(wireName) ?? wireName;
}

export function requestTag(state: StreamingState): string {
    return `request=${state.requestId ?? "unknown"}`;
}

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
 * Delivers each keyed `/responses` tool call that has a name and valid JSON
 * arguments, and drops the rest. Settles the buffers so a later frame cannot
 * emit the same call twice.
 */
function flushResponsesToolCalls(state: StreamingState, toolCallParts: EmittedPart[]): number {
    let flushedToolCallCount = 0;
    for (const id of state.responseToolCallOrder) {
        const buffer = state.responseToolCallBuffers.get(id);
        if (!buffer) {
            continue;
        }
        if (buffer.name && buffer.args) {
            try {
                JSON.parse(buffer.args);
                Logger.trace(`[interpretStreamEvent] Flushing /responses tool call: ${buffer.name} (id: ${buffer.id})`);
                toolCallParts.push({
                    type: "tool_call",
                    index: toolCallParts.length,
                    id: buffer.id,
                    name: buffer.name,
                    args: buffer.args,
                });
                flushedToolCallCount++;
            } catch {
                Logger.warn(
                    `[interpretStreamEvent] ${requestTag(state)} Dropped malformed tool call args for ${buffer.name}`
                );
                StructuredLogger.warn("stream.responses_tool_call_buffer_dropped", {
                    requestId: state.requestId,
                    toolName: buffer.name,
                    id: buffer.id,
                    argsLength: buffer.args.length,
                });
                state.droppedToolCalls.push({ id: buffer.id, name: buffer.name });
            }
        }
    }
    state.responseToolCallBuffers.clear();
    state.responseToolCallOrder = [];
    return flushedToolCallCount;
}

/**
 * Emits the usage data part for a settled `/responses` turn. Only a usage object
 * with at least one token count produces a data part; one with no counts leaves
 * the connector's own estimate in place.
 */
function appendResponsesUsage(
    usage: ResponsesStreamUsage | undefined,
    dataParts: EmittedPart[],
    flushedToolCallCount: number
): void {
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
        toolCallsEmitted: flushedToolCallCount,
    });
}

/**
 * Applies one `/responses` frame to the buffers the interpreter collects.
 *
 * The parts are pushed into the caller's arrays so the interpreter can keep one
 * emission order across the two endpoints.
 */
export function interpretResponsesEvent(
    data: Record<string, unknown>,
    state: StreamingState,
    parts: {
        readonly text: EmittedPart[];
        readonly toolCalls: EmittedPart[];
        readonly data: EmittedPart[];
        readonly response: EmittedPart[];
        readonly finish: EmittedPart[];
    }
): void {
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        Logger.trace(`[interpretStreamEvent] Emitting /responses text delta: ${data.delta.length} chars`);
        parts.text.push({ type: "text", value: data.delta });
        StructuredLogger.trace("stream.responses_text_delta", {
            length: data.delta.length,
        });
    }
    // Robust shape: `response.output_item.delta`, keyed on `item.call_id`.
    // Providers that stream tool arguments through this event instead of
    // `response.output_tool_call.*` take this branch.
    if (data.type === "response.output_item.delta") {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : undefined;
            const name = typeof item.name === "string" ? item.name : undefined;
            const argsDelta = typeof item.arguments === "string" ? item.arguments : undefined;

            if (callId) {
                const existing = state.responseToolCallBuffers.get(callId) ?? { id: callId, name: undefined, args: "" };
                if (name) {
                    const sanitizedName = resolveToolCallName(state, name);
                    existing.name = sanitizedName;
                    Logger.trace(`[interpretStreamEvent] /responses output_item.delta tool name: ${sanitizedName}`);
                }
                if (argsDelta) {
                    existing.args += argsDelta;
                    Logger.trace(
                        `[interpretStreamEvent] /responses output_item.delta args delta: ${argsDelta.length} chars accumulated`
                    );
                }
                state.responseToolCallBuffers.set(callId, existing);
                if (!state.responseToolCallOrder.includes(callId)) {
                    state.responseToolCallOrder.push(callId);
                    StructuredLogger.trace("stream.responses_tool_call_delta", {
                        callId,
                        name,
                        argsLength: argsDelta?.length ?? 0,
                    });
                }
            } else {
                // No call_id yet, so buffer anonymously for providers that stream args before the id.
                if (name) {
                    const sanitizedName = resolveToolCallName(state, name);
                    state.anonymousResponseToolName = sanitizedName;
                    Logger.trace(
                        `[interpretStreamEvent] /responses output_item.delta anonymous tool name: ${sanitizedName}`
                    );
                }
                if (argsDelta) {
                    state.anonymousResponseToolArgs += argsDelta;
                    Logger.trace(
                        `[interpretStreamEvent] /responses output_item.delta anonymous args delta: ${argsDelta.length} chars accumulated`
                    );
                    StructuredLogger.trace("stream.responses_anonymous_tool_delta", {
                        argsLength: argsDelta.length,
                    });
                }
            }
        }
    }

    // Legacy shape: response.output_tool_call.* (keyed on delta.id)
    if (typeof data.type === "string" && data.type.startsWith("response.output_tool_call")) {
        const delta = data.delta as Record<string, unknown> | undefined;
        const id = typeof delta?.id === "string" ? delta.id : undefined;
        if (id) {
            Logger.trace(`[interpretStreamEvent] /responses legacy output_tool_call.* delta for id: ${id}`);
            const existing = state.responseToolCallBuffers.get(id) ?? { id, name: undefined, args: "" };
            if (typeof delta?.name === "string") {
                const sanitizedName = resolveToolCallName(state, delta.name);
                existing.name = sanitizedName;
                Logger.trace(`[interpretStreamEvent] /responses legacy tool name: ${sanitizedName}`);
            }
            if (typeof delta?.arguments === "string") {
                existing.args += delta.arguments;
                Logger.trace(
                    `[interpretStreamEvent] /responses legacy args delta: ${delta.arguments.length} chars accumulated`
                );
            }
            state.responseToolCallBuffers.set(id, existing);
            if (!state.responseToolCallOrder.includes(id)) {
                state.responseToolCallOrder.push(id);
                StructuredLogger.trace("stream.responses_legacy_tool_call_delta", {
                    id,
                    name: delta?.name as string | undefined,
                    argsLength: typeof delta?.arguments === "string" ? delta.arguments.length : 0,
                });
            }
        }
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
        const flushedToolCallCount = flushResponsesToolCalls(state, parts.toolCalls);
        Logger.trace(`[interpretStreamEvent] Flushed ${flushedToolCallCount} tool calls on ${data.type}`);

        appendResponsesUsage(response?.usage, parts.data, flushedToolCallCount);

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

            if (callId) {
                // Per-callId flush: emit the specific buffered call and remove it from the order
                // list so a later `response.completed` or `response.incomplete` does not double-emit it.
                const buffer = state.responseToolCallBuffers.get(callId);
                const name = nameFromDone ? resolveToolCallName(state, nameFromDone) : buffer?.name;
                const args = argsFromDone ?? buffer?.args;
                Logger.trace(
                    `[interpretStreamEvent] Flushing keyed tool call on output_item.done: ${name} (id: ${callId})`
                );
                if (name && args) {
                    try {
                        JSON.parse(args);
                        parts.toolCalls.push({
                            type: "tool_call",
                            index: parts.toolCalls.length,
                            id: callId,
                            name,
                            args,
                        });
                        StructuredLogger.trace("stream.responses_tool_call_done", {
                            callId,
                            name,
                            argsLength: args.length,
                        });
                    } catch {
                        Logger.warn(`[interpretStreamEvent] Dropped malformed tool call ${name} on output_item.done`);
                        state.droppedToolCalls.push({ id: callId, name });
                    }
                }
                state.responseToolCallBuffers.delete(callId);
                state.responseToolCallOrder = state.responseToolCallOrder.filter((id) => id !== callId);
            } else {
                // Anonymous tool call (no stable call_id), emitted best-effort from the
                // anonymous buffer for providers that never emit a call_id.
                const name = nameFromDone ? resolveToolCallName(state, nameFromDone) : state.anonymousResponseToolName;
                const args = argsFromDone ?? state.anonymousResponseToolArgs;
                Logger.trace(`[interpretStreamEvent] Flushing anonymous tool call on output_item.done: ${name}`);
                if (name && args) {
                    try {
                        JSON.parse(args);
                        parts.toolCalls.push({
                            type: "tool_call",
                            index: parts.toolCalls.length,
                            id: "anonymous",
                            name,
                            args,
                        });
                        StructuredLogger.trace("stream.responses_anonymous_tool_done", {
                            name,
                            argsLength: args.length,
                        });
                    } catch {
                        state.droppedToolCalls.push({ id: "anonymous", name });
                        Logger.warn(`[interpretStreamEvent] Dropped malformed anonymous tool call ${name}`);
                    }
                }
            }

            state.anonymousResponseToolName = undefined;
            state.anonymousResponseToolArgs = "";
        } else {
            // No function_call item (e.g., text item, or no item at all): legacy flush-all.
            // Preserves backward compat with output_tool_call.* path which relies on
            // output_item.done to drain all buffered calls when no `response.completed`
            // or `response.incomplete` frame follows.
            Logger.debug(`[interpretStreamEvent] Legacy flush-all on output_item.done (non-function_call item)`);
            const legacyFlushedCount = flushResponsesToolCalls(state, parts.toolCalls);
            Logger.debug(`[interpretStreamEvent] Legacy flushed ${legacyFlushedCount} tool calls on output_item.done`);
            StructuredLogger.trace("stream.responses_legacy_flush", {
                toolCallsEmitted: legacyFlushedCount,
            });
        }

        parts.finish.push({ type: "finish" });
    }
}
