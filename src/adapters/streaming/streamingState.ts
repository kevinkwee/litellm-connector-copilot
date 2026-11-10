/**
 * The stream state both endpoints of the interpreter share, the shape of the parts it
 * emits, and the helpers over that state.
 *
 * They live here rather than in either endpoint module because the chat-completions path
 * and the `/responses` path both use them.
 */

import { sanitizeToolName } from "../../utils/toolNameUtils";
import type { DroppedToolCall } from "../../types";

/** One part the stream interpreter emits: content for VS Code, or a signal the emission path reads. */
export type EmittedPart =
    | { type: "text"; value: string }
    | { type: "data"; mimeType: string; value: unknown }
    | { type: "thinking"; value: string | string[]; id?: string; metadata?: Record<string, unknown> }
    | { type: "tool_call"; index: number; id?: string; name?: string; args: string }
    | { type: "finish"; reason?: string }
    | { type: "response"; usage?: { inputTokens?: number; outputTokens?: number } };

export interface ChatToolCallBuffer {
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
    mergeReasoningContentInChoices: boolean;
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
     * Calls dropped because their arguments were not a JSON object. The stream reader names
     * them in a notice when the attempt completes; an attempt that throws, for a retry or a
     * failure, discards them.
     */
    readonly droppedToolCalls: DroppedToolCall[];
}

/**
 * Starts the state for one attempt.
 *
 * `thinkingBlockStart` is the last block number an earlier attempt of the same request
 * used, so a retry numbers its blocks onwards instead of reusing `litellm-thinking-1`,
 * which the host would merge into the earlier reasoning item.
 */
export function createInitialStreamingState(
    requestId?: string,
    wireToDeclaredNames?: ReadonlyMap<string, string>,
    thinkingBlockStart = 0
): StreamingState {
    return {
        requestId,
        wireToDeclaredNames,
        toolCallBuffers: new Map(),
        emittedToolCallIds: new Set(),
        mergeReasoningContentInChoices: false,
        thinkingBlockCounter: thinkingBlockStart,
        currentThinkingBlockId: undefined,
        droppedToolCalls: [],
    };
}

/** Formats the request id into a log tag, so concurrent streams stay distinguishable. */
export function requestTag(state: StreamingState): string {
    return `request=${state.requestId ?? "unknown"}`;
}

/**
 * Translates a tool name the model sent into the name VS Code declared for it.
 *
 * The request advertised sanitized, deduplicated names, so the model's call carries a
 * wire name. A model-invented or mangled name is normalized again so it stays
 * wire-safe, and the per-request map then recovers the declared spelling.
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

/** Starts a new thinking block id, so a later seal cannot rewrite an earlier block. */
export function nextThinkingBlockId(state: StreamingState): string {
    state.thinkingBlockCounter += 1;
    return `litellm-thinking-${state.thinkingBlockCounter}`;
}

/**
 * The id of the block the current reasoning deltas belong to, starting one when the
 * stream has none yet. Reusing it is what keeps one reply's thinking in one part.
 */
export function ensureCurrentThinkingBlockId(state: StreamingState): string {
    if (state.currentThinkingBlockId === undefined) {
        state.currentThinkingBlockId = nextThinkingBlockId(state);
    }
    return state.currentThinkingBlockId;
}
