import type { OpenAIUsageCompletionTokenDetails, OpenAIUsagePayload, OpenAIUsagePromptTokenDetails } from "../../types";

/**
 * Usage shapes LiteLLM forwards on the wire. LiteLLM normalizes provider usage
 * into the OpenAI field names (`prompt_tokens_details`, `completion_tokens_details`),
 * while /responses `response.completed` payloads keep the Responses names
 * (`input_token_details`, `output_token_details`). LiteLLM additionally carries
 * Anthropic prompt-cache counters both on the top level (`cache_creation_input_tokens`,
 * `cache_read_input_tokens`) and inside `prompt_tokens_details`
 * (`cache_creation_tokens`, `cached_tokens`).
 */
export interface RawUsagePayload {
    prompt_tokens?: number;
    completion_tokens?: number;
    system_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_creation_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    completion_tokens_details?: {
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
 * snapshot tracker and telemetry consume. Token details that arrive in either
 * naming convention are preserved; absent details are omitted so downstream
 * code never has to distinguish "not provided" from "provided as 0" except
 * for cached_tokens, where an explicit 0 is emitted when the provider sent an
 * empty prompt-token-details object.
 */
export function normalizeUsagePayload(usage: RawUsagePayload): OpenAIUsagePayload {
    const promptTokenDetails: OpenAIUsagePromptTokenDetails = {};
    // Cache-write precedence, most to least specific: LiteLLM's Anthropic
    // prompt_tokens_details spelling, the OpenAI-style detected variant, the
    // /responses input_token_details variant, and the top-level counter
    // Anthropic emits through LiteLLM stream frames.
    const cacheCreationTokens =
        usage.prompt_tokens_details?.cache_creation_tokens ??
        usage.prompt_tokens_details?.cache_creation_input_tokens ??
        usage.input_token_details?.cache_creation_input_tokens ??
        usage.cache_creation_input_tokens;
    if (typeof cacheCreationTokens === "number") {
        promptTokenDetails.cache_creation_input_tokens = cacheCreationTokens;
    }

    const cachedTokens =
        usage.prompt_tokens_details?.cached_tokens ??
        usage.input_token_details?.cached_tokens ??
        usage.cache_read_input_tokens;
    if (typeof cachedTokens === "number") {
        promptTokenDetails.cached_tokens = cachedTokens;
    } else if (usage.input_token_details !== undefined || usage.prompt_tokens_details !== undefined) {
        promptTokenDetails.cached_tokens = 0;
    }

    const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {};
    const reasoningTokens =
        usage.completion_tokens_details?.reasoning_tokens ?? usage.output_token_details?.reasoning_tokens;
    if (typeof reasoningTokens === "number") {
        completionTokenDetails.reasoning_tokens = reasoningTokens;
    }
    const toolTokens = usage.completion_tokens_details?.tool_tokens ?? usage.output_token_details?.tool_tokens;
    if (typeof toolTokens === "number") {
        completionTokenDetails.tool_tokens = toolTokens;
    }
    const acceptedPredictionTokens =
        usage.completion_tokens_details?.accepted_prediction_tokens ??
        usage.output_token_details?.accepted_prediction_tokens;
    if (typeof acceptedPredictionTokens === "number") {
        completionTokenDetails.accepted_prediction_tokens = acceptedPredictionTokens;
    }
    const rejectedPredictionTokens =
        usage.completion_tokens_details?.rejected_prediction_tokens ??
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
