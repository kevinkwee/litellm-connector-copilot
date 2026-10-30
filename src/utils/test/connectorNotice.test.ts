import * as assert from "assert";

import { CONNECTOR_NOTICE_PREFIX, describeStoppedEarly, formatConnectorNotice } from "../connectorNotice";

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
});
