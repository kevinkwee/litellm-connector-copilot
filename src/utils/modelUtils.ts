import type { LiteLLMModelInfo, ToolResultImageMode, ToolResultTextMode } from "../types";

/**
 * Provider families whose LiteLLM transforms read `image_url` parts from a
 * `role: "tool"` message. Providers outside this list stringify list content
 * and keep only the text, so images sent natively would be dropped.
 */
const NATIVE_TOOL_RESULT_IMAGE_PROVIDERS: readonly RegExp[] = [/anthropic/i, /gemini/i, /vertex/i, /bedrock/i];

/**
 * Provider families whose LiteLLM transforms keep the text items of a tool
 * result apart instead of concatenating them. Anthropic turns each item into its
 * own content block, and Bedrock keeps the items as separate entries.
 */
const SEPARATE_TOOL_RESULT_TEXT_PROVIDERS: readonly RegExp[] = [/anthropic/i, /bedrock/i];

/**
 * Picks the wire shape for the text parts of a tool result.
 *
 * Providers that keep the items apart receive one item per part, so two parts
 * never read as one run-on string. Every other provider, Gemini included, glues
 * list items together with no separator, so the parts are joined with a blank
 * line before sending. An unknown or missing provider joins, the shape every
 * OpenAI-compatible transform preserves.
 *
 * Responses API requests join as well: their tool output is a plain string, so
 * the adapter flattens any content array with no separator and separate items
 * would arrive run together.
 */
export function resolveToolResultTextMode(modelInfo?: LiteLLMModelInfo): ToolResultTextMode {
    if (modelInfo?.mode === "responses") {
        return "joined";
    }
    const provider = modelInfo?.litellm_provider;
    if (typeof provider === "string" && SEPARATE_TOOL_RESULT_TEXT_PROVIDERS.some((pattern) => pattern.test(provider))) {
        return "separate";
    }
    return "joined";
}

/**
 * Determine whether a model is an Anthropic/Claude model (provider or ID match).
 * These models often have specific constraints (e.g., no 'no-cache' support).
 */
export function isAnthropicModel(modelId: string, modelInfo?: LiteLLMModelInfo): boolean {
    if (modelInfo?.litellm_provider && /anthropic/i.test(modelInfo.litellm_provider)) {
        return true;
    }
    return /claude/i.test(modelId) || /anthropic/i.test(modelId);
}

/**
 * Determine whether a model is served by DeepSeek. DeepSeek's thinking mode
 * requires `reasoning_content` on every assistant turn in the active tool
 * loop, so only these models receive the empty-field fill.
 */
export function isDeepSeekModel(modelId: string, modelInfo?: LiteLLMModelInfo): boolean {
    if (modelInfo?.litellm_provider && /deepseek/i.test(modelInfo.litellm_provider)) {
        return true;
    }
    return /deepseek/i.test(modelId);
}

/**
 * Picks the wire shape for images that arrived inside a tool result.
 *
 * Responses API requests always hoist. Their tool output field is a plain
 * string, so the images ride along in a following user message instead of
 * widening the `function_call_output` shape.
 *
 * An unknown or missing provider hoists, which is the safe default: the images
 * still reach the model, whereas native content risks silent loss.
 */
export function resolveToolResultImageMode(modelInfo?: LiteLLMModelInfo): ToolResultImageMode {
    if (modelInfo?.mode === "responses") {
        return "hoist";
    }
    const provider = modelInfo?.litellm_provider;
    if (typeof provider === "string" && NATIVE_TOOL_RESULT_IMAGE_PROVIDERS.some((pattern) => pattern.test(provider))) {
        return "native";
    }
    return "hoist";
}
