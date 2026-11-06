import { normalizeToolCallId } from "../../utils";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";
import { redactedThinkingMetadata, signedThinkingMetadata } from "../../utils/thinkingBlocks";
import { normalizeUsagePayload, type RawUsagePayload } from "./usagePayload";
import { interpretResponsesEvent, requestTag, resolveToolCallName } from "./responsesEventInterpreter";
import { extractUpstreamStreamError } from "./upstreamStreamError";
import type { DroppedToolCall } from "../../types";

/**
 * Discriminated union of response parts the stream interpreter emits toward
 * VS Code (text, data, thinking, buffered tool calls, finish, and usage).
 */
export type EmittedPart =
    | { type: "text"; value: string }
    | { type: "data"; mimeType: string; value: unknown }
    | { type: "thinking"; value: string | string[]; id?: string; metadata?: Record<string, unknown> }
    | { type: "tool_call"; index: number; id?: string; name?: string; args: string }
    | { type: "finish"; reason?: string }
    | { type: "response"; usage?: { inputTokens?: number; outputTokens?: number } };

interface ChatToolCallBuffer {
    id?: string;
    name?: string;
    args: string;
}

export interface StreamingState {
    /** Ties this stream's diagnostics to its request when several sessions stream at once. */
    readonly requestId: string | undefined;
    /**
     * Advertised tool name to the name VS Code declared, for every tool whose
     * advertised name differs from its declared spelling, whether the sanitizer
     * or the collision suffix changed it. Tool calls carry the wire name the
     * request advertised, and VS Code resolves a call by the name it declared,
     * so the emission path translates back through this map.
     */
    readonly wireToDeclaredNames: ReadonlyMap<string, string> | undefined;
    toolCallBuffers: Map<number, ChatToolCallBuffer>;
    /** Call ids already delivered, so a repeated id cannot execute a tool twice. */
    emittedToolCallIds: Set<string>;
    responseToolCallBuffers: Map<string, { id: string; name?: string; args: string }>;
    responseToolCallOrder: string[];
    mergeReasoningContentInChoices: boolean;
    /**
     * Anonymous tool buffering: used when upstream streams tool args before emitting a stable
     * call_id. If multiple anonymous calls interleave without call_ids they cannot be disambiguated.
     */
    anonymousResponseToolName: string | undefined;
    anonymousResponseToolArgs: string;
    /**
     * Thinking-block id allocation. Text deltas of one Anthropic
     * thinking block share an id so VS Code and the Agents window merge them
     * with that block's sealed part; a sealed (signature or redacted) part
     * ends the id so the next block streams under a fresh one. Ids carry no
     * upstream meaning; they only group the parts of one block.
     */
    thinkingBlockCounter: number;
    currentThinkingBlockId: string | undefined;
    /**
     * Calls dropped because their arguments could not be parsed. The stream reader names
     * them in a notice when the attempt completes; an attempt that throws, for a retry or a
     * failure, discards them.
     */
    readonly droppedToolCalls: DroppedToolCall[];
}

export function createInitialStreamingState(
    requestId?: string,
    wireToDeclaredNames?: ReadonlyMap<string, string>
): StreamingState {
    return {
        requestId,
        wireToDeclaredNames,
        toolCallBuffers: new Map(),
        emittedToolCallIds: new Set(),
        responseToolCallBuffers: new Map(),
        responseToolCallOrder: [],
        mergeReasoningContentInChoices: false,
        anonymousResponseToolName: undefined,
        anonymousResponseToolArgs: "",
        thinkingBlockCounter: 0,
        currentThinkingBlockId: undefined,
        droppedToolCalls: [],
    };
}

function nextThinkingBlockId(state: StreamingState): string {
    state.thinkingBlockCounter += 1;
    return `litellm-thinking-${state.thinkingBlockCounter}`;
}

function ensureCurrentThinkingBlockId(state: StreamingState): string {
    if (state.currentThinkingBlockId === undefined) {
        state.currentThinkingBlockId = nextThinkingBlockId(state);
    }
    return state.currentThinkingBlockId;
}

