import type * as vscode from "vscode";
import type { LiteLLMModelInfo, OpenAIChatMessage } from "../types";
import { selectTokenizer } from "./tokenizers/selectTokenizer";

// Token estimation constants for binary media types
// These are conservative estimates to avoid context window overflow

/** Base token cost for any image (OpenAI low-detail equivalent) */
const IMAGE_TOKEN_BASE = 85;

/** Approximate bytes per token for base64-encoded image data */
const IMAGE_BYTES_PER_TOKEN = 750;

/** Conservative bytes-per-token for PDF content (text-equivalent) */
const PDF_BYTES_PER_TOKEN = 4;

/** Minimum token cost for any non-empty PDF (processing overhead) */
const PDF_MINIMUM_TOKENS = 100;

/**
 * Estimates token cost for binary media data (images, PDFs).
 * Uses conservative heuristics to avoid underestimating context usage.
 *
 * @param mimeType - The MIME type of the data
 * @param dataLength - The length of the binary data in bytes
 * @returns Estimated token count for the media content
 */
export function estimateMediaTokenCost(mimeType: string, dataLength: number): number {
    if (dataLength <= 0) {
        return 0;
    }

    // Image types: base cost + scaling by data size
    if (mimeType.startsWith("image/")) {
        return IMAGE_TOKEN_BASE + Math.ceil(dataLength / IMAGE_BYTES_PER_TOKEN);
    }

    // PDF: treat as text-equivalent with minimum overhead
    if (mimeType === "application/pdf") {
        return Math.max(PDF_MINIMUM_TOKENS, Math.ceil(dataLength / PDF_BYTES_PER_TOKEN));
    }

    // Unsupported binary type: return 0 (caller may handle differently)
    return 0;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;
const SMART_OUTPUT_RESERVATION_MIN = 16000;
const SMART_OUTPUT_RESERVATION_MAX = 64000;

interface OutputReservationOptions {
    estimatedInputTokens?: number;
    modelInfo?: LiteLLMModelInfo;
}

/**
 * Centralized token counting utility.
 */
export function countTokens(
    input: string | vscode.LanguageModelChatRequestMessage | readonly vscode.LanguageModelChatRequestMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    const tokenizer = selectTokenizer(modelId || "default", modelInfo);
    if (typeof input === "string") {
        return tokenizer.countTokens(input).tokens;
    }
    if (Array.isArray(input)) {
        let total = 0;
        for (const m of input) {
            total += tokenizer.countMessageTokens(m).tokens;
        }
        return total;
    }
    return tokenizer.countMessageTokens(input as vscode.LanguageModelChatRequestMessage).tokens;
}

/**
 * Estimates the token cost of an `image_url` content item.
 *
 * A data URI is sized from its base64 payload. A remote URL is charged only the
 * base image cost because its bytes are not available while counting.
 * @param url Image URL carried by the content item.
 */
function estimateImagePartTokens(url: string): number {
    const dataUriMatch = /^data:([^;,]+);base64,/i.exec(url);
    if (!dataUriMatch) {
        return IMAGE_TOKEN_BASE;
    }
    const byteLength = Math.ceil(((url.length - dataUriMatch[0].length) * 3) / 4);
    return estimateMediaTokenCost(dataUriMatch[1], byteLength) || IMAGE_TOKEN_BASE;
}

/**
 * Counts tokens for the OpenAI-style transport messages that the request sends
 * to LiteLLM after message conversion.
 */
export function countOpenAIChatMessagesTokens(
    messages: readonly OpenAIChatMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    const tokenizer = selectTokenizer(modelId || "default", modelInfo);
    let total = 0;

    for (const message of messages) {
        if (typeof message.content === "string") {
            total += tokenizer.countTokens(message.content).tokens;
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text" && typeof part.text === "string") {
                    total += tokenizer.countTokens(part.text).tokens;
                } else if (part.type === "image_url" && typeof part.image_url?.url === "string") {
                    total += estimateImagePartTokens(part.image_url.url);
                }
            }
        }

        if (typeof message.name === "string" && message.name.length > 0) {
            total += tokenizer.countTokens(message.name).tokens;
        }

        if (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0) {
            total += tokenizer.countTokens(message.tool_call_id).tokens;
        }

        if (Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                total += tokenizer.countTokens(toolCall.function.name).tokens;
                total += tokenizer.countTokens(toolCall.function.arguments).tokens;
            }
        }

        // Replayed reasoning travels to the model, so it occupies prompt budget.
        // A redacted block carries opaque data instead of text, so the estimate
        // counts only readable thinking.
        if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
            total += tokenizer.countTokens(message.reasoning_content).tokens;
        }
        if (Array.isArray(message.thinking_blocks)) {
            for (const block of message.thinking_blocks) {
                if (block.type !== "thinking" || typeof block.thinking !== "string") {
                    continue;
                }
                if (block.thinking.length > 0) {
                    total += tokenizer.countTokens(block.thinking).tokens;
                }
            }
        }
    }

    return total;
}

/**
 * Resolves the number of tokens reserved for model output in a request.
 */
export function getReservedOutputTokens(
    model: vscode.LanguageModelChatInformation,
    requestedMaxTokens?: number,
    options?: OutputReservationOptions
): number {
    if (typeof requestedMaxTokens === "number") {
        return Math.max(1, Math.min(requestedMaxTokens, model.maxOutputTokens));
    }

    const estimatedInputTokens =
        typeof options?.estimatedInputTokens === "number" && options.estimatedInputTokens > 0
            ? options.estimatedInputTokens
            : 0;
    const totalTokenLimit = getTotalTokenLimit(model, options?.modelInfo);

    // A "smart reservation" target in the requested 16k..64k range.
    // Larger requests reserve a larger output window, but we always clamp to model limits.
    const ratio = Math.min(1, estimatedInputTokens / 48000);
    const smartTarget = Math.round(
        SMART_OUTPUT_RESERVATION_MIN + (SMART_OUTPUT_RESERVATION_MAX - SMART_OUTPUT_RESERVATION_MIN) * ratio
    );

    // Keep a small structural headroom so output reservation does not completely consume the
    // context window when input is already large.
    const structuralHeadroom = 256;
    const remainingContextWindow = Math.max(1, totalTokenLimit - estimatedInputTokens - structuralHeadroom);

    return Math.max(1, Math.min(model.maxOutputTokens, smartTarget, remainingContextWindow));
}

/**
 * Resolves the total token window for the model.
 */
export function getTotalTokenLimit(model: vscode.LanguageModelChatInformation, modelInfo?: LiteLLMModelInfo): number {
    const rawLimit = modelInfo?.max_input_tokens ?? modelInfo?.context_window_tokens ?? modelInfo?.max_tokens;
    if (typeof rawLimit === "number" && rawLimit > 0) {
        return rawLimit;
    }
    return Math.max(1, model.maxInputTokens + model.maxOutputTokens);
}

/**
 * Rough token estimate for tool definitions by JSON size.
 */
export function estimateToolTokens(
    tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
): number {
    if (!tools || tools.length === 0) {
        return 0;
    }
    try {
        const json = JSON.stringify(tools);
        return Math.ceil(json.length / 4);
    } catch {
        return 0;
    }
}
