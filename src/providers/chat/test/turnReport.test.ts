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
            '{"error":{"message":"unknown parameter: temperature"}}',
            'LiteLLM API error: 400 Bad Request\n{"error":{"message":"unknown parameter: temperature"}}'
        );

        const message = describeTurnFailure(error, "model-1");

        assert.match(message, /drop it there with additional_drop_params/);
    });

    test("tells the user to declare the accepted levels", () => {
        const body = '{"error":{"message":"Unsupported value for reasoning.effort"}}';
        const error = new LiteLLMApiError(400, body, `LiteLLM API error: 400 Bad Request\n${body}`);

        const message = describeTurnFailure(error, "model-1");

        assert.match(message, /supports_<level>_reasoning_effort: true/);
        assert.match(message, /no level flags and no override is offered every level/);
        assert.doesNotMatch(message, /drop_params/, "the notice never suggests drop_params for the effort");
    });

    test("points a whole-parameter rejection at allowed_openai_params first", () => {
        // Shaped like LiteLLM's own UnsupportedParamsError, whose text recommends this fix:
        // the deployment only fails because its provider config omits the parameter.
        const body =
            '{"error":{"message":"litellm.UnsupportedParamsError: openai does not support parameters: [\'reasoning_effort\'], for model=gpt-x. To drop these, set drop_params=true. Otherwise, send allowed_openai_params=[\'reasoning_effort\']"}}';
        const error = new LiteLLMApiError(400, body, `LiteLLM API error: 400 Bad Request\n${body}`);

        const message = describeTurnFailure(error, "model-1");

        assert.match(message, /allowed_openai_params: \["reasoning_effort"\]/);
        assert.match(message, /supports_reasoning: false/, "an upstream that really refuses it keeps that alternative");
        assert.doesNotMatch(message, /Declare exactly the levels/, "a parameter refusal is not a level refusal");
    });

    test("points an upstream refusal at supports_reasoning, not allowed_openai_params", () => {
        // LiteLLM forwarded this one, so listing the parameter would change nothing.
        const body =
            '{"error":{"message":"Unsupported parameter: \'reasoning_effort\' is not supported with this model."}}';
        const error = new LiteLLMApiError(400, body, `LiteLLM API error: 400 Bad Request\n${body}`);

        const message = describeTurnFailure(error, "model-1");

        assert.match(message, /supports_reasoning: false/);
        assert.doesNotMatch(message, /allowed_openai_params/, "the proxy did forward the parameter");
    });

    test("prefers the specific parameter when the body also echoes the effort name", () => {
        // isReasoningEffortRejection matches its halves independently, so the echoed
        // name must not hide the real rejection.
        const body = '{"error":{"message":"unknown parameter: temperature"},"echo":{"prompt":"reasoning_effort"}}';
        const error = new LiteLLMApiError(400, body, `LiteLLM API error: 400 Bad Request\n${body}`);

        const message = describeTurnFailure(error, "model-1");

        assert.match(message, /"temperature"/);
        assert.doesNotMatch(message, /supports_<level>_reasoning_effort/);
    });

    test("appends nothing for a body that only echoes the effort name", () => {
        // A conversation about the proxy config mentions reasoning_effort routinely,
        // so the echo alone must not earn any hint.
        const body = '{"error":{"message":"maximum context length exceeded"},"echo":{"prompt":"reasoning_effort"}}';
        const error = new LiteLLMApiError(400, body, `LiteLLM API error: 400 Bad Request\n${body}`);

        assert.strictEqual(
            describeTurnFailure(error, "model-1"),
            "LiteLLM Error (model-1): maximum context length exceeded"
        );
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
