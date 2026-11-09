import type { LiteLLMModelInfo, SupportedReasoningEffort } from "../types";

/**
 * The reasoning-effort levels the connector understands, in ascending order.
 *
 * The order is the picker's, and its last entry is the default a model with no declared
 * levels receives, so the list must stay ascending. One list serves both the picker and
 * the request gate, because a level the picker offers and the request drops is the
 * defect this table exists to prevent.
 */
export const CANONICAL_REASONING_EFFORTS: readonly SupportedReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

/**
 * The highest level an ascending effort list offers, or `undefined` for an empty list.
 *
 * The picker's list is ordered, and its last entry is the default a model receives, so
 * this one rule serves the picker and `modelOverrides` alike.
 */
export function highestReasoningEffort(
    efforts: readonly SupportedReasoningEffort[]
): SupportedReasoningEffort | undefined {
    return efforts.length > 0 ? efforts[efforts.length - 1] : undefined;
}

/**
 * The `/model/info` flag that declares each reasoning-effort level.
 *
 * The proxy's model config declares every level a model accepts, and nothing implies a
 * level it does not declare, so this mapping is the whole vocabulary.
 */
export const REASONING_EFFORT_FLAGS: Readonly<Record<string, SupportedReasoningEffort>> = {
    supports_none_reasoning_effort: "none",
    supports_minimal_reasoning_effort: "minimal",
    supports_low_reasoning_effort: "low",
    supports_medium_reasoning_effort: "medium",
    supports_high_reasoning_effort: "high",
    supports_xhigh_reasoning_effort: "xhigh",
    supports_max_reasoning_effort: "max",
};

/**
 * The levels a model's config declares, in ascending order, or `undefined` when it
 * carries no effort flag at all.
 *
 * A flag set to `false` still counts as a declaration, so a model whose config sets every
 * level to `false` offers none instead of falling back to the full list.
 */
export function readDeclaredReasoningEfforts(modelInfo?: LiteLLMModelInfo): SupportedReasoningEffort[] | undefined {
    if (!modelInfo) {
        return undefined;
    }

    const declared = new Set<SupportedReasoningEffort>();
    let hasAnyEffortFlag = false;
    for (const [flag, level] of Object.entries(REASONING_EFFORT_FLAGS)) {
        const value = modelInfo[flag as keyof LiteLLMModelInfo];
        if (value === true) {
            declared.add(level);
        }
        if (value !== undefined && value !== null) {
            hasAnyEffortFlag = true;
        }
    }

    return hasAnyEffortFlag ? CANONICAL_REASONING_EFFORTS.filter((level) => declared.has(level)) : undefined;
}
