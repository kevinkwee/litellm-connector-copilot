import * as assert from "assert";

import {
    CONNECTOR_NOTICE_PREFIX,
    describeDroppedToolCalls,
    describeStoppedEarly,
    formatConnectorNotice,
} from "../connectorNotice";

suite("connectorNotice", () => {
    test("formatConnectorNotice prefixes the message", () => {
        assert.strictEqual(formatConnectorNotice("boom"), `${CONNECTOR_NOTICE_PREFIX} boom`);
    });

    test("formatConnectorNotice prefixes an empty message", () => {
        assert.ok(formatConnectorNotice("").startsWith(`${CONNECTOR_NOTICE_PREFIX} `));
    });

    suite("describeStoppedEarly", () => {
        test("names the output token limit for a length finish", () => {
            const described = describeStoppedEarly("length");

            assert.strictEqual(described?.reason, "length");
            assert.ok(described.notice.includes("output token limit"));
        });

        test("names the content filter for a content_filter finish", () => {
            const described = describeStoppedEarly("content_filter");

            assert.strictEqual(described?.reason, "content_filter");
            assert.ok(described.notice.includes("content filter"));
        });

        test("starts the notice on its own block", () => {
            const described = describeStoppedEarly("length");
            assert.ok(described);

            assert.ok(described.notice.startsWith(`\n\n${CONNECTOR_NOTICE_PREFIX} `));
        });

        test("returns nothing for a finish reason that completes the answer", () => {
            assert.strictEqual(describeStoppedEarly("stop"), undefined);
        });

        test("returns nothing when the stream reported no finish reason", () => {
            assert.strictEqual(describeStoppedEarly(undefined), undefined);
        });
    });

    suite("describeDroppedToolCalls", () => {
        test("names the single tool it dropped", () => {
            const notice = describeDroppedToolCalls([{ id: "call_1", name: "read_file" }]);

            assert.ok(notice.startsWith(`\n\n${CONNECTOR_NOTICE_PREFIX} `));
            assert.ok(notice.includes(`the "read_file" tool was not run`));
        });

        test("names each tool once and counts the calls", () => {
            const notice = describeDroppedToolCalls([
                { id: "call_1", name: "read_file" },
                { id: "call_2", name: "read_file" },
                { id: "call_3", name: "search_files" },
            ]);

            assert.ok(notice.includes("3 tool calls"), "the count matches the calls, not the names");
            assert.ok(notice.includes(`the "read_file", "search_files" tools were not run`));
            assert.strictEqual(notice.split(`"read_file"`).length - 1, 1, "a repeated name is named once");
        });
    });
});
