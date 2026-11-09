import * as assert from "assert";

import type { TokenSnapshot } from "../../../adapters/streaming/streamTokenCapture";
import { buildUsageReportFields, toUsageMetricFields } from "../usageReport";

function snapshot(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
    return {
        promptTokens: 100,
        cachedTokens: 0,
        cacheCreationInputTokens: 0,
        systemPromptTokens: 0,
        completionTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        toolTokens: 0,
        acceptedPredictionTokens: 0,
        rejectedPredictionTokens: 0,
        sawUpstreamUsage: true,
        ...overrides,
    };
}

suite("buildUsageReportFields", () => {
    test("keeps the prompt and output counts even when they are zero", () => {
        // The prompt and output counts always describe the request, so an empty reply
        // still reports that it consumed a prompt.
        const fields = buildUsageReportFields(snapshot({ promptTokens: 0, outputTokens: 0 }));

        assert.deepStrictEqual({ prompt: fields.tokensIn, output: fields.tokensOut }, { prompt: 0, output: 0 });
    });

    test("turns a zero counter into an absent field", () => {
        // A reported zero cannot be told from a missing count, and `n/a` says which one
        // the connector knows, so every optional counter drops a zero.
        const fields = buildUsageReportFields(
            snapshot({
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                reasoningTokens: 0,
                toolTokens: 0,
                systemPromptTokens: 0,
            })
        );

        assert.deepStrictEqual(
            {
                cached: fields.cachedTokens,
                cacheWrite: fields.cacheCreationInputTokens,
                reasoning: fields.reasoningTokens,
                tool: fields.toolTokens,
                accepted: fields.acceptedPredictionTokens,
                rejected: fields.rejectedPredictionTokens,
                systemPrompt: fields.systemPromptTokens,
            },
            {
                cached: undefined,
                cacheWrite: undefined,
                reasoning: undefined,
                tool: undefined,
                accepted: undefined,
                rejected: undefined,
                systemPrompt: undefined,
            }
        );
    });

    test("derives the cache ratio from the prompt and cache counts", () => {
        const fields = buildUsageReportFields(snapshot({ promptTokens: 200, cachedTokens: 50 }));

        assert.strictEqual(fields.cacheReadRatio, 0.25);
    });

    test("reports no cache ratio without a cached count or a prompt", () => {
        assert.deepStrictEqual(
            [
                buildUsageReportFields(snapshot({ promptTokens: 200, cachedTokens: 0 })).cacheReadRatio,
                buildUsageReportFields(snapshot({ promptTokens: 0, cachedTokens: 10 })).cacheReadRatio,
            ],
            [undefined, undefined]
        );
    });

    test("carries the three estimated costs through unchanged", () => {
        const fields = buildUsageReportFields(
            snapshot({ estimatedInputCost: 0.1, estimatedOutputCost: 0.2, estimatedTotalCost: 0.3 })
        );

        assert.deepStrictEqual(
            { input: fields.estimatedInputCost, output: fields.estimatedOutputCost, total: fields.estimatedTotalCost },
            { input: 0.1, output: 0.2, total: 0.3 }
        );
    });
});

suite("toUsageMetricFields", () => {
    test("maps every reported field onto its metric name", () => {
        const fields = buildUsageReportFields(
            snapshot({ promptTokens: 200, outputTokens: 20, cachedTokens: 50, reasoningTokens: 5, toolTokens: 3 })
        );

        assert.deepStrictEqual(toUsageMetricFields(fields), {
            tokensIn: 200,
            tokensOut: 20,
            promptCacheTokens: 50,
            cacheCreationInputTokens: undefined,
            reasoningTokens: 5,
            toolTokens: 3,
            acceptedPredictionTokens: undefined,
            rejectedPredictionTokens: undefined,
            estimatedInputCost: undefined,
            estimatedOutputCost: undefined,
            estimatedTotalCost: undefined,
            cacheReadRatio: 0.25,
        });
    });
});
