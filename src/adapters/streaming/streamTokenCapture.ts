import * as vscode from "vscode";
import { countTokens } from "../tokenUtils";
import type {
    LiteLLMModelInfo,
    OpenAIUsageCompletionTokenDetails,
    OpenAIUsagePayload,
    OpenAIUsagePromptTokenDetails,
} from "../../types";
import { calculateRequestCost, extractPricing, type RequestCost } from "../../utils/pricingCalculator";

/**
 * Snapshot of the tracked token counts. Values prefer upstream usage when available
 * and fall back to internal counting.
 *
 * {@link StreamTokenCapture.getSnapshot} describes one attempt, which is what a usage
 * part forwarded to the host carries because the host reads it for context size.
 * {@link StreamTokenCapture.getSpendSnapshot} describes the whole request.
 */
export interface TokenSnapshot {
    // Input side
    promptTokens: number;
    cachedTokens: number;
    cacheCreationInputTokens: number;
    systemPromptTokens: number;

    // Output side
    /**
     * The upstream `completion_tokens` when the gateway reported one, otherwise
     * the local estimate of the text buffer, which includes thinking. An
     * upstream count also covers tool-call output; the local estimate does not.
     */
    completionTokens: number;
    /**
     * Output tokens the request produced. Upstream `completion_tokens` when the
     * gateway reported it, otherwise the local estimate of text plus tool-call
     * tokens.
     */
    outputTokens: number;
    reasoningTokens: number;
    toolTokens: number;
    acceptedPredictionTokens: number;
    rejectedPredictionTokens: number;

    // Metadata
    sawUpstreamUsage: boolean;

    // Pricing-aware cost estimation in USD. The fields are absent when the model declares no rates.
    estimatedInputCost?: number;
    estimatedOutputCost?: number;
    estimatedTotalCost?: number;
}

/**
 * Wraps a Progress<LanguageModelResponsePart> to capture token counts from
 * every part that flows through, regardless of endpoint (/chat/completions
 * or /responses). Accumulates internal counts during streaming and merges
 * with upstream usage when available.
 *
 * Usage:
 *   const capture = new StreamTokenCapture(modelId, innerProgress, modelInfo);
 *   // pass capture.progress wherever you'd pass progress
 *   await sendRequest(..., capture.progress, ...);
 *   const spend = capture.getSpendSnapshot();
 */
export class StreamTokenCapture {
    private readonly _inner: vscode.Progress<vscode.LanguageModelResponsePart>;
    private readonly _modelId: string;
    private readonly _modelInfo?: LiteLLMModelInfo;
    private readonly _pricing: ReturnType<typeof extractPricing>;

    // Accumulated internal counts (populated during streaming)
    private _textBuffer = "";
    private _reasoningBuffer = "";
    private _toolCallTokens = 0;

    // Upstream usage (from a DataPart, `response.completed`, or `response.incomplete`)
    private _sawUpstreamUsage = false;
    /** Spend of the attempts this request replaced, folded in before each reset. */
    private readonly _spent = {
        promptTokens: 0,
        completionTokens: 0,
        outputTokens: 0,
        toolTokens: 0,
        cachedTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        acceptedPredictionTokens: 0,
        rejectedPredictionTokens: 0,
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
    };
    /** Whether any attempt this request replaced reported upstream usage. */
    private _spentSawUpstreamUsage = false;
    private _upstream?: OpenAIUsagePayload;

    // Pre-computed input token estimates (set by caller before request)
    private _estimatedPromptTokens = 0;
    private _estimatedSystemPromptTokens = 0;

    // Enrichment context (injected by caller for the usage DataPart pass-through)
    private _reservedOutputTokens?: number;
    private _totalTokenMax?: number;

    constructor(
        modelId: string,
        inner: vscode.Progress<vscode.LanguageModelResponsePart>,
        modelInfo?: LiteLLMModelInfo
    ) {
        this._modelId = modelId;
        this._inner = inner;
        this._modelInfo = modelInfo;
        this._pricing = extractPricing(modelInfo);
    }

    setEstimatedPromptTokens(count: number): void {
        this._estimatedPromptTokens = count;
    }

    setEstimatedSystemPromptTokens(count: number): void {
        this._estimatedSystemPromptTokens = count;
    }

    setReservedOutputTokens(tokens: number): void {
        this._reservedOutputTokens = tokens;
    }

    setTotalTokenMax(tokens: number): void {
        this._totalTokenMax = tokens;
    }

    get progress(): vscode.Progress<vscode.LanguageModelResponsePart> {
        return { report: (part) => this._intercept(part) };
    }

