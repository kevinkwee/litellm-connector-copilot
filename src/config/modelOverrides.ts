import * as vscode from "vscode";
import type { LiteLLMModelInfo, ModelOverride, SupportedReasoningEffort } from "../types";
import { Logger } from "../utils/logger";
import { CANONICAL_REASONING_EFFORTS, highestReasoningEffort, readDeclaredReasoningEfforts } from "./reasoningEfforts";
import bundledOverridesSource from "./modelOverrides.json";

const bundledOverridesData: unknown = bundledOverridesSource;

const MODEL_OVERRIDES_SETTING_KEY = "litellm-connector.modelOverrides";

let bundledOverridesCache: ModelOverride[] | undefined;

/** True for a level the connector's single effort table knows. */
function isSupportedReasoningEffort(value: unknown): value is SupportedReasoningEffort {
    return typeof value === "string" && (CANONICAL_REASONING_EFFORTS as readonly string[]).includes(value);
}

function normalizeEfforts(efforts: unknown): SupportedReasoningEffort[] | undefined {
    if (!Array.isArray(efforts)) {
        return undefined;
    }

    const normalized = efforts.filter(isSupportedReasoningEffort);
    if (normalized.length === 0) {
        return undefined;
    }
    // The default is the last entry, so a hand-written override such as
    // `["high", "low"]` is ordered by the canonical ranking rather than left in
    // its declared order.
    return CANONICAL_REASONING_EFFORTS.filter((effort) => normalized.includes(effort));
}

function validateOverride(entry: unknown, source: string): ModelOverride | undefined {
    if (!entry || typeof entry !== "object") {
        Logger.warn(`[modelOverrides] Skipping invalid override from ${source}: not an object`);
        return undefined;
    }

    const candidate = entry as Partial<ModelOverride>;

    if (!candidate.match || typeof candidate.match !== "string") {
        Logger.warn(`[modelOverrides] Skipping invalid override from ${source}: missing match`);
        return undefined;
    }

    try {
        RegExp(candidate.match);
    } catch {
        Logger.warn(`[modelOverrides] Skipping invalid override regex from ${source}: ${candidate.match}`);
        return undefined;
    }

    const supportsReasoning =
        candidate.supportsReasoning === true ||
        candidate.supportsReasoning === false ||
        candidate.supportsReasoning === null
            ? candidate.supportsReasoning
            : null;

    const reasoningEfforts = normalizeEfforts(candidate.reasoningEfforts);
    const defaultEffort =
        candidate.defaultEffort && isSupportedReasoningEffort(candidate.defaultEffort)
            ? candidate.defaultEffort
            : undefined;

    return {
        match: candidate.match,
        supportsReasoning,
        reasoningEfforts,
        defaultEffort,
        forceMandatory: candidate.forceMandatory === true,
        notes: candidate.notes,
    };
}

export function loadBundledOverrides(): ModelOverride[] {
    if (bundledOverridesCache) {
        return bundledOverridesCache;
    }

    const validated = (Array.isArray(bundledOverridesData) ? bundledOverridesData : []).map((entry) =>
        validateOverride(entry, "bundled")
    );

    bundledOverridesCache = validated.filter((entry): entry is ModelOverride => Boolean(entry));
    return bundledOverridesCache;
}

export function loadUserOverrides(config?: vscode.WorkspaceConfiguration): ModelOverride[] {
    const workspaceConfig = config ?? vscode.workspace.getConfiguration();
    const raw = workspaceConfig.get<unknown>(MODEL_OVERRIDES_SETTING_KEY, []);

    if (!Array.isArray(raw)) {
        if (raw) {
            Logger.warn(`[modelOverrides] Expected array for ${MODEL_OVERRIDES_SETTING_KEY}; got ${typeof raw}`);
        }
        return [];
    }

    const validated = raw
        .map((entry, index) => validateOverride(entry, `user[${index}]`))
        .filter((entry): entry is ModelOverride => Boolean(entry));

    return validated;
}

