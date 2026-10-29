import * as assert from "assert";

import { CONNECTOR_NOTICE_PREFIX, formatConnectorNotice } from "../connectorNotice";

suite("connectorNotice", () => {
    test("formatConnectorNotice prefixes the message", () => {
        assert.strictEqual(formatConnectorNotice("boom"), `${CONNECTOR_NOTICE_PREFIX} boom`);
    });

    test("formatConnectorNotice prefixes an empty message", () => {
        assert.ok(formatConnectorNotice("").startsWith(`${CONNECTOR_NOTICE_PREFIX} `));
    });
});
