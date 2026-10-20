import { isCacheControlMimeType, normalizeToolCallId } from "../../utils";
import { sanitizeToolName } from "../../utils/toolNameUtils";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";
import { redactedThinkingMetadata, signedThinkingMetadata } from "../../utils/thinkingBlocks";
import { normalizeUsagePayload, type RawUsagePayload } from "./usagePayload";
import { UpstreamStreamError } from "../../utils/transportRetry";

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
}

export function createInitialStreamingState(requestId?: string): StreamingState {
    return {
        requestId,
        toolCallBuffers: new Map(),
        emittedToolCallIds: new Set(),
        responseToolCallBuffers: new Map(),
        responseToolCallOrder: [],
        mergeReasoningContentInChoices: false,
        anonymousResponseToolName: undefined,
        anonymousResponseToolArgs: "",
        thinkingBlockCounter: 0,
        currentThinkingBlockId: undefined,
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

function requestTag(state: StreamingState): string {
    return `request=${state.requestId ?? "unknown"}`;
}

type DroppedToolCallReason = "replaced_by_new_id" | "incomplete_at_finish" | "invalid_json_args";

/**
 * Logs a chat-completions tool call discarded before it reaches VS Code. Without
 * this log the loss only surfaces downstream, as a missing tool call or a stream
 * misread as reasoning-only.
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
 * Returns a tool call part for each deliverable chat-completions buffer, logs
 * undeliverable ones as dropped, skips ids already emitted, and clears the
 * buffers. A call with invalid JSON arguments is deliverable only at a
 * `tool_calls` finish, where the model declares its calls complete.
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
            StructuredLogger.error("stream.tool_call_args_invalid_json", {
                requestId: state.requestId,
                toolName: buffer.name,
                normalizedId: buffer.id,
                index,
                finishReason,
                argsLength: buffer.args.length,
                argsPreview: buffer.args.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS),
            });
        }
        if (state.emittedToolCallIds.has(buffer.id)) {
            continue;
        }
        if (!isJsonValid && finishReason !== "tool_calls") {
            logDroppedToolCallBuffer(state, "invalid_json_args", index, buffer, finishReason);
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
 * chat-completions buffers, and output_item.done or response.completed settles
 * keyed /responses calls. A function_call output_item.done, or the
 * end-of-stream flush, settles an anonymous call.
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

/** Longest upstream error detail carried into the user-facing message. */
const UPSTREAM_ERROR_DETAIL_MAX_CHARS = 300;

function readText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Reads an HTTP status from an error frame. LiteLLM's ProxyException puts the
 * status in `code`, so a three-digit `code` counts; a symbolic code such as
 * `invalid_request_error` does not.
 */
function readUpstreamStatus(error: Record<string, unknown>): number | undefined {
    for (const candidate of [error.status, error.status_code, error.code]) {
        if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
            return candidate;
        }
        if (typeof candidate === "string" && /^\d{3}$/.test(candidate.trim())) {
            return Number(candidate.trim());
        }
    }
    return undefined;
}

function toUpstreamStreamError(error: unknown): UpstreamStreamError | undefined {
    if (typeof error === "string") {
        return new UpstreamStreamError(
            undefined,
            undefined,
            undefined,
            error.trim().slice(0, UPSTREAM_ERROR_DETAIL_MAX_CHARS) || undefined
        );
    }
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const record = error as Record<string, unknown>;
    const status = readUpstreamStatus(record);
    const code = readText(record.code);
    const type = readText(record.type);
    const detail = (readText(record.message) ?? readText(record.detail))?.slice(0, UPSTREAM_ERROR_DETAIL_MAX_CHARS);
    if (status === undefined && code === undefined && type === undefined && detail === undefined) {
        return undefined;
    }
    return new UpstreamStreamError(status, code, type, detail);
}

/**
 * Reads an in-stream failure frame. Recognized shapes:
 * - `{"error": {...}}`: the LiteLLM proxy's mid-stream failure after the
 *   response headers were already sent;
 * - `{"type": "error", ...}`: an OpenAI Responses API error event;
 * - `{"type": "response.failed", "response": {"error": {...}}}`.
 */
function extractUpstreamStreamError(data: Record<string, unknown>): UpstreamStreamError | undefined {
    if (data.type === "response.failed") {
        const response = data.response as Record<string, unknown> | undefined;
        return (
            toUpstreamStreamError(response?.error ?? response) ??
            new UpstreamStreamError(undefined, undefined, "response.failed", readText(data.message))
        );
    }
    if (data.error !== undefined && data.error !== null) {
        return (
            toUpstreamStreamError(data.error) ??
            new UpstreamStreamError(undefined, undefined, "error", readText(data.message))
        );
    }
    if (data.type === "error") {
        return (
            toUpstreamStreamError(data) ??
            new UpstreamStreamError(undefined, undefined, "error", readText(data.message))
        );
    }
    return undefined;
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

    // 0. Handle VS Code DataPart carrier objects. Cache-control carrier parts
    // are opaque prompt-cache metadata; if re-emitted, VS Code can preserve
    // them into the next request and the LLM sees the carrier instead of the
    // user's task. Literal text mentioning cache_control still flows through
    // the normal text branches below.
    if (typeof data.$mid === "number" && typeof data.mimeType === "string") {
        if (isCacheControlMimeType(data.mimeType)) {
            StructuredLogger.trace("stream.cache_control_carrier_dropped", { mimeType: data.mimeType });
            return [];
        }

        // Preserve the original payload value when present; fallback to the carrier itself.
        const carrierValue = Object.prototype.hasOwnProperty.call(data, "data")
            ? (data as { data: unknown }).data
            : data;

        dataParts.push({
            type: "data",
            mimeType: data.mimeType,
            value: carrierValue,
        });
        return dataParts;
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
                // This prevents corruption if finish_reason was missed in a previous turn.
                // Normalize incoming ID before comparison since buffer stores normalized IDs
                const incomingId = tc.id ? normalizeToolCallId(tc.id as string) : undefined;
                if (incomingId && buffer && buffer.id !== incomingId) {
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
                    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                    const { name: sanitizedName } = sanitizeToolName(fn?.name || "");
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
                        buffer.name = tcFn.name;
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
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        Logger.trace(`[interpretStreamEvent] Emitting /responses text delta: ${data.delta.length} chars`);
        textParts.push({ type: "text", value: data.delta });
        StructuredLogger.trace("stream.responses_text_delta", {
            length: data.delta.length,
        });
    }
    // 2b. Robust event shape: response.output_item.delta (keyed on item.call_id)
    // This is the event shape used by ResponsesClient — preserved here for providers
    // that stream tool args via output_item.delta rather than output_tool_call.*.
    if (data.type === "response.output_item.delta") {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : undefined;
            const name = typeof item.name === "string" ? item.name : undefined;
            const argsDelta = typeof item.arguments === "string" ? item.arguments : undefined;

            if (callId) {
                const existing = state.responseToolCallBuffers.get(callId) ?? { id: callId, name: undefined, args: "" };
                if (name) {
                    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                    const { name: sanitizedName } = sanitizeToolName(name);
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
                // No call_id yet — buffer anonymously (providers that stream args before id)
                if (name) {
                    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                    const { name: sanitizedName } = sanitizeToolName(name);
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

    // 2c. Legacy event shape: response.output_tool_call.* (keyed on delta.id)
    if (typeof data.type === "string" && data.type.startsWith("response.output_tool_call")) {
        const delta = data.delta as Record<string, unknown> | undefined;
        const id = typeof delta?.id === "string" ? delta.id : undefined;
        if (id) {
            Logger.trace(`[interpretStreamEvent] /responses legacy output_tool_call.* delta for id: ${id}`);
            const existing = state.responseToolCallBuffers.get(id) ?? { id, name: undefined, args: "" };
            if (typeof delta?.name === "string") {
                // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                const { name: sanitizedName } = sanitizeToolName(delta.name);
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
    if (data.type === "response.completed") {
        Logger.info(`[interpretStreamEvent] Received /responses response.completed event`);
        const response = data.response as
            | {
                  usage?: {
                      input_tokens?: number;
                      output_tokens?: number;
                      system_tokens?: number;
                      input_token_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
                      cache_creation_input_tokens?: number;
                      cache_read_input_tokens?: number;
                      output_token_details?: {
                          reasoning_tokens?: number;
                          tool_tokens?: number;
                          accepted_prediction_tokens?: number;
                          rejected_prediction_tokens?: number;
                      };
                  };
              }
            | undefined;
        responseParts.push({
            type: "response",
            usage: {
                inputTokens: response?.usage?.input_tokens,
                outputTokens: response?.usage?.output_tokens,
            },
        });
        // Flush buffered /responses tool calls
        let flushedToolCallCount = 0;
        for (const id of state.responseToolCallOrder) {
            const buffer = state.responseToolCallBuffers.get(id);
            if (!buffer) {
                continue;
            }
            if (buffer.name && buffer.args) {
                try {
                    JSON.parse(buffer.args);
                    Logger.trace(
                        `[interpretStreamEvent] Flushing /responses tool call: ${buffer.name} (id: ${buffer.id})`
                    );
                    toolCallParts.push({
                        type: "tool_call",
                        index: toolCallParts.length,
                        id: buffer.id,
                        name: buffer.name,
                        args: buffer.args,
                    });
                    flushedToolCallCount++;
                } catch {
                    // drop malformed tool call
                    Logger.warn(`[interpretStreamEvent] Dropped malformed tool call args for ${buffer.name}`);
                }
            }
        }
        state.responseToolCallBuffers.clear();
        state.responseToolCallOrder = [];
        Logger.trace(`[interpretStreamEvent] Flushed ${flushedToolCallCount} tool calls on response.completed`);

        if (typeof response?.usage?.input_tokens === "number" || typeof response?.usage?.output_tokens === "number") {
            const usageValue = normalizeUsagePayload({
                prompt_tokens: response?.usage?.input_tokens,
                completion_tokens: response?.usage?.output_tokens,
                system_tokens: response?.usage?.system_tokens,
                input_token_details: response?.usage?.input_token_details,
                output_token_details: response?.usage?.output_token_details,
                cache_creation_input_tokens: response?.usage?.cache_creation_input_tokens,
                cache_read_input_tokens: response?.usage?.cache_read_input_tokens,
            });

            if (!usageValue.prompt_tokens_details) {
                usageValue.prompt_tokens_details = { cached_tokens: 0 };
            }
            if (!usageValue.completion_tokens_details) {
                usageValue.completion_tokens_details = { reasoning_tokens: 0 };
            }

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
                // list so response.completed does not double-emit it.
                const buffer = state.responseToolCallBuffers.get(callId);
                const name = nameFromDone ?? buffer?.name;
                const args = argsFromDone ?? buffer?.args;
                Logger.trace(
                    `[interpretStreamEvent] Flushing keyed tool call on output_item.done: ${name} (id: ${callId})`
                );
                if (name && args) {
                    try {
                        JSON.parse(args);
                        toolCallParts.push({
                            type: "tool_call",
                            index: toolCallParts.length,
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
                        // drop malformed tool call
                        Logger.warn(`[interpretStreamEvent] Dropped malformed tool call ${name} on output_item.done`);
                    }
                }
                state.responseToolCallBuffers.delete(callId);
                state.responseToolCallOrder = state.responseToolCallOrder.filter((id) => id !== callId);
            } else {
                // Anonymous tool call (no stable call_id) — emit best-effort from anonymous buffer.
                // Preserved from ResponsesClient for providers that never emit a call_id.
                const name = nameFromDone ?? state.anonymousResponseToolName;
                const args = argsFromDone ?? state.anonymousResponseToolArgs;
                Logger.trace(`[interpretStreamEvent] Flushing anonymous tool call on output_item.done: ${name}`);
                if (name && args) {
                    try {
                        JSON.parse(args);
                        toolCallParts.push({
                            type: "tool_call",
                            index: toolCallParts.length,
                            id: "anonymous",
                            name,
                            args,
                        });
                        StructuredLogger.trace("stream.responses_anonymous_tool_done", {
                            name,
                            argsLength: args.length,
                        });
                    } catch {
                        // drop malformed tool call
                        Logger.warn(`[interpretStreamEvent] Dropped malformed anonymous tool call ${name}`);
                    }
                }
            }

            // Reset anonymous buffer regardless of whether we emitted
            state.anonymousResponseToolName = undefined;
            state.anonymousResponseToolArgs = "";
        } else {
            // No function_call item (e.g., text item, or no item at all) — legacy flush-all.
            // Preserves backward compat with output_tool_call.* path which relies on
            // output_item.done to drain all buffered calls when no response.completed follows.
            Logger.debug(`[interpretStreamEvent] Legacy flush-all on output_item.done (non-function_call item)`);
            let legacyFlushedCount = 0;
            for (const id of state.responseToolCallOrder) {
                const buffer = state.responseToolCallBuffers.get(id);
                if (!buffer) {
                    continue;
                }
                if (buffer.name && buffer.args) {
                    try {
                        JSON.parse(buffer.args);
                        Logger.trace(
                            `[interpretStreamEvent] Legacy flushed tool call: ${buffer.name} (id: ${buffer.id})`
                        );
                        toolCallParts.push({
                            type: "tool_call",
                            index: toolCallParts.length,
                            id: buffer.id,
                            name: buffer.name,
                            args: buffer.args,
                        });
                        legacyFlushedCount++;
                    } catch {
                        // drop malformed tool call
                        Logger.warn(
                            `[interpretStreamEvent] Dropped malformed tool call ${buffer.name} on legacy flush`
                        );
                    }
                }
            }
            state.responseToolCallBuffers.clear();
            state.responseToolCallOrder = [];
            Logger.debug(`[interpretStreamEvent] Legacy flushed ${legacyFlushedCount} tool calls on output_item.done`);
            StructuredLogger.trace("stream.responses_legacy_flush", {
                toolCallsEmitted: legacyFlushedCount,
            });
        }

        finishParts.push({ type: "finish" });
    }

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
                Logger.trace(`[interpretStreamEvent] Gemini function call: ${functionCall.name}`);
                toolCallParts.push({
                    type: "tool_call",
                    index: 0,
                    id: functionCall.id,
                    name: functionCall.name,
                    args: argsJson,
                });
                StructuredLogger.trace("stream.gemini_function_call", {
                    name: functionCall.name,
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
 * response.completed or finish frame.
 *
 * Emits:
 * - Named /responses-format tool calls with valid JSON arguments
 * - The anonymous tool call, when it has a name and valid JSON arguments
 * - The chat-completions tool calls a non-`tool_calls` finish frame would emit
 * - A finish part with reason "incomplete_stream_end"
 *
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