export function getMergedOverrides(config?: vscode.WorkspaceConfiguration): ModelOverride[] {
    const user = loadUserOverrides(config);
    const bundled = loadBundledOverrides();
    return [...user, ...bundled];
}

export function findOverride(modelId: string, config?: vscode.WorkspaceConfiguration): ModelOverride | undefined {
    const workspaceConfig = config ?? vscode.workspace.getConfiguration();
    const enableModelOverrides = workspaceConfig.get<boolean>("litellm-connector.enableModelOverrides", true);
    if (!enableModelOverrides) {
        return undefined;
    }

    const overrides = getMergedOverrides(config);

    for (const override of overrides) {
        try {
            const regex = new RegExp(override.match, "i");
            if (regex.test(modelId)) {
                return override;
            }
        } catch {
            Logger.warn(`[modelOverrides] Invalid regex at match time: ${override.match}`);
        }
    }

    return undefined;
}

/**
 * Resolves a model's reasoning effort levels from its override and the proxy's
 * reasoning data.
 *
 * A proxy that reports `supports_reasoning: false`, or an override that sets
 * `supportsReasoning: false`, gets no levels. A `forceMandatory` override supplies
 * its own list, or the canonical list when it declares none. Otherwise the proxy's
 * explicit effort fields decide, then its `supports_reasoning` flag, and an override
 * with `supportsReasoning: true` supplies its list only when the proxy reports neither.
 */
export function getEffectiveEfforts(
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
): readonly SupportedReasoningEffort[] {
    const override = findOverride(modelId, config);
    const overrideEfforts = override?.reasoningEfforts;

    if (modelInfo?.supports_reasoning === false) {
        return [];
    }

    if (override) {
        if (override.supportsReasoning === false) {
            return [];
        }

        if (override.forceMandatory) {
            return overrideEfforts ?? [...CANONICAL_REASONING_EFFORTS];
        }

        const explicitEfforts = readDeclaredReasoningEfforts(modelInfo);
        if (explicitEfforts !== undefined) {
            return explicitEfforts;
        }

        if (modelInfo?.supports_reasoning) {
            return [...CANONICAL_REASONING_EFFORTS];
        }

        if (override.supportsReasoning === true) {
            return overrideEfforts ?? [...CANONICAL_REASONING_EFFORTS];
        }

        return [];
    }

    // No override: check explicit effort fields first, then fall back to canonical.
    const explicitEfforts = readDeclaredReasoningEfforts(modelInfo);
    if (explicitEfforts !== undefined) {
        return explicitEfforts;
    }

    if (modelInfo?.supports_reasoning) {
        return [...CANONICAL_REASONING_EFFORTS];
    }

    return [];
}

/**
 * Resolves the default effort for a model.
 *
 * An override's `defaultEffort` wins when the list the override declares (or the
 * canonical list, when it declares none) contains it. Otherwise the default is that
 * list's highest level, its last entry, because both lists follow the canonical
 * order.
 *
 * The result can sit outside the list the model advertises, because this function
 * checks membership against the override's list only. Callers check it against the
 * model's list before showing it.
 */
export function getDefaultEffort(
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
): SupportedReasoningEffort | undefined {
    if (modelInfo?.supports_reasoning === false) {
        return undefined;
    }

    const override = findOverride(modelId, config);

    if (override) {
        if (override.supportsReasoning === false) {
            return undefined;
        }

        const efforts = override.reasoningEfforts ?? CANONICAL_REASONING_EFFORTS;
        if (override.defaultEffort && efforts.includes(override.defaultEffort)) {
            return override.defaultEffort;
        }

        if (override.supportsReasoning === true || modelInfo?.supports_reasoning) {
            return highestReasoningEffort(efforts);
        }
        return undefined;
    }

    if (modelInfo?.supports_reasoning) {
        return highestReasoningEffort(CANONICAL_REASONING_EFFORTS);
    }

    return undefined;
}

export type { ModelOverride } from "../types";