/**
 * Normalizes a streamed `function.arguments` delta to text. The OpenAI stream
 * shape sends a JSON string fragment, but upstream payloads are external input,
 * so an object is serialized and any other value contributes nothing.
 */
function toArgumentText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value !== null && typeof value === "object") {
        return JSON.stringify(value);
    }
    return "";
}

/** Finish reason recorded when a stream ends without a finish frame. */
const INCOMPLETE_STREAM_END = "incomplete_stream_end";

/**
 * Longest slice of unparsable tool call arguments a log may carry. A merged or
 * truncated payload is only diagnosable from its content, and the cap keeps the
 * rest of the payload out of the logs.
 */
export const TOOL_ARGS_PREVIEW_MAX_CHARS = 160;

type DroppedToolCallReason = "replaced_by_new_id" | "incomplete_at_finish" | "invalid_json_args";

/**
 * Logs a chat-completions tool call discarded before it reaches VS Code. Without this
 * log the drop notice names the tool but gives no reason, index, finish reason or
 * argument length.
 */
function logDroppedToolCallBuffer(
    state: StreamingState,
    reason: DroppedToolCallReason,
    index: number,
    buffer: ChatToolCallBuffer,
    finishReason?: string
): void {
    const fields = {
        requestId: state.requestId,
        reason,
        index,
        finishReason,
        hasId: !!buffer.id,
        argsLength: buffer.args.length,
    };
    Logger.warn(
        `[toolCallBuffer] ${requestTag(state)} Dropped buffered tool call at index ${index} (${reason})`,
        fields
    );
    StructuredLogger.warn("stream.tool_call_buffer_dropped", fields);
}

/**
 * Returns a part for each chat-completions buffer this layer can deliver, records the
 * ones it cannot, skips ids already emitted, and clears the buffers.
 *
 * A buffer with invalid JSON arguments is still returned at a `tool_calls` finish,
 * where the model declares its calls complete, because the emitter is the layer that
 * drops it there: this layer records the parse failure at debug level and leaves the
 * single record of the drop to the emitter. At any other finish this layer drops the
 * call, records it on the state, and logs the drop itself, and the stream reader judges
 * from the finish whether the drop answered the turn.
 */
function settleChatToolCallBuffers(state: StreamingState, finishReason: string): EmittedPart[] {
    const parts: EmittedPart[] = [];
    for (const [index, buffer] of state.toolCallBuffers) {
        if (!buffer.id || !buffer.name || !buffer.args) {
            logDroppedToolCallBuffer(state, "incomplete_at_finish", index, buffer, finishReason);
            continue;
        }
        let isJsonValid = true;
        try {
            JSON.parse(buffer.args);
        } catch {
            isJsonValid = false;
        }
        const isDuplicate = state.emittedToolCallIds.has(buffer.id);
        if (!isJsonValid) {
            const fields = {
                requestId: state.requestId,
                toolName: buffer.name,
                normalizedId: buffer.id,
                index,
                finishReason,
                argsLength: buffer.args.length,
                argsPreview: buffer.args.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS),
            };
            if (finishReason === "tool_calls" && !isDuplicate) {
                // The call reaches the emitter, which drops it there and owns the single
                // record for the drop.
                StructuredLogger.debug("stream.tool_call_args_invalid_json", fields);
            } else {
                StructuredLogger.error("stream.tool_call_args_invalid_json", fields);
            }
        }
        if (isDuplicate) {
            continue;
        }
        if (!isJsonValid && finishReason !== "tool_calls") {
            logDroppedToolCallBuffer(state, "invalid_json_args", index, buffer, finishReason);
            state.droppedToolCalls.push({ id: buffer.id, name: buffer.name });
            continue;
        }
        parts.push({ type: "tool_call", index, id: buffer.id, name: buffer.name, args: buffer.args });
        state.emittedToolCallIds.add(buffer.id);
        StructuredLogger.trace("stream.tool_call_emitted", {
            toolName: buffer.name,
            normalizedId: buffer.id,
            index,
            finishReason,
        });
    }
    state.toolCallBuffers.clear();
    return parts;
}

