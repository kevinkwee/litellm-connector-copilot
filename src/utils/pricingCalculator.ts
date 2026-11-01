import type { LiteLLMModelInfo } from "../types";

/**
 * Per-token rates for one pricing context, either a model's base rates or the
 * rates a prompt token threshold selects.
 */
export interface PricingRates {
    /** Cost per input (prompt) token in USD. */
    readonly inputCostPerToken?: number;
    /** Cost per output (completion) token in USD. */
    readonly outputCostPerToken?: number;
    /** Cost per cached input token (cache read) in USD. */
    readonly cacheReadCostPerToken?: number;
    /** Cost per cache creation input token in USD. */
    readonly cacheCreationCostPerToken?: number;
    /**
     * Cost per cache-creation token for the one-hour cache tier. Undefined means
     * the model declares none.
     */
    readonly cacheCreation1hCostPerToken?: number;
}

/** The rates that apply to a request whose prompt is larger than a threshold. */
export interface PricingTier extends PricingRates {
    /** Prompt token count the tier starts above. */
    readonly thresholdTokens: number;
}

/**
 * Structured pricing data extracted from LiteLLM's `/model/info` response.
 * All values are per-token costs in USD (matching LiteLLM's `*_cost_per_token` convention).
 * Undefined fields mean the pricing data was not provided by the backend.
 */
export interface ModelPricing extends PricingRates {
    /** Higher-threshold rates, applied to the whole request when it exceeds one. */
    readonly tiers?: readonly PricingTier[];
}

/**
 * Per-request cost breakdown computed from token usage × pricing.
 * All values are in USD. Zero when pricing data is unavailable.
 */
export interface RequestCost {
    /** Cost attributable to input (prompt) tokens, including cache adjustments. */
    readonly inputCost: number;
    /** Cost attributable to output (completion) tokens. */
    readonly outputCost: number;
    /** Combined total cost (input + output + cache adjustments). */
    readonly totalCost: number;
}

/**
 * Inputs required for cost calculation.
 */
export interface CostCalculationInput {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cachedTokens: number;
    readonly cacheCreationInputTokens: number;
    /** Cache-write tokens the provider billed at the five-minute tier. */
    readonly cacheCreation5mTokens?: number;
    /** Cache-write tokens the provider billed at the one-hour tier. */
    readonly cacheCreation1hTokens?: number;
    readonly pricing: ModelPricing | undefined;
}

const PRICING_FIELDS = {
    inputCostPerToken: "input_cost_per_token",
    outputCostPerToken: "output_cost_per_token",
    cacheReadCostPerToken: "cache_read_input_token_cost",
    cacheCreationCostPerToken: "cache_creation_input_token_cost",
    cacheCreation1hCostPerToken: "cache_creation_input_token_cost_above_1hr",
} as const;

const PRICING_RATE_FIELDS: readonly (keyof PricingRates)[] = [
    "inputCostPerToken",
    "outputCostPerToken",
    "cacheReadCostPerToken",
    "cacheCreationCostPerToken",
    "cacheCreation1hCostPerToken",
];

/**
 * Matches an input-category threshold pricing key and captures its token count.
 *
 * LiteLLM declares the thresholds from the input-token keys alone, so no other
 * category's key can create a tier. The anchored `_tokens` ending also rejects a
 * service-tier key (`_auto`, `_flex`, `_priority`), which can never apply because
 * the connector sends no `service_tier`.
 */
const TIER_THRESHOLD_PATTERN = new RegExp(`^${PRICING_FIELDS.inputCostPerToken}_above_(\\d+(?:\\.\\d+)?k?)_tokens$`);

/** A parsed threshold pricing key. */
interface TierThreshold {
    /** Token count the key starts above. */
    readonly thresholdTokens: number;
    /** The count exactly as the key spells it, so sibling keys can be rebuilt. */
    readonly label: string;
}

/**
 * Reads the threshold of an input-token pricing key, or undefined when the key
 * declares no threshold.
 *
 * LiteLLM accepts `_above_<N>k_tokens` and `_above_<N>_tokens`, with a decimal or
 * zero count allowed.
 */
function parseTierThreshold(fieldName: string): TierThreshold | undefined {
    const match = TIER_THRESHOLD_PATTERN.exec(fieldName);
    if (!match) {
        return undefined;
    }
    const label = match[1];
    const amount = Number(label.replace("k", ""));
    return { thresholdTokens: label.endsWith("k") ? amount * 1_000 : amount, label };
}

/** The key a category's rate is stored under at one threshold. */
function tierFieldName(fieldName: string, label: string): string {
    return `${fieldName}_above_${label}_tokens`;
}

/**
 * Reads every category's rate at one threshold.
 *
 * A tier exists only when the input-token key at that threshold carries a
 * numeric rate, which is the key LiteLLM selects the tier with. A category whose
 * tiered key is absent keeps its base rate.
 */
