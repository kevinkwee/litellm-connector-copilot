import type { AnthropicCacheControlDirective, AnthropicPromptCachingMode, LiteLLMModelInfo } from "../types";

export const DEFAULT_ANTHROPIC_PROMPT_CACHING: AnthropicPromptCachingMode = "5m";

const PROMPT_CACHING_MODES: readonly string[] = ["off", "5m", "1h"];

export interface AnthropicPromptCachingInput {
    mode: AnthropicPromptCachingMode;
    modelId: string;
    modelInfo?: LiteLLMModelInfo;
    /** Per-request opt-out (commit generation has no reusable prefix worth caching). */
    requestOptOut?: boolean;
}

/**
 * Tests for the Anthropic family, with discovery info treated as
 * authoritative: a model id that merely says "claude" sent through a
 * non-Anthropic gateway must not receive the marker (the gateway would
 * reject it as an unknown field).
 */
function isAnthropicProvider(modelId: string, modelInfo?: LiteLLMModelInfo): boolean {
    if (modelInfo?.litellm_provider) {
        return /anthropic/i.test(modelInfo.litellm_provider);
    }
    return /claude|anthropic/i.test(modelId);
}

export function normalizeAnthropicPromptCachingMode(value: unknown): AnthropicPromptCachingMode {
    return typeof value === "string" && PROMPT_CACHING_MODES.includes(value)
        ? (value as AnthropicPromptCachingMode)
        : DEFAULT_ANTHROPIC_PROMPT_CACHING;
}

/**
 * Resolves the Anthropic prompt-caching directive for a request. Returns
 * undefined for non-Anthropic models, disabled or opted-out requests, and
 * models whose info explicitly declares `supports_prompt_caching: false`.
 * The 5-minute tier omits `ttl` because it is the API default.
 */
export function resolveAnthropicCacheControl(
    input: AnthropicPromptCachingInput
): AnthropicCacheControlDirective | undefined {
    if (input.mode === "off" || input.requestOptOut === true) {
        return undefined;
    }
    if (!isAnthropicProvider(input.modelId, input.modelInfo)) {
        return undefined;
    }
    if (input.modelInfo?.supports_prompt_caching === false) {
        return undefined;
    }
    return input.mode === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