/**
 * True while tool call fragments remain buffered. A finish frame settles the
 * chat-completions buffers, and `output_item.done`, `response.completed`, or
 * `response.incomplete` settles keyed /responses calls. A `function_call`
 * `output_item.done`, or the end-of-stream flush, settles an anonymous call.
 */
export function hasBufferedToolCalls(state: StreamingState): boolean {
    return (
        state.toolCallBuffers.size > 0 ||
        state.responseToolCallOrder.length > 0 ||
        state.anonymousResponseToolName !== undefined ||
        state.anonymousResponseToolArgs.length > 0
    );
}

interface RawThinkingBlock {
    type: string;
    thinking?: unknown;
    signature?: unknown;
    data?: unknown;
}

/**
 * Reads the raw thinking blocks an Anthropic delta carries. An entry without a string
 * `type`, or one that is not an object, is skipped.
 */
function extractRawThinkingBlocks(raw: unknown): RawThinkingBlock[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const blocks: RawThinkingBlock[] = [];
    for (const entry of raw) {
        if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).type === "string") {
            blocks.push(entry as RawThinkingBlock);
        }
    }
    return blocks;
}

/**
 * Interprets a single JSON frame from LiteLLM (OpenAI or /responses format)
 * and returns a list of emitted parts.
 *
 * @throws {UpstreamStreamError} when the frame reports an upstream failure.
 * Throwing rather than returning a part keeps a swallowed error impossible:
 * the caller's stream loop stops and the retry loop decides whether to resume.
 */
