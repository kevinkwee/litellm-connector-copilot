import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages } from "../../utils";

suite("Message Normalization", () => {
    suite("convertMessages", () => {
        test("maps User role to 'user'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 1,
                    content: [new vscode.LanguageModelTextPart("User prompt")],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "user");
        });

        test("maps System role (3) to 'system'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 3,
                    content: [new vscode.LanguageModelTextPart("System prompt")],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "system");
        });

        test("maps Assistant role (2) to 'assistant'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 2,
                    content: [new vscode.LanguageModelTextPart("Assistant response")],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "assistant");
        });
    });
});
