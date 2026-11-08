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
});
