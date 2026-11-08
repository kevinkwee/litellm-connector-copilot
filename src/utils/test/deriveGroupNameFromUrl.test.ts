import * as assert from "assert";

import { deriveGroupNameFromUrl } from "../../utils/groupNameFromUrl";

suite("deriveGroupNameFromUrl", () => {
    test("returns hostname from https URL", () => {
        const result = deriveGroupNameFromUrl("https://llm-kit.geth.cc");
        assert.strictEqual(result, "llm-kit.geth.cc");
    });

    test("returns hostname from http URL with port", () => {
        const result = deriveGroupNameFromUrl("http://localhost:4000");
        assert.strictEqual(result, "localhost:4000");
    });

    test("returns empty string for empty input", () => {
        const result = deriveGroupNameFromUrl("");
        assert.strictEqual(result, "");
    });

    test("returns empty string for non-URL string", () => {
        const result = deriveGroupNameFromUrl("not-a-url");
        assert.strictEqual(result, "");
    });

    test("strips path and query from URL", () => {
        const result = deriveGroupNameFromUrl("https://proxy.example.com/v1?key=abc");
        assert.strictEqual(result, "proxy.example.com");
    });
});