    /**
     * Ends the accounting for an attempt a retry replaces, so the next attempt starts
     * from a clean estimator state.
     *
     * The proxy bills the replaced attempt too, so its spend is folded into the request
     * totals that {@link getSpendSnapshot} reports. Keeping that accounting here would
     * count it again, and a resume would also carry the streamed text in its own prompt.
     *
     * The prompt side is folded only when the attempt reached the proxy. A connect-phase
     * failure never reached it, so that attempt's prompt count is the connector's own
     * estimate and folding it would price a request that never happened. The folded total
     * cost is derived from the folded sides, so the estimate cannot reappear inside it.
     */
    resetAccumulation(options: { readonly reachedProxy: boolean }): void {
        const replaced = this.getSnapshot();
        const inputCost = options.reachedProxy ? (replaced.estimatedInputCost ?? 0) : 0;
        const outputCost = replaced.estimatedOutputCost ?? 0;
        if (options.reachedProxy) {
            this._spent.promptTokens += replaced.promptTokens;
            this._spent.cachedTokens += replaced.cachedTokens;
            this._spent.cacheCreationInputTokens += replaced.cacheCreationInputTokens;
            this._spent.inputCost += inputCost;
        }
        this._spent.completionTokens += replaced.completionTokens;
        this._spent.outputTokens += replaced.outputTokens;
        this._spent.reasoningTokens += replaced.reasoningTokens;
        this._spentSawUpstreamUsage ||= replaced.sawUpstreamUsage;
        this._spent.toolTokens += replaced.toolTokens;
        this._spent.acceptedPredictionTokens += replaced.acceptedPredictionTokens;
        this._spent.rejectedPredictionTokens += replaced.rejectedPredictionTokens;
        this._spent.outputCost += outputCost;
        // Derived from the folded sides, so a refused attempt cannot leave a priced
        // prompt inside the total.
        this._spent.totalCost += inputCost + outputCost;

        this._textBuffer = "";
        this._reasoningBuffer = "";
        this._toolCallTokens = 0;
        this._sawUpstreamUsage = false;
        this._upstream = undefined;
    }

    /**
     * The request's totals: the last attempt plus every attempt it replaced.
     *
     * A retried turn is billed for each attempt the proxy ran, so this is what the
     * metrics, the final usage line and the transcript record. `systemPromptTokens`
     * stays a context value, because it measures the prompt rather than spend.
     *
     * An attempt a retry replaced contributes its prompt only when it reached the proxy.
     * The attempt the turn ended on is always counted, because it is the last reading the
     * connector has: a turn whose final attempt never connected therefore reports that
     * attempt's estimate rather than under-reporting its spend.
     */
    getSpendSnapshot(): TokenSnapshot {
        const last = this.getSnapshot();
        const hasCost = last.estimatedInputCost !== undefined || last.estimatedOutputCost !== undefined;
        return {
            ...last,
            promptTokens: last.promptTokens + this._spent.promptTokens,
            completionTokens: last.completionTokens + this._spent.completionTokens,
            outputTokens: last.outputTokens + this._spent.outputTokens,
            toolTokens: last.toolTokens + this._spent.toolTokens,
            reasoningTokens: last.reasoningTokens + this._spent.reasoningTokens,
            acceptedPredictionTokens: last.acceptedPredictionTokens + this._spent.acceptedPredictionTokens,
            rejectedPredictionTokens: last.rejectedPredictionTokens + this._spent.rejectedPredictionTokens,
            cachedTokens: last.cachedTokens + this._spent.cachedTokens,
            cacheCreationInputTokens: last.cacheCreationInputTokens + this._spent.cacheCreationInputTokens,
            sawUpstreamUsage: last.sawUpstreamUsage || this._spentSawUpstreamUsage,
            estimatedInputCost: hasCost ? (last.estimatedInputCost ?? 0) + this._spent.inputCost : undefined,
            estimatedOutputCost: hasCost ? (last.estimatedOutputCost ?? 0) + this._spent.outputCost : undefined,
            estimatedTotalCost: hasCost ? (last.estimatedTotalCost ?? 0) + this._spent.totalCost : undefined,
        };
    }

