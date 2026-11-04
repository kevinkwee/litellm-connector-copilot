import * as assert from "assert";

import { sha1BytesAsync, sha256HexAsync } from "../discoveryHash";

suite("discoveryHash", () => {
    test("sha256HexAsync hashes the UTF-8 encoding of its input", async () => {
        // The backend identity key and the discovery cache hash depend on this exact
        // digest, so a change to the encoding or the algorithm has to fail here.
        assert.strictEqual(
            await sha256HexAsync("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });

    test("sha256HexAsync hashes the same string identically", async () => {
        assert.strictEqual(await sha256HexAsync("host.example/v1"), await sha256HexAsync("host.example/v1"));
    });

    test("sha1BytesAsync returns the 20 raw bytes UUID v5 manipulates", async () => {
        const bytes = await sha1BytesAsync("abc");

        assert.strictEqual(bytes.length, 20);
        assert.strictEqual(Buffer.from(bytes).toString("hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    });
});
