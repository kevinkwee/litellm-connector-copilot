import * as assert from "assert";

import { normalizeProxyBaseUrl } from "../proxyBaseUrl";

suite("normalizeProxyBaseUrl", () => {
    test("strips a trailing slash", () => {
        assert.strictEqual(normalizeProxyBaseUrl("https://p/"), "https://p");
    });

    test("strips a terminal chat-completions path and keeps /v1", () => {
        assert.strictEqual(normalizeProxyBaseUrl("https://p/v1/chat/completions"), "https://p/v1");
    });

    test("strips a terminal endpoint path regardless of case", () => {
        assert.strictEqual(normalizeProxyBaseUrl("https://p/RESPONSES/"), "https://p");
    });

    test("keeps a /v1 base unchanged", () => {
        assert.strictEqual(normalizeProxyBaseUrl("https://p/v1"), "https://p/v1");
    });

    test("trims surrounding whitespace", () => {
        assert.strictEqual(normalizeProxyBaseUrl("  https://p/v1/  "), "https://p/v1");
    });

    test("leaves a path that merely contains a keyword mid-path unchanged", () => {
        assert.strictEqual(normalizeProxyBaseUrl("https://p/completions-proxy"), "https://p/completions-proxy");
    });

    test("strips a terminal model-info path", () => {
        assert.strictEqual(normalizeProxyBaseUrl("https://p/model/info"), "https://p");
    });
});
