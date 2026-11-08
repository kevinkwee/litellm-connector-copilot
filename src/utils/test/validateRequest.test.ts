import * as assert from "assert";
import * as vscode from "vscode";

import { validateRequest } from "../../utils/messageConversion";

/** A tool call part with a fixed name and arguments, identified by `callId`. */
function call(callId: string): vscode.LanguageModelToolCallPart {
    return new vscode.LanguageModelToolCallPart(callId, "run", {});
}

/** A tool result answering `callId` with one text part. */
function result(callId: string): vscode.LanguageModelToolResultPart {
    return new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
}

suite("validateRequest", () => {
    test("validateRequest throws when tool call is followed by non-user message", () => {
        const callId = "abc";
        const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
        const invalid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
            // Next message is assistant (should be user tool result)
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("x")],
                name: undefined,
            },
        ];
        assert.throws(() => validateRequest(invalid));
    });

    test("validateRequest enforces tool result pairing", () => {
        const callId = "xyz";
        const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
        const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
        const valid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
        ];
        assert.doesNotThrow(() => validateRequest(valid));

        const invalid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("missing")],
                name: undefined,
            },
        ];
        assert.throws(() => validateRequest(invalid));
    });

    test("validateRequest with multiple tool calls requires matching results", () => {
        const callA = new vscode.LanguageModelToolCallPart("a", "ta", {});
        const callB = new vscode.LanguageModelToolCallPart("b", "tb", {});
        const resA = new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]);
        const resB = new vscode.LanguageModelToolResultPart("b", [new vscode.LanguageModelTextPart("rb")]);
        const valid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [resA, resB], name: undefined },
        ];
        assert.doesNotThrow(() => validateRequest(valid));

        const missing: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [resA], name: undefined },
        ];
        assert.throws(() => validateRequest(missing));
    });

    test("validateRequest handles edge cases", () => {
        assert.throws(() => validateRequest([]));

        assert.throws(() =>
            validateRequest([{ role: vscode.LanguageModelChatMessageRole.User, content: [], name: undefined }])
        );
    });

    test("accepts a tool result message that also carries text", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [call("a")], name: undefined },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("here is the file"), result("a")],
                name: undefined,
            },
        ];

        assert.doesNotThrow(() => validateRequest(messages));
    });

    test("accepts results split across consecutive user messages", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [call("a"), call("b")], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [result("a")], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [result("b")], name: undefined },
        ];

        assert.doesNotThrow(() => validateRequest(messages));
    });

    test("does not accept a result for a different call id", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [call("a")], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [result("elsewhere")], name: undefined },
            // The right result follows, but the window already ended, so it cannot rescue it.
            { role: vscode.LanguageModelChatMessageRole.User, content: [result("a")], name: undefined },
        ];

        assert.throws(() => validateRequest(messages), /matching callId/);
    });

    test("rejects a text-only user message between the call and its result", () => {
        // Results have to follow their calls directly, which is the shape providers accept.
        const messages: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [call("a")], name: undefined },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("one moment")],
                name: undefined,
            },
            { role: vscode.LanguageModelChatMessageRole.User, content: [result("a")], name: undefined },
        ];

        assert.throws(() => validateRequest(messages), /matching callId/);
    });

    test("accepts an assistant turn with no parts", () => {
        // VS Code can send such a turn; it carries nothing to forward.
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [], name: undefined },
        ];

        assert.doesNotThrow(() => validateRequest(messages));
    });
});
