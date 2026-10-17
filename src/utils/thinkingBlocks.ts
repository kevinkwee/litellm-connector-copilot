import type { OpenAIThinkingBlock } from "../types";

/**
 * Metadata carried on LanguageModelThinkingPart parts so the thinking block
 * can be replayed verbatim into later Anthropic requests. The keys are also
 * persisted by Copilot's Agents-window reasoning handler when it re-encodes
 * part metadata, so a block that streamed through this connector survives
 * both the tool-call loop and cross-session replay.
 *
 * - `signature`: Anthropic's per-block signature. Replay requires the exact
 *   bytes, so the value is stored and forwarded without any transformation.
 * - `_completeThinking`: the full text of the block at the moment it was
 *   sealed, replacing the concatenated incremental deltas. An empty string is
 *   valid (Anthropic sends omitted-display blocks as text-less signed blocks)
 *   and must be replayed as an empty thinking field.
 * - `redactedData`: the opaque `redacted_thinking` payload; no text exists.
 */
export type ThinkingPartMetadata = Record<string, unknown>;

export interface ThinkingPartLike {
    readonly id?: string;
    readonly metadata?: ThinkingPartMetadata;
    readonly value: string | string[];
}

const SIGNATURE_KEY = "signature";
const COMPLETE_THINKING_KEY = "_completeThinking";
const REDACTED_DATA_KEY = "redactedData";

/**
 * Metadata for a signed thinking block. `completeThinking` holds the block's
 * full text (`""` when the model streamed no visible text, and it must be
 * replayed as an empty thinking field rather than dropped, because omitted-
 * display blocks are valid).
 */
export function signedThinkingMetadata(signature: string, completeThinking: string): ThinkingPartMetadata {
    return { [SIGNATURE_KEY]: signature, [COMPLETE_THINKING_KEY]: completeThinking };
}

/** Metadata for a safety-redacted thinking block (encrypted payload, no text). */
export function redactedThinkingMetadata(data: string): ThinkingPartMetadata {
    return { [REDACTED_DATA_KEY]: data };
}

function readStringMetadata(metadata: unknown, key: string): string | undefined {
    if (metadata === undefined || metadata === null || typeof metadata !== "object") {
        return undefined;
    }
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

/** The Anthropic signature carried on a thinking part, when it has one. */
export function readThinkingSignature(part: ThinkingPartLike): string | undefined {
    return readStringMetadata(part.metadata, SIGNATURE_KEY);
}

/** The redacted-block payload carried on a thinking part, when it has one. */
export function readRedactedData(part: ThinkingPartLike): string | undefined {
    return readStringMetadata(part.metadata, REDACTED_DATA_KEY);
}

/**
 * The block text a signed part should replay with. Prefers the sealed
 * `_completeThinking` snapshot over concatenated incremental deltas, and falls
 * back to the part's own text for foreign metadata that carries only a
 * signature.
 */
function readBlockText(part: ThinkingPartLike): string {
    const complete = readStringMetadata(part.metadata, COMPLETE_THINKING_KEY);
    if (complete !== undefined) {
        return complete;
    }
    return Array.isArray(part.value) ? part.value.join("") : part.value;
}

/**
 * Builds the Anthropic thinking blocks an assistant turn can replay. Every
 * signed or redacted part becomes one block in the order the parts were
 * emitted; parts without either marker return no block so the caller keeps
 * them on the plain `reasoning_content` path.
 */
export function buildThinkingBlocks(parts: readonly ThinkingPartLike[]): OpenAIThinkingBlock[] {
    const blocks: OpenAIThinkingBlock[] = [];
    for (const part of parts) {
        const signature = readThinkingSignature(part);
        if (signature !== undefined && signature.length > 0) {
            blocks.push({ type: "thinking", thinking: readBlockText(part), signature });
            continue;
        }
        const redactedData = readRedactedData(part);
        if (redactedData !== undefined && redactedData.length > 0) {
            blocks.push({ type: "redacted_thinking", data: redactedData });
        }
    }
    return blocks;
}