    /** This attempt's counts, before the replaced attempts are folded in. */
    getSnapshot(): TokenSnapshot {
        const hasUpstream = this._sawUpstreamUsage && this._upstream !== undefined;
        const promptDetails: OpenAIUsagePromptTokenDetails | undefined = this._upstream?.prompt_tokens_details;
        const completionDetails: OpenAIUsageCompletionTokenDetails | undefined =
            this._upstream?.completion_tokens_details;

        const snapshot: TokenSnapshot = {
            // Input: prefer upstream, fall back to pre-computed estimate
            promptTokens: this._upstream?.prompt_tokens ?? this._estimatedPromptTokens,
            cachedTokens: promptDetails?.cached_tokens ?? 0,
            cacheCreationInputTokens: promptDetails?.cache_creation_input_tokens ?? 0,
            systemPromptTokens: this._upstream?.system_prompt_tokens ?? this._estimatedSystemPromptTokens,

            // Output: prefer upstream, fall back to internal accumulation
            completionTokens:
                this._upstream?.completion_tokens ?? countTokens(this._textBuffer, this._modelId, this._modelInfo),
            outputTokens: this._resolveOutputTokens(),
            reasoningTokens:
                completionDetails?.reasoning_tokens ??
                countTokens(this._reasoningBuffer, this._modelId, this._modelInfo),
            toolTokens: completionDetails?.tool_tokens ?? (this._toolCallTokens > 0 ? this._toolCallTokens : 0),
            acceptedPredictionTokens: completionDetails?.accepted_prediction_tokens ?? 0,
            rejectedPredictionTokens: completionDetails?.rejected_prediction_tokens ?? 0,

            sawUpstreamUsage: hasUpstream,
        };

        const cost: RequestCost = calculateRequestCost({
            promptTokens: snapshot.promptTokens,
            completionTokens: snapshot.outputTokens,
            cachedTokens: snapshot.cachedTokens,
            cacheCreationInputTokens: snapshot.cacheCreationInputTokens,
            cacheCreation5mTokens: promptDetails?.cache_creation_token_details?.ephemeral_5m_input_tokens,
            cacheCreation1hTokens: promptDetails?.cache_creation_token_details?.ephemeral_1h_input_tokens,
            pricing: this._pricing,
        });
        if (this._pricing) {
            snapshot.estimatedInputCost = cost.inputCost;
            snapshot.estimatedOutputCost = cost.outputCost;
            snapshot.estimatedTotalCost = cost.totalCost;
        }

        return snapshot;
    }

    /**
     * Output tokens for a request. The text buffer already holds the thinking
     * text, so the local estimate adds the tool-call tokens only and reasoning
     * is not counted twice.
     */
    private _resolveOutputTokens(): number {
        if (typeof this._upstream?.completion_tokens === "number") {
            return this._upstream.completion_tokens;
        }
        return countTokens(this._textBuffer, this._modelId, this._modelInfo) + this._toolCallTokens;
    }

    /**
     * Emits a usage DataPart to VS Code if no upstream usage was seen during streaming.
     * This ensures usage data is always reported, even for providers that don't send
     * usage in their streaming response.
     *
     * Should be called after the stream completes and before the snapshot is read.
     */
    flushUsage(): void {
        if (this._sawUpstreamUsage) {
            // Usage was already sent during streaming (enriched by _handleUsageDataPart)
            return;
        }

        // Build usage payload from accumulated counts
        const snapshot = this.getSnapshot();

        // An empty stream has no usage to report; prompt tokens are only an estimate.
        if (snapshot.outputTokens === 0) {
            return;
        }

        const completionTokens = snapshot.outputTokens;

        const usagePayload: OpenAIUsagePayload = {
            prompt_tokens: snapshot.promptTokens,
            completion_tokens: completionTokens,
            total_tokens: snapshot.promptTokens + completionTokens,
        };

        // Add prompt token details if we have them
        const promptTokenDetails: OpenAIUsagePromptTokenDetails = {};
        if (snapshot.cachedTokens > 0) {
            promptTokenDetails.cached_tokens = snapshot.cachedTokens;
        }
        if (snapshot.cacheCreationInputTokens > 0) {
            promptTokenDetails.cache_creation_input_tokens = snapshot.cacheCreationInputTokens;
        }
        if (Object.keys(promptTokenDetails).length > 0) {
            usagePayload.prompt_tokens_details = promptTokenDetails;
        }

        // Add completion token details if we have them
        const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {};
        if (snapshot.reasoningTokens > 0) {
            completionTokenDetails.reasoning_tokens = snapshot.reasoningTokens;
        }
        if (snapshot.toolTokens > 0) {
            completionTokenDetails.tool_tokens = snapshot.toolTokens;
        }
        if (snapshot.acceptedPredictionTokens > 0) {
            completionTokenDetails.accepted_prediction_tokens = snapshot.acceptedPredictionTokens;
        }
        if (snapshot.rejectedPredictionTokens > 0) {
            completionTokenDetails.rejected_prediction_tokens = snapshot.rejectedPredictionTokens;
        }
        if (Object.keys(completionTokenDetails).length > 0) {
            usagePayload.completion_tokens_details = completionTokenDetails;
        }

        // Add optional fields
        if (snapshot.systemPromptTokens > 0) {
            usagePayload.system_prompt_tokens = snapshot.systemPromptTokens;
        }
        if (this._reservedOutputTokens !== undefined) {
            usagePayload.reserved_output_tokens = this._reservedOutputTokens;
        }
        if (this._totalTokenMax !== undefined) {
            usagePayload.total_token_max = this._totalTokenMax;
        }

        if (snapshot.estimatedInputCost !== undefined) {
            usagePayload.estimated_input_cost = snapshot.estimatedInputCost;
        }
        if (snapshot.estimatedOutputCost !== undefined) {
            usagePayload.estimated_output_cost = snapshot.estimatedOutputCost;
        }
        if (snapshot.estimatedTotalCost !== undefined) {
            usagePayload.estimated_total_cost = snapshot.estimatedTotalCost;
        }

        // Emit the usage DataPart
        const payloadJson = JSON.stringify(usagePayload);
        const payloadBytes = new TextEncoder().encode(payloadJson);
        this._inner.report(new vscode.LanguageModelDataPart(payloadBytes, "usage"));
    }

