import * as assert from "assert";

import { CONNECTOR_NOTICE_PREFIX, formatConnectorNotice, splitConnectorNotice } from "../connectorNotice";

suite("connectorNotice", () => {
    test("formatConnectorNotice prefixes the message", () => {
        assert.strictEqual(formatConnectorNotice("boom"), `${CONNECTOR_NOTICE_PREFIX} boom`);
    });

    test("splitConnectorNotice keeps text that only mentions the prefix", () => {
        const modelText = `Use ${CONNECTOR_NOTICE_PREFIX} only for connector output.`;
        const split = splitConnectorNotice(modelText);

        assert.strictEqual(split.modelText, modelText);
        assert.strictEqual(split.notice, undefined);
    });

    test("splitConnectorNotice separates a notice that starts a new block", () => {
        const split = splitConnectorNotice(`feat: partial${"\n\n"}${CONNECTOR_NOTICE_PREFIX} stopped at the limit`);

        assert.strictEqual(split.modelText, "feat: partial");
        assert.strictEqual(split.notice, "stopped at the limit");
    });

    test("splitConnectorNotice separates a notice that starts the response", () => {
        const split = splitConnectorNotice(`${CONNECTOR_NOTICE_PREFIX} failed`);

        assert.strictEqual(split.modelText, "");
        assert.strictEqual(split.notice, "failed");
    });

    test("splitConnectorNotice returns the whole text when there is no notice", () => {
        assert.deepStrictEqual(splitConnectorNotice("feat: add a thing"), { modelText: "feat: add a thing" });
    });
});
