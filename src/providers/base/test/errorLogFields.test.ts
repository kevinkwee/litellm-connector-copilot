import * as assert from "assert";

import { LiteLLMApiError, LiteLLMRateLimitError } from "../../../adapters/litellmClient";
import { UpstreamStreamError } from "../../../utils/transportRetry";
import { describeFailureForLog, toErrorLogFields } from "../errorLogFields";

const SENTINEL = "SECRET_PROMPT_TEXT";

suite("toErrorLogFields", () => {
    test("keeps identifiers and drops the body of a proxy rejection", () => {
        const err = new LiteLLMApiError(
            400,
            JSON.stringify({ error: { message: SENTINEL, type: "invalid_request_error", code: 4001 } }),
            `LiteLLM API error: 400 Bad Request\n{"error":{"message":"${SENTINEL}"}}`
        );

        const fields = toErrorLogFields(err);

        assert.strictEqual(fields.errorName, "LiteLLMApiError");
        assert.strictEqual(fields.status, 400);
        assert.strictEqual(fields.upstreamErrorType, "invalid_request_error");
        assert.strictEqual(fields.upstreamErrorCode, "4001");
        assert.strictEqual(typeof fields.bodyLength, "number");
        assert.ok(!JSON.stringify(fields).includes(SENTINEL), "the upstream body must not be logged");
    });

    test("reads a numeric upstream code as text", () => {
        const err = new LiteLLMApiError(429, JSON.stringify({ error: { code: 429 } }), "LiteLLM API error: 429");

        assert.strictEqual(toErrorLogFields(err).upstreamErrorCode, "429");
    });

    test("survives a body that is not JSON", () => {
        const err = new LiteLLMApiError(502, `<html>${SENTINEL}</html>`, `LiteLLM API error: 502\n${SENTINEL}`);

        const fields = toErrorLogFields(err);

        assert.strictEqual(fields.status, 502);
        assert.strictEqual(fields.upstreamErrorType, undefined);
        assert.ok(!JSON.stringify(fields).includes(SENTINEL));
    });

    test("keeps only identifiers and the detail length of a stream failure", () => {
        const err = new UpstreamStreamError(529, "overloaded_error", "overloaded_error", SENTINEL);

        const fields = toErrorLogFields(err);

        assert.strictEqual(fields.status, 529);
        assert.strictEqual(fields.upstreamErrorCode, "overloaded_error");
        assert.strictEqual(fields.detailLength, SENTINEL.length);
        assert.ok(!JSON.stringify(fields).includes(SENTINEL), "the streamed detail must not be logged");
    });

    test("keeps the message and cause of a connector error", () => {
        const err = new Error("fetch failed", { cause: new Error("ECONNREFUSED") });

        const fields = toErrorLogFields(err);

        assert.strictEqual(fields.errorMessage, "fetch failed");
        assert.strictEqual(fields.rootCause, "ECONNREFUSED");
        assert.strictEqual(typeof fields.errorStack, "string");
    });

    test("treats a provider-formatted proxy rejection as upstream text", () => {
        const err = new Error(`LiteLLM API error: 400 Bad Request\n${SENTINEL}`);

        const fields = toErrorLogFields(err);

        assert.strictEqual(fields.status, 400);
        assert.strictEqual(fields.errorMessage, undefined);
        assert.ok(!JSON.stringify(fields).includes(SENTINEL));
    });

    test("names a non-Error value without repeating it", () => {
        const fields = toErrorLogFields("boom");

        assert.strictEqual(fields.errorName, "string");
        assert.strictEqual(fields.errorMessage, undefined);
    });

    test("keeps an upstream-shaped cause out of rootCause", () => {
        const cause = new Error(`LiteLLM API error: 400 Bad Request\n${SENTINEL}`);
        const err = new Error("wrapped", { cause });

        const fields = toErrorLogFields(err);

        assert.strictEqual(fields.rootCause, undefined);
        assert.ok(!JSON.stringify(fields).includes(SENTINEL));
    });
});

suite("describeFailureForLog", () => {
    test("keeps an upstream name and status only", () => {
        assert.strictEqual(
            describeFailureForLog(new LiteLLMApiError(500, "{}", "LiteLLM API error: 500")),
            "LiteLLMApiError:500"
        );
    });

    test("omits a status the error does not carry", () => {
        assert.strictEqual(describeFailureForLog(new TypeError("terminated")), "TypeError");
    });

    test("names a give-up rate limit by its status", () => {
        const err = new LiteLLMRateLimitError(
            { reason: "budget_exhausted", waitedMs: 0, budgetMs: 0 },
            "Too Many Requests",
            "{}"
        );

        assert.strictEqual(describeFailureForLog(err), "LiteLLMRateLimitError:429");
    });
});
