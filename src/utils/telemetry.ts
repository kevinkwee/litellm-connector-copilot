import { Logger } from "./logger";

export interface IMetrics {
    requestId: string;
    model: string;
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    cacheReadRatio?: number;
    promptCacheTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    toolTokens?: number;
    acceptedPredictionTokens?: number;
    rejectedPredictionTokens?: number;
    reservedOutputTokens?: number;
    totalTokenMax?: number;
    estimatedInputCost?: number;
    estimatedOutputCost?: number;
    estimatedTotalCost?: number;
    status: "success" | "failure" | "caching_bypassed";
    error?: string;
    caller?: string;
}

export class LiteLLMTelemetry {
    public static reportMetric(metric: IMetrics): void {
        // Keep structured debug logs for local diagnostics.
        Logger.debug(`[Telemetry] ${JSON.stringify(metric)}`);

        // Mirror token usage into the regular output stream to make token accounting
        // visible without requiring debug log level.
        Logger.info(
            `[TokenUsage] request_id=${metric.requestId} caller=${metric.caller ?? "unknown"} model=${
                metric.model
            } status=${metric.status} duration_ms=${metric.durationMs ?? 0} tokens_in=${metric.tokensIn ?? 0} tokens_out=${
                metric.tokensOut ?? 0
            } cache_read_ratio=${metric.cacheReadRatio ?? "n/a"} prompt_cache_tokens=${
                metric.promptCacheTokens ?? "n/a"
            } cache_creation_input_tokens=${metric.cacheCreationInputTokens ?? "n/a"} reasoning_tokens=${
                metric.reasoningTokens ?? "n/a"
            } tool_tokens=${metric.toolTokens ?? "n/a"} accepted_prediction_tokens=${
                metric.acceptedPredictionTokens ?? "n/a"
            } rejected_prediction_tokens=${metric.rejectedPredictionTokens ?? "n/a"} token_count_max=${
                metric.reservedOutputTokens ?? "n/a"
            } total_token_max=${metric.totalTokenMax ?? "n/a"} estimated_input_cost=${
                metric.estimatedInputCost ?? "n/a"
            } estimated_output_cost=${metric.estimatedOutputCost ?? "n/a"} estimated_total_cost=${
                metric.estimatedTotalCost ?? "n/a"
            }`
        );
    }

    public static startTimer(): number {
        return Date.now();
    }

    public static endTimer(startTime: number): number {
        return Date.now() - startTime;
    }
}
