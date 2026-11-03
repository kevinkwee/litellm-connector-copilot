import * as assert from "assert";

import { describeTurnFailure } from "../turnReport";
import { LiteLLMApiError, LiteLLMRateLimitError } from "../../../adapters/litellmClient";

suite("describeTurnFailure", () => {
    test("reports a non-upstream failure as it came", () => {
        assert.strictEqual(describeTurnFailure(new Error("boom"), "model-1"), "boom");
    });

    test("names the model and the upstream message for a rejection", () => {
        const error = new LiteLLMApiError(
            400,
            '{"error":{"message":"bad model"}}',
            'LiteLLM API error: 400 Bad Request\n{"error":{"message":"bad model"}}'
        );

        assert.strictEqual(describeTurnFailure(error, "model-1"), "LiteLLM Error (model-1): bad model");
    });

    test("appends the proxy-side fix when the rejection names a parameter", () => {
        const error = new LiteLLMApiError(
            400,
            '{"error":{"message":"unknown parameter: reasoning_effort"}}',
            'LiteLLM API error: 400 Bad Request\n{"error":{"message":"unknown parameter: reasoning_effort"}}'
        );

        const message = describeTurnFailure(error, "model-1");

        assert.match(message, /drop it there with additional_drop_params/);
    });

    test("names the setting that ended a rate-limit give-up", () => {
        const error = new LiteLLMRateLimitError(
            { reason: "budget_exhausted", waitedMs: 0, budgetMs: 0 },
            "Too Many Requests",
            '{"error":{"message":"rate limited"}}'
        );

        assert.match(describeTurnFailure(error, "model-1"), /rateLimitMaxDelaySeconds/);
    });
});
