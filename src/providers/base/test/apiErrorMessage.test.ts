import * as assert from "assert";

import { parseApiError } from "../apiErrorMessage";

suite("parseApiError", () => {
    test("extracts the upstream message from an error body", () => {
        const body = JSON.stringify({ error: { message: "Invalid API key" } });

        assert.strictEqual(parseApiError(401, body), "Invalid API key");
    });

    test("falls back to the raw text when the body is not JSON", () => {
        assert.strictEqual(parseApiError(500, "Internal server error"), "Internal server error");
    });

    test("names the status when the body is empty", () => {
        assert.strictEqual(parseApiError(500, ""), "API request failed with status 500");
    });

    test("cuts a long non-JSON body to 200 characters", () => {
        const body = "x".repeat(500);

        assert.strictEqual(parseApiError(502, body).length, 200);
    });

    test("falls back to the raw text when the error member is not an object", () => {
        assert.strictEqual(parseApiError(400, '{"error":"text"}'), '{"error":"text"}');
    });

    test("falls back to the raw text when the message is not a string", () => {
        assert.strictEqual(parseApiError(400, '{"error":{"message":42}}'), '{"error":{"message":42}}');
    });

    test("falls back to the raw text when the body carries no error member", () => {
        assert.strictEqual(parseApiError(400, '{"detail":"x"}'), '{"detail":"x"}');
    });
});