    private _intercept(part: vscode.LanguageModelResponsePart): void {
        if (this._isThinkingPart(part)) {
            const value = this._extractThinkingValue(part);
            this._reasoningBuffer += value;
            // Also count in text buffer for total completion tokens
            this._textBuffer += value;
        }
        // Text → accumulate for completion token estimation
        else if (part instanceof vscode.LanguageModelTextPart) {
            this._textBuffer += part.value;
        }
        // Tool calls → estimate tokens from name + args
        else if (part instanceof vscode.LanguageModelToolCallPart) {
            const toolText = `${part.name}${JSON.stringify(part.input ?? {})}`;
            this._toolCallTokens += countTokens(toolText, this._modelId, this._modelInfo);
        }
        // Usage DataPart → capture upstream usage, enrich, and forward
        else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
            this._handleUsageDataPart(part);
            return; // _handleUsageDataPart forwards enriched part itself
        }

        // Forward every part to the inner progress
        this._inner.report(part);
    }

    private _handleUsageDataPart(part: vscode.LanguageModelDataPart): void {
        try {
            const parsed = JSON.parse(new TextDecoder().decode(part.data)) as OpenAIUsagePayload;
            this._sawUpstreamUsage = true;

            // Monotonic merge: when upstream sends multiple usage frames (e.g. mid-stream
            // + final), pick Math.max to avoid regressing counts.
            this._upstream = this._upstream ? this._mergeMonotonic(this._upstream, parsed) : parsed;

            // Enrich with internal estimates for missing fields
            const completionDetails: OpenAIUsageCompletionTokenDetails = {
                ...(this._upstream.completion_tokens_details ?? {}),
            };
            if (completionDetails.tool_tokens === undefined && this._toolCallTokens > 0) {
                completionDetails.tool_tokens = this._toolCallTokens;
            }
            if (completionDetails.reasoning_tokens === undefined && this._reasoningBuffer.length > 0) {
                completionDetails.reasoning_tokens = countTokens(this._reasoningBuffer, this._modelId, this._modelInfo);
            }

            const promptDetails: OpenAIUsagePromptTokenDetails | undefined = this._upstream.prompt_tokens_details;
            const completionCount = this._resolveOutputTokens();
            const promptCount = this._upstream.prompt_tokens ?? this._estimatedPromptTokens;

            const enriched: OpenAIUsagePayload = {
                ...this._upstream,
                completion_tokens: completionCount,
                total_tokens: promptCount + completionCount,
                system_prompt_tokens:
                    this._upstream.system_prompt_tokens ?? (this._estimatedSystemPromptTokens || undefined),
                prompt_tokens_details: promptDetails,
                completion_tokens_details: Object.keys(completionDetails).length > 0 ? completionDetails : undefined,
                reserved_output_tokens: this._upstream.reserved_output_tokens ?? this._reservedOutputTokens,
                total_token_max: this._upstream.total_token_max ?? this._totalTokenMax,
            };

            const cost: RequestCost = calculateRequestCost({
                promptTokens: enriched.prompt_tokens ?? 0,
                completionTokens: enriched.completion_tokens ?? 0,
                cachedTokens: enriched.prompt_tokens_details?.cached_tokens ?? 0,
                cacheCreationInputTokens: enriched.prompt_tokens_details?.cache_creation_input_tokens ?? 0,
                cacheCreation5mTokens:
                    enriched.prompt_tokens_details?.cache_creation_token_details?.ephemeral_5m_input_tokens,
                cacheCreation1hTokens:
                    enriched.prompt_tokens_details?.cache_creation_token_details?.ephemeral_1h_input_tokens,
                pricing: this._pricing,
            });
            enriched.estimated_input_cost = cost.inputCost;
            enriched.estimated_output_cost = cost.outputCost;
            enriched.estimated_total_cost = cost.totalCost;

            // Re-encode and forward the enriched usage
            const enrichedBytes = new TextEncoder().encode(JSON.stringify(enriched));
            this._inner.report(new vscode.LanguageModelDataPart(enrichedBytes, "usage"));
        } catch {
            // Malformed usage: forward as-is
            this._inner.report(part);
        }
    }

    /**
     * Monotonic merge: when upstream sends multiple usage frames, pick the larger
     * value for each field to avoid regressing counts mid-stream.
     */
    private _mergeMonotonic(prev: OpenAIUsagePayload, next: OpenAIUsagePayload): OpenAIUsagePayload {
        const pick = (a?: number, b?: number): number | undefined => {
            if (typeof a === "number" && typeof b === "number") {
                return Math.max(a, b);
            }
            return typeof a === "number" ? a : b;
        };

        const promptTokens = pick(prev.prompt_tokens, next.prompt_tokens) ?? 0;
        const completionTokens = pick(prev.completion_tokens, next.completion_tokens) ?? 0;
        const cacheCreation5mTokens = pick(
            prev.prompt_tokens_details?.cache_creation_token_details?.ephemeral_5m_input_tokens,
            next.prompt_tokens_details?.cache_creation_token_details?.ephemeral_5m_input_tokens
        );
        const cacheCreation1hTokens = pick(
            prev.prompt_tokens_details?.cache_creation_token_details?.ephemeral_1h_input_tokens,
            next.prompt_tokens_details?.cache_creation_token_details?.ephemeral_1h_input_tokens
        );

        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            system_prompt_tokens: pick(prev.system_prompt_tokens, next.system_prompt_tokens),
            prompt_tokens_details: {
                cached_tokens: pick(
                    prev.prompt_tokens_details?.cached_tokens,
                    next.prompt_tokens_details?.cached_tokens
                ),
                cache_creation_input_tokens: pick(
                    prev.prompt_tokens_details?.cache_creation_input_tokens,
                    next.prompt_tokens_details?.cache_creation_input_tokens
                ),
                // The tiers are priced separately, so the split has to survive a
                // second usage frame; without it every cache write is billed at the
                // five-minute rate.
                cache_creation_token_details:
                    cacheCreation5mTokens === undefined && cacheCreation1hTokens === undefined
                        ? undefined
                        : {
                              ephemeral_5m_input_tokens: cacheCreation5mTokens,
                              ephemeral_1h_input_tokens: cacheCreation1hTokens,
                          },
            },
            completion_tokens_details: {
                reasoning_tokens: pick(
                    prev.completion_tokens_details?.reasoning_tokens,
                    next.completion_tokens_details?.reasoning_tokens
                ),
                tool_tokens: pick(
                    prev.completion_tokens_details?.tool_tokens,
                    next.completion_tokens_details?.tool_tokens
                ),
                accepted_prediction_tokens: pick(
                    prev.completion_tokens_details?.accepted_prediction_tokens,
                    next.completion_tokens_details?.accepted_prediction_tokens
                ),
                rejected_prediction_tokens: pick(
                    prev.completion_tokens_details?.rejected_prediction_tokens,
                    next.completion_tokens_details?.rejected_prediction_tokens
                ),
            },
            reserved_output_tokens: prev.reserved_output_tokens ?? next.reserved_output_tokens,
            total_token_max: prev.total_token_max ?? next.total_token_max,
        };
    }

    private _isThinkingPart(part: vscode.LanguageModelResponsePart): boolean {
        const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
        if (ThinkingPart && part instanceof (ThinkingPart as new (...args: unknown[]) => unknown)) {
            return true;
        }
        return false;
    }

    private _extractThinkingValue(part: vscode.LanguageModelResponsePart): string {
        const tp = part as unknown as { value: string | string[] };
        if (Array.isArray(tp.value)) {
            return tp.value.join("");
        }
        return tp.value as string;
    }
}
