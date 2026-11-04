import * as assert from "assert";

import { isToolResultPart } from "../../utils";

suite("isToolResultPart", () => {
    test("accepts a part that carries a callId and content", () => {
        assert.ok(isToolResultPart({ callId: "x", content: [] }));
    });

    test("rejects a part whose callId is not a string", () => {
        assert.ok(!isToolResultPart({ callId: 1, content: [] }));
    });

    test("rejects a part with a callId but no content", () => {
        assert.ok(!isToolResultPart({ callId: "x" }));
    });

    test("rejects a value with no callId and no content", () => {
        assert.ok(!isToolResultPart({}));
    });

    test("rejects a non-object", () => {
        assert.ok(!isToolResultPart(undefined));
    });
});
