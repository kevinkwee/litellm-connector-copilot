import * as assert from "assert";
import {
    EffortFallbackCache,
    hasShownReasoningFallbackNotification,
    isReasoningError,
    markReasoningFallbackNotified,
} from "../reasoningEffortFallback";

interface HttpErrorLike {
    status?: number;
    statusCode?: number;
    message?: string;
    body?: unknown;
}

suite("reasoningEffortFallback", () => {
    let cache: EffortFallbackCache;

    setup(() => {
        cache = new EffortFallbackCache();
    });

    test("getEffectiveEffort returns requested effort when there are no recorded failures", () => {
        const effort = cache.getEffectiveEffort("model-a", "high");
        assert.strictEqual(effort, "high");
    });

    test("recordFailure walks the effort ladder until the effort is omitted", () => {
        type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none" | undefined;

        let effort: ReasoningEffort = "xhigh";
        const expectedNext: ReasoningEffort[] = ["high", "medium", "low", "minimal", "none", undefined];

        for (const expected of expectedNext) {
            const next = cache.recordFailure("model-a", effort);
            assert.strictEqual(next, expected);
            effort = next ?? effort;
        }
    });

    test("getEffectiveEffort skips previously failed efforts", () => {
        cache.recordFailure("model-a", "high");
        cache.recordFailure("model-a", "medium");

        const adjusted = cache.getEffectiveEffort("model-a", "high");

        assert.strictEqual(adjusted, "low");
    });

    test("fallback decisions are isolated per model id", () => {
        cache.recordFailure("model-a", "high");

        const adjustedA = cache.getEffectiveEffort("model-a", "high");
        const adjustedB = cache.getEffectiveEffort("model-b", "high");

        assert.strictEqual(adjustedA, "medium");
        assert.strictEqual(adjustedB, "high");
    });

    suite("isReasoningError", () => {
        const buildError = (error: HttpErrorLike): unknown => error;

        test("returns true for a 400 error message mentioning reasoning tokens", () => {
            const error = buildError({
                status: 400,
                message: "reasoning_effort parameter unsupported",
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns false for a 400 error without reasoning tokens", () => {
            const error = buildError({
                status: 400,
                message: "Bad request",
            });

            assert.strictEqual(isReasoningError(error), false);
        });

        test("returns false for non-4xx errors even when reasoning tokens appear", () => {
            const error = buildError({
                status: 500,
                message: "reasoning effort unavailable",
            });

            assert.strictEqual(isReasoningError(error), false);
        });

        test("returns true for a 422 body error message containing reasoning tokens", () => {
            const error = buildError({
                status: 422,
                body: { error: "Invalid parameter: reasoning_effort" },
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns false for a 400 about reasoning_content without naming the effort", () => {
            // The ladder steps the effort down, so a failure about a different
            // reasoning input must not move it.
            const error = buildError({
                status: 400,
                message: "Invalid parameter: reasoning_content must be passed back to the API",
            });

            assert.strictEqual(isReasoningError(error), false);
        });

        test("returns false when the body mentions reasoning items and a parameter", () => {
            const error = buildError({
                status: 400,
                message: "Unsupported parameter: reasoning items",
            });

            assert.strictEqual(isReasoningError(error), false);
        });

        test("returns true for LiteLLM's Anthropic map rejecting an unmappable level", () => {
            // "Unmapped reasoning effort: 'x'. Must be one of: ..." from the fork's
            // Anthropic transformation.
            const error = buildError({
                status: 400,
                message: "Unmapped reasoning effort: 'ultra'. Must be one of: 'minimal', 'low', 'medium', 'high'.",
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns true when the refusal names the effort as reasoning.effort", () => {
            // A /responses request moves the flat parameter into `reasoning`, so the
            // upstream error names the nested path.
            const error = buildError({
                status: 400,
                body: { error: { message: "Unsupported value: 'xhigh' for 'reasoning.effort'" } },
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns true for the Anthropic effort='level' refusal", () => {
            // "effort='xhigh' is not supported by this model" from the fork's Anthropic
            // transformation.
            const error = buildError({
                status: 400,
                message: "effort='xhigh' is not supported by this model. Got model: claude-opus-5",
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns true when the body names the effort in camelCase", () => {
            // The fork's OCI transform hands the field over in camelCase and does not
            // validate the level, so a refusal can name it that way. No captured message
            // exists, so this body is representative.
            const error = buildError({
                status: 400,
                message: "Unsupported value: 'xhigh' for parameter reasoningEffort",
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns false when the body assigns the effort with double quotes", () => {
            // Only the single-quoted Anthropic form is in the spelling list, so a
            // double-quoted assignment does not qualify.
            const error = buildError({
                status: 400,
                message: "Unsupported value: 'effort=\"high\"' for this model",
            });

            assert.strictEqual(isReasoningError(error), false);
        });
    });

    test("clear resets cached failures", () => {
        cache.recordFailure("model-a", "high");
        assert.strictEqual(cache.getEffectiveEffort("model-a", "high"), "medium");

        cache.clear();

        assert.strictEqual(cache.getEffectiveEffort("model-a", "high"), "high");
    });

    suite("notification dedupe", () => {
        test("marking a notification prevents repeat", () => {
            const keyModel = "model-a";
            const effort = "high" as const;

            assert.strictEqual(hasShownReasoningFallbackNotification(keyModel, effort), false);

            markReasoningFallbackNotified(keyModel, effort);

            assert.strictEqual(hasShownReasoningFallbackNotification(keyModel, effort), true);
        });

        test("dedupe is scoped by model and effort", () => {
            const effort = "medium" as const;
            markReasoningFallbackNotified("model-a", effort);

            assert.strictEqual(hasShownReasoningFallbackNotification("model-b", effort), false);
        });
    });
});