function readTierRates(modelInfo: LiteLLMModelInfo, threshold: TierThreshold): PricingRates | undefined {
    if (
        extractNumericField(modelInfo, tierFieldName(PRICING_FIELDS.inputCostPerToken, threshold.label)) === undefined
    ) {
        return undefined;
    }
    const rates: Partial<Record<keyof PricingRates, number>> = {};
    for (const rateField of PRICING_RATE_FIELDS) {
        const rate = extractNumericField(modelInfo, tierFieldName(PRICING_FIELDS[rateField], threshold.label));
        if (rate !== undefined) {
            rates[rateField] = rate;
        }
    }
    return rates;
}

/** Collects the pricing tiers the model info declares, lowest threshold first. */
function extractPricingTiers(modelInfo: LiteLLMModelInfo): readonly PricingTier[] {
    const tiers: PricingTier[] = [];
    for (const fieldName of Object.keys(modelInfo)) {
        const threshold = parseTierThreshold(fieldName);
        if (threshold === undefined) {
            continue;
        }
        const rates = readTierRates(modelInfo, threshold);
        if (rates !== undefined) {
            tiers.push({ thresholdTokens: threshold.thresholdTokens, ...rates });
        }
    }
    return tiers.sort((left, right) => left.thresholdTokens - right.thresholdTokens);
}

function extractNumericField(modelInfo: LiteLLMModelInfo, field: string): number | undefined {
    const value = modelInfo[field as keyof LiteLLMModelInfo];
    if (value === null || value === undefined) {
        return undefined;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractPricing(modelInfo: LiteLLMModelInfo | undefined): ModelPricing | undefined {
    if (!modelInfo) {
        return undefined;
    }

    const nestedPricing = (modelInfo as { pricing?: Partial<ModelPricing> | undefined }).pricing;

    const basePricing: ModelPricing = {
        inputCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.inputCostPerToken) ??
            (typeof nestedPricing?.inputCostPerToken === "number" ? nestedPricing.inputCostPerToken : undefined),
        outputCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.outputCostPerToken) ??
            (typeof nestedPricing?.outputCostPerToken === "number" ? nestedPricing.outputCostPerToken : undefined),
        cacheReadCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.cacheReadCostPerToken) ??
            (typeof nestedPricing?.cacheReadCostPerToken === "number"
                ? nestedPricing.cacheReadCostPerToken
                : undefined),
        cacheCreationCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.cacheCreationCostPerToken) ??
            (typeof nestedPricing?.cacheCreationCostPerToken === "number"
                ? nestedPricing.cacheCreationCostPerToken
                : undefined),
        cacheCreation1hCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.cacheCreation1hCostPerToken) ??
            (typeof nestedPricing?.cacheCreation1hCostPerToken === "number"
                ? nestedPricing.cacheCreation1hCostPerToken
                : undefined),
    };

    const tiers = extractPricingTiers(modelInfo);
    const pricing: ModelPricing = tiers.length > 0 ? { ...basePricing, tiers } : basePricing;

    const hasValue =
        pricing.inputCostPerToken !== undefined ||
        pricing.outputCostPerToken !== undefined ||
        pricing.cacheReadCostPerToken !== undefined ||
        pricing.cacheCreationCostPerToken !== undefined ||
        pricing.cacheCreation1hCostPerToken !== undefined ||
        tiers.length > 0;

    return hasValue ? pricing : undefined;
}

function formatPerMillion(costPerToken: number): string {
    // Avoid floating artifacts by rounding the base before formatting
    // normalize artifacts like 0.0249999999999 before formatting
    const perMillionRaw = costPerToken * 1_000_000;
    const perMillion = Number.parseFloat(perMillionRaw.toFixed(4));
    let decimals = 2;
    if (perMillion < 0.0001) {
        decimals = 6;
    } else if (perMillion < 1 && Math.abs(perMillion % 0.1) > 1e-9) {
        // Use 4 decimals for values below 1 that are not neat tenths (e.g., 0.125 → 0.1250)
        decimals = 4;
    }
    return `$${perMillion.toFixed(decimals)}/1M`;
}

export function formatPricingForDetail(pricing: ModelPricing | undefined): string {
    if (!pricing) {
        return "";
    }
    const parts: string[] = [];
    if (pricing.inputCostPerToken !== undefined) {
        parts.push(`${formatPerMillion(pricing.inputCostPerToken)} inp`);
    }
    if (pricing.outputCostPerToken !== undefined) {
        parts.push(`${formatPerMillion(pricing.outputCostPerToken)} out`);
    }
    return parts.join(" • ");
}

