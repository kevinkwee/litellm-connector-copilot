import * as assert from "assert";

import { tryParseJSONObject } from "../../utils/messageConversion";

suite("tryParseJSONObject", () => {
    test("tryParseJSONObject handles valid and invalid JSON", () => {
        assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
        assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
        assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
    });

    test("tryParseJSONObject rejects empty and arrays", () => {
        assert.deepStrictEqual(tryParseJSONObject(""), { ok: false });
        assert.deepStrictEqual(tryParseJSONObject("[]"), { ok: false });
    });

    test("tryParseJSONObject rejects an array of objects", () => {
        // The array carries braces, so only the array check keeps it from becoming tool
        // input. A model that emits a batch of calls produces exactly this shape.
        assert.deepStrictEqual(tryParseJSONObject('[{"path":"a"}]'), { ok: false });
    });

    test("tryParseJSONObject rejects a JSON string that contains braces", () => {
        // A string parses, and its braces satisfy the pre-check, so only the object check
        // can reject it.
        assert.deepStrictEqual(tryParseJSONObject(JSON.stringify('{ "a": 1 }')), { ok: false });
    });

    test("tryParseJSONObject rejects a bare scalar", () => {
        assert.deepStrictEqual(tryParseJSONObject("42"), { ok: false });
        assert.deepStrictEqual(tryParseJSONObject("null"), { ok: false });
    });
});