export function interpretStreamEvent(json: unknown, state: StreamingState): EmittedPart[] {
    const thinkingParts: EmittedPart[] = [];
    const textParts: EmittedPart[] = [];
    const toolCallParts: EmittedPart[] = [];
    const dataParts: EmittedPart[] = [];
    const responseParts: EmittedPart[] = [];
    const finishParts: EmittedPart[] = [];
    const data = json as Record<string, unknown>;

    const upstreamError = extractUpstreamStreamError(data);
    if (upstreamError) {
        throw upstreamError;
    }

    // Log the incoming event at trace level
    Logger.trace("[interpretStreamEvent] Processing event", {
        eventType: typeof data.type === "string" ? data.type : "unknown",
        hasChoices: !!data.choices,
        hasUsage: !!data.usage,
    });
    StructuredLogger.trace("stream.event_received", {
        eventType: typeof data.type === "string" ? data.type : undefined,
        hasChoices: !!data.choices,
        hasUsage: !!data.usage,
        mergeReasoning: state.mergeReasoningContentInChoices,
    });

    if (typeof data.merge_reasoning_content_in_choices === "boolean") {
        state.mergeReasoningContentInChoices = data.merge_reasoning_content_in_choices;
        Logger.trace(
            `[interpretStreamEvent] Set mergeReasoningContentInChoices=${data.merge_reasoning_content_in_choices}`
        );
        StructuredLogger.trace("stream.merge_reasoning_setting", {
            mergeReasoningContentInChoices: data.merge_reasoning_content_in_choices,
        });
    }

    // 1. Handle OpenAI chat-completions format
    if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta = choice.delta as Record<string, unknown> | undefined;

        const reasoningContent =
            typeof delta?.reasoning_content === "string" && delta.reasoning_content
                ? delta.reasoning_content
                : undefined;
        const mergeReasoningIntoContent = state.mergeReasoningContentInChoices && !!reasoningContent;

        // Reasoning text streams as incremental deltas sharing one block id,
        // so VS Code and the Agents window group them with the block's sealed
        // part when the signature arrives.
        if (reasoningContent && !mergeReasoningIntoContent) {
            thinkingParts.push({ type: "thinking", value: reasoningContent, id: ensureCurrentThinkingBlockId(state) });
            Logger.trace(`[interpretStreamEvent] Emitted thinking part, length=${reasoningContent.length}`);
            StructuredLogger.trace("stream.reasoning_emitted", {
                length: reasoningContent.length,
            });
        } else if (reasoningContent && mergeReasoningIntoContent) {
            Logger.trace(`[interpretStreamEvent] Merging reasoning into content, length=${reasoningContent.length}`);
            StructuredLogger.trace("stream.reasoning_merged", {
                length: reasoningContent.length,
            });
        }

        // Anthropic thinking blocks ride on the thinking deltas. Text-only
        // entries mirror the reasoning_content stream and are ignored here;
        // a signed entry seals its block (the text deltas already carried the
        // text) and a redacted entry replaces the text with opaque data.
        for (const block of extractRawThinkingBlocks(delta?.thinking_blocks)) {
            if (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) {
                const blockId = state.currentThinkingBlockId ?? nextThinkingBlockId(state);
                const blockText = typeof block.thinking === "string" ? block.thinking : "";
                thinkingParts.push({
                    type: "thinking",
                    value: "",
                    id: blockId,
                    metadata: signedThinkingMetadata(block.signature, blockText),
                });
                state.currentThinkingBlockId = undefined;
                Logger.trace(
                    `[interpretStreamEvent] Sealed thinking block (id: ${blockId}, text ${blockText.length} chars, signature ${block.signature.length} bytes)`
                );
            } else if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data.length > 0) {
                const redactedId = nextThinkingBlockId(state);
                thinkingParts.push({
                    type: "thinking",
                    value: "",
                    id: redactedId,
                    metadata: redactedThinkingMetadata(block.data),
                });
                Logger.trace(
                    `[interpretStreamEvent] Emitted redacted thinking block (id: ${redactedId}, ${block.data.length} bytes)`
                );
            }
        }

        const deltaContent = typeof delta?.content === "string" && delta.content ? delta.content : undefined;
        const contentForParsing = mergeReasoningIntoContent
            ? `${reasoningContent ?? ""}${deltaContent ?? ""}`
            : deltaContent;

        if (contentForParsing) {
            // The model's visible answer is emitted verbatim. Text that looks
            // like a tool-call marker stays text: only the structured
            // `delta.tool_calls` and /responses call events may trigger a tool.
            textParts.push({ type: "text", value: contentForParsing });
            Logger.trace(`[interpretStreamEvent] Emitted text part, length=${contentForParsing.length}`);
            StructuredLogger.trace("stream.text_emitted", {
                length: contentForParsing.length,
            });
        }

        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tcItem of delta.tool_calls) {
                const tc = tcItem as Record<string, unknown>;
                const index = (tc.index as number) ?? 0;
                let buffer = state.toolCallBuffers.get(index);

                // If we get a new ID for the same index, it's a new call; clear the old one.
                // A buffer still waiting for its id keeps what it already buffered, so the
                // id that arrives now attaches to it. This prevents corruption if
                // finish_reason was missed in a previous turn. Normalize incoming ID before
                // comparison since buffer stores normalized IDs
                const incomingId = tc.id ? normalizeToolCallId(tc.id as string) : undefined;
                if (incomingId && buffer && buffer.id && buffer.id !== incomingId) {
                    logDroppedToolCallBuffer(state, "replaced_by_new_id", index, buffer);
                    state.toolCallBuffers.delete(index);
                    buffer = undefined;
                }

                if (!buffer) {
                    const fn = tc.function as Record<string, unknown> | undefined;
                    // Normalize the tool call ID to ensure it meets OpenAI/LiteLLM requirements
                    // (starts with 'fc_' and is <= 40 chars)
                    const rawId = (tc.id as string) || "";
                    const newId = rawId ? normalizeToolCallId(rawId) : "";
                    // Skip if this tool call ID was already emitted in a previous turn
                    if (newId && state.emittedToolCallIds.has(newId)) {
                        Logger.trace(`[interpretStreamEvent] Skipping duplicate tool call ID: ${newId}`);
                        StructuredLogger.trace("stream.tool_call_skipped_duplicate", { id: newId });
                        continue;
                    }
                    const sanitizedName = resolveToolCallName(state, typeof fn?.name === "string" ? fn.name : "");
                    buffer = { id: newId, name: sanitizedName, args: toArgumentText(fn?.arguments) };
                    state.toolCallBuffers.set(index, buffer);
                    Logger.trace(`[interpretStreamEvent] Buffered new tool call: ${sanitizedName} (id: ${newId})`);
                    StructuredLogger.trace("stream.tool_call_buffered", {
                        toolName: fn?.name,
                        rawId,
                        normalizedId: newId,
                        index,
                    });
                } else {
                    if (tc.id) {
                        // Normalize the tool call ID when updating
                        const normalizedId = normalizeToolCallId(tc.id as string);
                        StructuredLogger.trace("stream.tool_call_id_updated", {
                            rawId: tc.id,
                            normalizedId,
                            index,
                        });
                        buffer.id = normalizedId;
                    }
                    const tcFn = tc.function as Record<string, unknown> | undefined;
                    if (typeof tcFn?.name === "string" && tcFn.name) {
                        buffer.name = resolveToolCallName(state, tcFn.name);
                    }
                    buffer.args += toArgumentText(tcFn?.arguments);
                }
            }
        }

        if (choice.finish_reason && typeof choice.finish_reason === "string") {
            toolCallParts.push(...settleChatToolCallBuffers(state, choice.finish_reason));

            finishParts.push({ type: "finish", reason: choice.finish_reason });
        }

        if (data.usage && typeof data.usage === "object") {
            dataParts.push({
                type: "data",
                mimeType: "usage",
                value: normalizeUsagePayload(data.usage as RawUsagePayload),
            });
        }
    }

    // Handle usage-only frames (OpenAI /responses sometimes emit standalone usage objects)
    if (!dataParts.length && data.usage && typeof data.usage === "object") {
        dataParts.push({
            type: "data",
            mimeType: "usage",
            value: normalizeUsagePayload(data.usage as RawUsagePayload),
        });
    }

    // 2. Handle LiteLLM /responses format
    interpretResponsesEvent(data, state, {
        text: textParts,
        toolCalls: toolCallParts,
        data: dataParts,
        response: responseParts,
        finish: finishParts,
    });

    // 3. Handle Gemini-style native format (sometimes passed through by LiteLLM)
    if (data.candidates && Array.isArray(data.candidates) && data.candidates[0]) {
        Logger.debug(`[interpretStreamEvent] Handling Gemini-format candidates`);
        const candidate = data.candidates[0] as Record<string, unknown>;
        const content = candidate.content as Record<string, unknown> | undefined;
        if (content && Array.isArray(content.parts) && content.parts[0]) {
            const part = content.parts[0] as Record<string, unknown>;
            if (typeof part.text === "string" && part.text) {
                Logger.trace(`[interpretStreamEvent] Gemini text part: ${part.text.length} chars`);
                textParts.push({ type: "text", value: part.text });
                StructuredLogger.trace("stream.gemini_text", {
                    length: part.text.length,
                });
            }
            const functionCall = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
            if (functionCall?.name) {
                const argsJson = JSON.stringify(functionCall.args ?? {});
                const resolvedName = resolveToolCallName(state, functionCall.name);
                Logger.trace(`[interpretStreamEvent] Gemini function call: ${resolvedName}`);
                toolCallParts.push({
                    type: "tool_call",
                    index: 0,
                    id: functionCall.id,
                    name: resolvedName,
                    args: argsJson,
                });
                StructuredLogger.trace("stream.gemini_function_call", {
                    name: resolvedName,
                    id: functionCall.id,
                    argsLength: argsJson.length,
                });
            }
        }
    }

    // Emit in deterministic order to match VS Code expectations
    const allParts = [...thinkingParts, ...textParts, ...toolCallParts, ...responseParts, ...dataParts, ...finishParts];
    Logger.trace(
        `[interpretStreamEvent] Returning ${allParts.length} parts: thinking=${thinkingParts.length} text=${textParts.length} toolCall=${toolCallParts.length} response=${responseParts.length} data=${dataParts.length} finish=${finishParts.length}`
    );
    StructuredLogger.trace("stream.event_interpretation_complete", {
        totalParts: allParts.length,
        thinkingParts: thinkingParts.length,
        textParts: textParts.length,
        toolCallParts: toolCallParts.length,
        responseParts: responseParts.length,
        dataParts: dataParts.length,
        finishParts: finishParts.length,
    });
    return allParts;
}