export function formatPricingForTooltip(pricing: ModelPricing | undefined): string {
    if (!pricing) {
        return "";
    }

    const lines: string[] = [];
    if (pricing.inputCostPerToken !== undefined) {
        lines.push(`Input: ${formatPerMillion(pricing.inputCostPerToken)} tokens`);
    }
    if (pricing.outputCostPerToken !== undefined) {
        lines.push(`Output: ${formatPerMillion(pricing.outputCostPerToken)} tokens`);
    }
    if (pricing.cacheReadCostPerToken !== undefined) {
        lines.push(`Cache read: ${formatPerMillion(pricing.cacheReadCostPerToken)} tokens`);
    }
    if (pricing.cacheCreationCostPerToken !== undefined) {
        lines.push(`Cache write: ${formatPerMillion(pricing.cacheCreationCostPerToken)} tokens`);
    }
    return lines.join("\n");
}

/**
 * Picks the rates one request is billed at.
 *
 * The highest declared threshold the prompt exceeds supplies every category,
 * and a category that tier omits keeps its base rate.
 */
function resolveRates(pricing: ModelPricing, promptTokens: number): PricingRates {
    const tiers = [...(pricing.tiers ?? [])].sort((left, right) => right.thresholdTokens - left.thresholdTokens);
    const selected = tiers.find((tier) => promptTokens > tier.thresholdTokens);
    return {
        inputCostPerToken: selected?.inputCostPerToken ?? pricing.inputCostPerToken,
        outputCostPerToken: selected?.outputCostPerToken ?? pricing.outputCostPerToken,
        cacheReadCostPerToken: selected?.cacheReadCostPerToken ?? pricing.cacheReadCostPerToken,
        cacheCreationCostPerToken: selected?.cacheCreationCostPerToken ?? pricing.cacheCreationCostPerToken,
        cacheCreation1hCostPerToken: selected?.cacheCreation1hCostPerToken ?? pricing.cacheCreation1hCostPerToken,
    };
}

export function calculateRequestCost(input: CostCalculationInput): RequestCost {
    const { promptTokens, completionTokens, cachedTokens, cacheCreationInputTokens, pricing } = input;
    if (!pricing) {
        return { inputCost: 0, outputCost: 0, totalCost: 0 };
    }

    const rates = resolveRates(pricing, promptTokens);
    const nonCachedPromptTokens = Math.max(promptTokens - cachedTokens - cacheCreationInputTokens, 0);
    const cacheReadTokens = Math.max(cachedTokens, 0);
    const cacheCreationTokens = Math.max(cacheCreationInputTokens, 0);
    // A reported split bills each tier on its own rate and treats the count the
    // provider omitted as zero, which is how LiteLLM reads the same details.
    // Without any split, every cache-write token uses the base (five-minute) rate.
    const hasCacheWriteSplit = input.cacheCreation5mTokens !== undefined || input.cacheCreation1hTokens !== undefined;
    const cacheCreation5mTokens = hasCacheWriteSplit
        ? Math.max(input.cacheCreation5mTokens ?? 0, 0)
        : cacheCreationTokens;
    const cacheCreation1hTokens = hasCacheWriteSplit ? Math.max(input.cacheCreation1hTokens ?? 0, 0) : 0;

    const inputCost =
        (rates.inputCostPerToken ?? 0) * nonCachedPromptTokens +
        (rates.cacheReadCostPerToken ?? 0) * cacheReadTokens +
        (rates.cacheCreationCostPerToken ?? 0) * cacheCreation5mTokens +
        // The one-hour tier is billed by its own key, which is zero when the proxy
        // declares none.
        (rates.cacheCreation1hCostPerToken ?? 0) * cacheCreation1hTokens;
    const outputCost = (rates.outputCostPerToken ?? 0) * Math.max(completionTokens, 0);
    const totalCost = inputCost + outputCost;

    // Normalize floating point artifacts to a consistent precision.
    const round = (value: number): number => Number.parseFloat(value.toFixed(12));

    return { inputCost: round(inputCost), outputCost: round(outputCost), totalCost: round(totalCost) };
}

export function derivePriceCategory(pricing: ModelPricing | undefined): string | undefined {
    if (!pricing) {
        return undefined;
    }

    const perMillionCosts: number[] = [];
    if (pricing.inputCostPerToken !== undefined) {
        perMillionCosts.push(pricing.inputCostPerToken * 1_000_000);
    }
    if (pricing.outputCostPerToken !== undefined) {
        perMillionCosts.push(pricing.outputCostPerToken * 1_000_000);
    }

    if (perMillionCosts.length === 0) {
        return undefined;
    }

    const maxCost = Math.max(...perMillionCosts);

    if (maxCost <= 10) {
        return "low";
    }
    if (maxCost < 20) {
        return "medium";
    }
    if (maxCost <= 100) {
        return "high";
    }
    return "very_high";
}
