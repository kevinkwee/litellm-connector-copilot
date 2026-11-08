import * as assert from "assert";
import * as vscode from "vscode";

import { convertMessages } from "../../utils/messageConversion";

suite("convertMessages tool names", () => {
    test("convertMessages sanitizes a replayed tool call when no wire-name map is supplied", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("call-1", "search files", {})],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")])],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as {
            tool_calls?: { function: { name: string } }[];
        }[];

        assert.strictEqual(out[0].tool_calls?.[0].function.name, "search_files");
    });

    test("convertMessages sends a replayed tool call under the advertised wire name", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelToolCallPart("call-1", "github_create_issue", {}),
                    new vscode.LanguageModelToolCallPart("call-2", "search files", {}),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")]),
                    new vscode.LanguageModelToolResultPart("call-2", [new vscode.LanguageModelTextPart("ok")]),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages, {
            wireToolNames: new Map([
                ["github_create_issue", "github_create_issue_2"],
                ["search files", "search_files"],
            ]),
        }) as { tool_calls?: { function: { name: string } }[] }[];

        assert.deepStrictEqual(
            out[0].tool_calls?.map((call) => call.function.name),
            ["github_create_issue_2", "search_files"]
        );
    });
});
