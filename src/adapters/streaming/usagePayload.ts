import type { OpenAIUsageCompletionTokenDetails, OpenAIUsagePayload, OpenAIUsagePromptTokenDetails } from "../../types";

/**
 * Usage shapes LiteLLM forwards on the wire. LiteLLM normalizes provider usage
 * into the OpenAI field names (`prompt_tokens_details`, `completion_tokens_details`),
 * while /responses `response.completed` and `response.incomplete` payloads keep
 * the Responses names. LiteLLM's `ResponseAPIUsage` spells the Responses detail
 * objects `input_tokens_details` and `output_tokens_details`, and older gateways
 * send the singular `input_token_details` and `output_token_details`, so both are
 * read. LiteLLM additionally carries Anthropic prompt-cache counters both on
 * the top level (`cache_creation_input_tokens`, `cache_read_input_tokens`) and
 * inside `prompt_tokens_details` (`cache_creation_tokens`, `cached_tokens`).
 */
export interface RawUsagePayload {
    prompt_tokens?: number;
    completion_tokens?: number;
    system_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_creation_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_creation_token_details?: {
            ephemeral_5m_input_tokens?: number;
            ephemeral_1h_input_tokens?: number;
        };
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        tool_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
    };
    input_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
    output_tokens_details?: {
        reasoning_tokens?: number;
        tool_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
    };
    input_token_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
    output_token_details?: {
        reasoning_tokens?: number;
        tool_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
    };
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/**
 * Maps a raw usage payload onto the normalized OpenAI field names the
 * snapshot tracker and telemetry consume. Token details that arrive in any of
 * LiteLLM's spellings are preserved. A detail object that carries no counts
 * contributes nothing, except a prompt-detail object, which still reports
 * `cached_tokens: 0`.
 */
export function normalizeUsagePayload(usage: RawUsagePayload): OpenAIUsagePayload {
    const promptTokenDetails: OpenAIUsagePromptTokenDetails = {};
    // Cache-write precedence, most to least specific: LiteLLM's Anthropic
    // prompt_tokens_details spelling, the OpenAI-style detected variant, the
    // /responses detail objects in both spellings, and the top-level counter
    // Anthropic emits through LiteLLM stream frames.
    const cacheCreationTokens =
        usage.prompt_tokens_details?.cache_creation_tokens ??
        usage.prompt_tokens_details?.cache_creation_input_tokens ??
        usage.input_tokens_details?.cache_creation_input_tokens ??
        usage.input_token_details?.cache_creation_input_tokens ??
        usage.cache_creation_input_tokens;
    if (typeof cacheCreationTokens === "number") {
        promptTokenDetails.cache_creation_input_tokens = cacheCreationTokens;
    }
    // Anthropic bills the five-minute and one-hour cache tiers differently, and
    // the proxy reports the split here. Passing it through lets the cost estimate
    // price each tier on its own rate.
    const cacheCreationTokenDetails = usage.prompt_tokens_details?.cache_creation_token_details;
    if (cacheCreationTokenDetails !== undefined) {
        const details: OpenAIUsagePromptTokenDetails["cache_creation_token_details"] = {};
        if (typeof cacheCreationTokenDetails.ephemeral_5m_input_tokens === "number") {
            details.ephemeral_5m_input_tokens = cacheCreationTokenDetails.ephemeral_5m_input_tokens;
        }
        if (typeof cacheCreationTokenDetails.ephemeral_1h_input_tokens === "number") {
            details.ephemeral_1h_input_tokens = cacheCreationTokenDetails.ephemeral_1h_input_tokens;
        }
        if (Object.keys(details).length > 0) {
            promptTokenDetails.cache_creation_token_details = details;
        }
    }

    const cachedTokens =
        usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens ??
        usage.input_token_details?.cached_tokens ??
        usage.cache_read_input_tokens;
    if (typeof cachedTokens === "number") {
        promptTokenDetails.cached_tokens = cachedTokens;
    } else if (
        usage.input_tokens_details !== undefined ||
        usage.input_token_details !== undefined ||
        usage.prompt_tokens_details !== undefined
    ) {
        promptTokenDetails.cached_tokens = 0;
    }

    const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {};
    const reasoningTokens =
        usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens ??
        usage.output_token_details?.reasoning_tokens;
    if (typeof reasoningTokens === "number") {
        completionTokenDetails.reasoning_tokens = reasoningTokens;
    }
    const toolTokens =
        usage.completion_tokens_details?.tool_tokens ??
        usage.output_tokens_details?.tool_tokens ??
        usage.output_token_details?.tool_tokens;
    if (typeof toolTokens === "number") {
        completionTokenDetails.tool_tokens = toolTokens;
    }
    const acceptedPredictionTokens =
        usage.completion_tokens_details?.accepted_prediction_tokens ??
        usage.output_tokens_details?.accepted_prediction_tokens ??
        usage.output_token_details?.accepted_prediction_tokens;
    if (typeof acceptedPredictionTokens === "number") {
        completionTokenDetails.accepted_prediction_tokens = acceptedPredictionTokens;
    }
    const rejectedPredictionTokens =
        usage.completion_tokens_details?.rejected_prediction_tokens ??
        usage.output_tokens_details?.rejected_prediction_tokens ??
        usage.output_token_details?.rejected_prediction_tokens;
    if (typeof rejectedPredictionTokens === "number") {
        completionTokenDetails.rejected_prediction_tokens = rejectedPredictionTokens;
    }

    const normalized: OpenAIUsagePayload = {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    };

    if (Object.keys(promptTokenDetails).length > 0) {
        normalized.prompt_tokens_details = promptTokenDetails;
    }
    if (Object.keys(completionTokenDetails).length > 0) {
        normalized.completion_tokens_details = completionTokenDetails;
    }
    if (typeof usage.system_tokens === "number") {
        normalized.system_prompt_tokens = usage.system_tokens;
    }

    return normalized;
}
