import * as assert from "assert";
import * as vscode from "vscode";

import { convertMessages } from "../../utils";
import type { OpenAIChatMessage } from "../../types";

suite("convertMessages data parts", () => {
    test("convertMessages handles various data parts", () => {
        const jsonPart = new vscode.LanguageModelDataPart(Buffer.from('{"a":1}'), "application/json");
        const textPart = new vscode.LanguageModelDataPart(Buffer.from("extra text"), "text/plain");
        const cachePart = new vscode.LanguageModelDataPart(Buffer.from("cache"), "cache_control");

        const msgs = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [jsonPart, textPart, cachePart],
                name: undefined,
            },
        ];

        const out = convertMessages(msgs) as unknown as OpenAIChatMessage[];
        assert.strictEqual(out.length, 1);
        assert.ok(out[0].content?.toString().includes('{"a":1}'));
        assert.ok(out[0].content?.toString().includes("extra text"));
    });

    test("convertMessages ignores data parts whose MIME type is not content", () => {
        const msgs: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelDataPart(Buffer.from("ephemeral"), "cache_control"),
                    new vscode.LanguageModelDataPart(
                        Buffer.from('{"$mid":24,"mimeType":"cache_control","data":"ZXBoZW1lcmFs"}'),
                        "application/vnd.cache-control+json"
                    ),
                    new vscode.LanguageModelTextPart("visible"),
                ],
            },
        ];

        const out = convertMessages(msgs) as { role: string; content: string }[];

        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].content, "visible");
    });

    test("tool result serialization keeps text and ignores a non-content data part", () => {
        const msgs: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelToolCallPart("call-1", "tool", {})],
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolResultPart("call-1", [
                        new vscode.LanguageModelDataPart(Buffer.from("ephemeral"), "cache_control"),
                        new vscode.LanguageModelTextPart("real tool output"),
                    ]),
                ],
            },
        ];

        const out = convertMessages(msgs);
        const serialized = JSON.stringify(out);

        assert.ok(serialized.includes("real tool output"));
        assert.ok(!serialized.includes("ephemeral"), "a non-content data part must not leak");
    });

    test("decodes a multi-byte UTF-8 text data part", () => {
        const text = "café 日本語 🙂";
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelDataPart(Buffer.from(text, "utf8"), "text/plain")],
            },
        ];

        const out = convertMessages(messages) as unknown as OpenAIChatMessage[];

        assert.strictEqual(out[0].content, text);
    });

    test("decodes a multi-byte UTF-8 tool result data part", () => {
        const text = "café 日本語 🙂";
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelToolCallPart("call-1", "tool", {})],
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolResultPart("call-1", [
                        new vscode.LanguageModelDataPart(Buffer.from(text, "utf8"), "text/plain"),
                    ]),
                ],
            },
        ];

        const out = convertMessages(messages);
        const serialized = JSON.stringify(out);

        assert.ok(serialized.includes(text), "a multi-byte tool result must survive decoding");
    });

    test("base64-encodes a large image without losing bytes", () => {
        // Covers every byte value across a payload larger than any encoder chunk, so a
        // truncation, an offset, or a byte-order error fails the comparison below.
        const bytes = Buffer.alloc(200_000);
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = index % 256;
        }
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [vscode.LanguageModelDataPart.image(bytes, "image/png")],
            },
        ];

        const out = convertMessages(messages) as unknown as OpenAIChatMessage[];
        const item = (out[0].content as { image_url: { url: string } }[])[0];

        const encoded = item.image_url.url.replace("data:image/png;base64,", "");
        assert.deepStrictEqual(Buffer.from(encoded, "base64"), bytes);
    });

    test("encodes only the bytes of a subarray view", () => {
        // An image handed over as a view into a larger buffer must not carry its
        // neighbours into the data URL.
        const backing = Buffer.from([9, 9, 3, 4, 5, 9, 9]);
        const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 3);
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [vscode.LanguageModelDataPart.image(view, "image/png")],
            },
        ];

        const out = convertMessages(messages) as unknown as OpenAIChatMessage[];
        const item = (out[0].content as { image_url: { url: string } }[])[0];

        const encoded = item.image_url.url.replace("data:image/png;base64,", "");
        assert.deepStrictEqual([...Buffer.from(encoded, "base64")], [3, 4, 5]);
    });
});
