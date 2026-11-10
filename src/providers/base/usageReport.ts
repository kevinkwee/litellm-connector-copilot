import type { TokenSnapshot } from "../../adapters/streaming/streamTokenCapture";
import { logFinalUsageEnvelope } from "../../observability/finalUsageEnvelope";
import type { IMetrics } from "../../utils/telemetry";

/**
 * The token and cost fields one request's spend contributes to its metric and its
 * final usage line. Every outcome reports the same fields, so a failed or cancelled
 * turn states what it cost instead of reading as free.
 */
export interface UsageReportFields {
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly cachedTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly reasoningTokens?: number;
    readonly toolTokens?: number;
    readonly acceptedPredictionTokens?: number;
    readonly rejectedPredictionTokens?: number;
    readonly systemPromptTokens?: number;
    readonly estimatedInputCost?: number;
    readonly estimatedOutputCost?: number;
    readonly estimatedTotalCost?: number;
    readonly cacheReadRatio?: number;
}

/**
 * Normalises one spend snapshot into the reported fields.
 *
 * A zero counter becomes absent, because the connector cannot tell a gateway that
 * reported zero from one that reported nothing, and an absent field prints `n/a`
 * where a zero would read as a measurement. The prompt and output counts are always
 * present: they fall back to the connector's own estimate.
 */
export function buildUsageReportFields(snapshot: TokenSnapshot): UsageReportFields {
    const cachedTokens = snapshot.cachedTokens || undefined;
    return {
        tokensIn: snapshot.promptTokens,
        tokensOut: snapshot.outputTokens,
        cachedTokens,
        cacheCreationInputTokens: snapshot.cacheCreationInputTokens || undefined,
        reasoningTokens: snapshot.reasoningTokens || undefined,
        toolTokens: snapshot.toolTokens || undefined,
        acceptedPredictionTokens: snapshot.acceptedPredictionTokens || undefined,
        rejectedPredictionTokens: snapshot.rejectedPredictionTokens || undefined,
        systemPromptTokens: snapshot.systemPromptTokens || undefined,
        estimatedInputCost: snapshot.estimatedInputCost,
        estimatedOutputCost: snapshot.estimatedOutputCost,
        estimatedTotalCost: snapshot.estimatedTotalCost,
        cacheReadRatio:
            cachedTokens !== undefined && snapshot.promptTokens ? cachedTokens / snapshot.promptTokens : undefined,
    };
}

/** The metric fields one usage report fills, for every outcome. */
export function toUsageMetricFields(
    fields: UsageReportFields
): Pick<
    IMetrics,
    | "tokensIn"
    | "tokensOut"
    | "promptCacheTokens"
    | "cacheCreationInputTokens"
    | "reasoningTokens"
    | "toolTokens"
    | "acceptedPredictionTokens"
    | "rejectedPredictionTokens"
    | "estimatedInputCost"
    | "estimatedOutputCost"
    | "estimatedTotalCost"
    | "cacheReadRatio"
> {
    return {
        tokensIn: fields.tokensIn,
        tokensOut: fields.tokensOut,
        promptCacheTokens: fields.cachedTokens,
        cacheCreationInputTokens: fields.cacheCreationInputTokens,
        reasoningTokens: fields.reasoningTokens,
        toolTokens: fields.toolTokens,
        acceptedPredictionTokens: fields.acceptedPredictionTokens,
        rejectedPredictionTokens: fields.rejectedPredictionTokens,
        estimatedInputCost: fields.estimatedInputCost,
        estimatedOutputCost: fields.estimatedOutputCost,
        estimatedTotalCost: fields.estimatedTotalCost,
        cacheReadRatio: fields.cacheReadRatio,
    };
}

/**
 * Writes the `[TokenUsage][Final]` line for one finished request.
 *
 * The reservation values are request-shape facts, so an outcome that never resolved
 * them leaves those fields absent.
 */
export function logUsageTotals(
    requestId: string,
    modelId: string,
    caller: string,
    fields: UsageReportFields,
    sawUpstreamUsage: boolean,
    reservation: { readonly reservedOutputTokens?: number; readonly totalTokenMax?: number } = {}
): void {
    logFinalUsageEnvelope(requestId, modelId, caller, {
        ...fields,
        reservedOutputTokens: reservation.reservedOutputTokens,
        totalTokenMax: reservation.totalTokenMax,
        sawUsageDataPart: sawUpstreamUsage,
    });
}
