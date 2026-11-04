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
});
