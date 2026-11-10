import { Logger } from "../utils/logger";

/**
 * Token and cost totals for one finished chat request. A counter is absent when
 * the gateway omitted it or the stream ended without a usage frame; a cost is
 * absent when the model is unpriced. `sawUsageDataPart` is always present because
 * the provider observes it locally.
 */
export interface FinalUsageEnvelope {
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly cachedTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly reasoningTokens?: number;
    readonly toolTokens?: number;
    readonly acceptedPredictionTokens?: number;
    readonly rejectedPredictionTokens?: number;
    readonly systemPromptTokens?: number;
    readonly reservedOutputTokens?: number;
    readonly totalTokenMax?: number;
    readonly sawUsageDataPart: boolean;
    readonly estimatedInputCost?: number;
    readonly estimatedOutputCost?: number;
    readonly estimatedTotalCost?: number;
}

/**
 * Logs one finished request's token and cost totals as the final
 * `[TokenUsage][Final]` line, so a support reader can grep a request's budget even
 * when the stream ended without a usage frame.
 */
export function logFinalUsageEnvelope(
    requestId: string,
    modelId: string,
    caller: string,
    usage: FinalUsageEnvelope
): void {
    Logger.debug(
        `[TokenUsage][Final] request_id=${requestId} model=${modelId} caller=${caller} ` +
            `tokens_in=${usage.tokensIn ?? "n/a"} tokens_out=${usage.tokensOut ?? "n/a"} ` +
            `cached_tokens=${usage.cachedTokens ?? "n/a"} cache_creation_input_tokens=${
                usage.cacheCreationInputTokens ?? "n/a"
            } ` +
            `reasoning_tokens=${usage.reasoningTokens ?? "n/a"} tool_tokens=${usage.toolTokens ?? "n/a"} ` +
            `accepted_prediction_tokens=${usage.acceptedPredictionTokens ?? "n/a"} rejected_prediction_tokens=${
                usage.rejectedPredictionTokens ?? "n/a"
            } ` +
            `system_prompt_tokens=${usage.systemPromptTokens ?? "n/a"} reserved_output_tokens=${
                usage.reservedOutputTokens ?? "n/a"
            } ` +
            `total_token_max=${usage.totalTokenMax ?? "n/a"} streamed_usage=${usage.sawUsageDataPart} ` +
            `estimated_input_cost=${usage.estimatedInputCost ?? "n/a"} estimated_output_cost=${
                usage.estimatedOutputCost ?? "n/a"
            } estimated_total_cost=${usage.estimatedTotalCost ?? "n/a"}`
    );
}
