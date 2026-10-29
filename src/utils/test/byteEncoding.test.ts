import * as assert from "assert";
import { decodeUtf8, encodeBase64, encodeUtf8 } from "../byteEncoding";

suite("byteEncoding", () => {
    test("encodes every byte value as standard base64", () => {
        const allBytes = Uint8Array.from({ length: 256 }, (_unused, byte) => byte);

        // `Buffer` is the independent reference implementation in the test host.
        assert.strictEqual(encodeBase64(allBytes), Buffer.from(allBytes).toString("base64"));
    });

    test("round-trips multi-byte UTF-8 text", () => {
        const text = "café naïve 日本語 🐈";

        assert.strictEqual(decodeUtf8(encodeUtf8(text)), text);
    });

    test("encodes only the bytes of a subarray view", () => {
        const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const view = backing.subarray(2, 5);

        assert.strictEqual(encodeBase64(view), Buffer.from([3, 4, 5]).toString("base64"));
    });

    test("encodes a payload larger than one chunk without overflowing the stack", () => {
        const large = new Uint8Array(3 * 8192 * 4 + 7);
        for (let index = 0; index < large.length; index++) {
            large[index] = index % 256;
        }

        assert.strictEqual(encodeBase64(large), Buffer.from(large).toString("base64"));
    });

    test("encodes empty bytes as an empty string", () => {
        assert.strictEqual(encodeBase64(new Uint8Array(0)), "");
    });
});