/**
 * Settles every buffered tool call at a stream end that carried no
 * `response.completed`, `response.incomplete`, or other finish frame.
 *
 * Emits:
 * - Named /responses-format tool calls with valid JSON arguments
 * - The anonymous tool call, when it has a name and valid JSON arguments
 * - The chat-completions tool calls a non-`tool_calls` finish frame would emit
 * - A finish part with reason "incomplete_stream_end"
 *
 *
 * A call with unreadable arguments is logged and recorded on `droppedToolCalls`
 * instead of emitted, so the turn can explain what did not run.
 * Returns an array of emitted parts in emission order.
 */
export function flushPendingBuffers(state: StreamingState): EmittedPart[] {
    const parts: EmittedPart[] = [];
    let toolCallIndex = 0;

    // 1. Flush /responses-format tool calls. VS Code invokes a tool by its name,
    // so a call that never received one cannot run.
    for (const id of state.responseToolCallOrder) {
        const buffer = state.responseToolCallBuffers.get(id);
        if (!buffer) {
            continue;
        }
        if (!buffer.name) {
            Logger.warn(`[flushPendingBuffers] ${requestTag(state)} Skipping unnamed /responses tool call (id: ${id})`);
            continue;
        }
        try {
            JSON.parse(buffer.args);
            parts.push({ type: "tool_call", index: toolCallIndex++, id, name: buffer.name, args: buffer.args });
            Logger.debug(`[flushPendingBuffers] Flushed /responses tool call: ${buffer.name} (id: ${id})`);
        } catch {
            Logger.warn(
                `[flushPendingBuffers] ${requestTag(state)} Skipping malformed /responses tool call args (id: ${id})`
            );
            StructuredLogger.error("stream.tool_call_args_invalid_json", {
                requestId: state.requestId,
                toolName: buffer.name,
                callId: id,
                argsLength: buffer.args.length,
                argsPreview: buffer.args.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS),
            });
            state.droppedToolCalls.push({ id, name: buffer.name });
        }
    }
    state.responseToolCallBuffers.clear();
    state.responseToolCallOrder = [];

    // 2. Flush anonymous tool call
    if (state.anonymousResponseToolName && state.anonymousResponseToolArgs) {
        try {
            JSON.parse(state.anonymousResponseToolArgs);
            parts.push({
                type: "tool_call",
                index: toolCallIndex++,
                id: `anonymous_${Date.now()}`,
                name: state.anonymousResponseToolName,
                args: state.anonymousResponseToolArgs,
            });
            Logger.debug(`[flushPendingBuffers] Flushed anonymous tool call: ${state.anonymousResponseToolName}`);
        } catch {
            Logger.warn(
                `[flushPendingBuffers] ${requestTag(state)} Skipping malformed anonymous tool call args (${state.anonymousResponseToolArgs.length} chars)`
            );
            StructuredLogger.error("stream.tool_call_args_invalid_json", {
                requestId: state.requestId,
                toolName: state.anonymousResponseToolName,
                argsLength: state.anonymousResponseToolArgs.length,
                argsPreview: state.anonymousResponseToolArgs.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS),
            });
            state.droppedToolCalls.push({
                id: `anonymous_${state.requestId ?? "stream"}`,
                name: state.anonymousResponseToolName,
            });
        }
    }
    state.anonymousResponseToolName = undefined;
    state.anonymousResponseToolArgs = "";

    // 3. Settle chat-completions buffers by the rules of a non-`tool_calls`
    // finish frame, so a call is never emitted without an id or a name, or
    // with invalid JSON arguments.
    parts.push(...settleChatToolCallBuffers(state, INCOMPLETE_STREAM_END));

    // 4. Emit finish with "incomplete_stream_end" reason to signal partial response
    Logger.debug(`[flushPendingBuffers] Emitting ${parts.length} flushed parts with incomplete_stream_end signal`);
    StructuredLogger.debug("stream.pending_buffers_flushed", {
        toolCallsEmitted: parts.filter((p) => p.type === "tool_call").length,
    });
    parts.push({
        type: "finish",
        reason: INCOMPLETE_STREAM_END,
    });

    return parts;
}
