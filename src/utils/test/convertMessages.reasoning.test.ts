import * as assert from "assert";
import * as vscode from "vscode";

import { convertMessages } from "../../utils/messageConversion";

suite("convertMessages reasoning", () => {
    test("convertMessages emits reasoning-only assistant message (resume support)", () => {
        // A reasoning-only assistant message has a ThinkingPart (duck-typed:
        // value property, no role) but no text/tool-call parts. It must be
        // emitted on the wire with reasoning_content and an explicit
        // empty-string content, so the model can continue its cut-off
        // reasoning.
        const thinkingPart = { value: "I was analyzing the bug when the connection dropped" };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [thinkingPart as unknown as vscode.LanguageModelTextPart],
                name: undefined,
            },
        ];

        const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]) as {
            role: string;
            content?: unknown;
            reasoning_content?: string;
        }[];
        assert.strictEqual(out.length, 1, "reasoning-only message must not be dropped");
        assert.strictEqual(out[0].role, "assistant");
        assert.strictEqual(out[0].reasoning_content, "I was analyzing the bug when the connection dropped");
        assert.strictEqual(out[0].content, "", "reasoning-only assistant turn must carry empty-string content");
        assert.ok(JSON.stringify(out).includes('"content":""'), "content must survive serialization");
    });

    test("convertMessages does not emit reasoning for user/system roles", () => {
        const thinkingPart = { value: "should not appear" };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [thinkingPart as unknown as vscode.LanguageModelTextPart],
                name: undefined,
            },
        ];

        const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]) as {
            role: string;
            content?: unknown;
            reasoning_content?: string;
        }[];
        const serialized = JSON.stringify(out);
        assert.ok(!serialized.includes("should not appear"), "user-role thinking must not leak to the wire");
        assert.ok(!serialized.includes("reasoning_content"));
    });

    test("convertMessages replays signed thinking parts as thinking_blocks next to tool calls", () => {
        const signedPart = {
            value: "",
            id: "litellm-thinking-1",
            metadata: { signature: "SIG1", _completeThinking: "Plan the read first" },
        };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    signedPart as unknown as vscode.LanguageModelTextPart,
                    new vscode.LanguageModelToolCallPart("call-seal", "read", { p: 1 }),
                ],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages) as {
            role: string;
            content?: unknown;
            reasoning_content?: string;
            thinking_blocks?: { type: string; thinking?: string; signature?: string }[];
        }[];

        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].reasoning_content, undefined, "blocks replace the reasoning_content path");
        assert.deepStrictEqual(out[0].thinking_blocks, [
            { type: "thinking", thinking: "Plan the read first", signature: "SIG1" },
        ]);
    });

    test("convertMessages replays omitted-display signed blocks with empty thinking text", () => {
        const signedPart = {
            value: "",
            id: "litellm-thinking-1",
            metadata: { signature: "SIG2", _completeThinking: "" },
        };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [signedPart as unknown as vscode.LanguageModelTextPart],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages) as {
            thinking_blocks?: { type: string; thinking?: string; signature?: string }[];
            reasoning_content?: string;
        }[];

        assert.deepStrictEqual(out[0].thinking_blocks, [{ type: "thinking", thinking: "", signature: "SIG2" }]);
        assert.strictEqual(out[0].reasoning_content, undefined);
    });

    test("convertMessages replays redacted payloads and keeps the turn emitted", () => {
        const redactedPart = { value: "", id: "litellm-thinking-1", metadata: { redactedData: "ENC3" } };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [redactedPart as unknown as vscode.LanguageModelTextPart],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages) as {
            role: string;
            content?: unknown;
            reasoning_content?: string;
            thinking_blocks?: { type: string; data?: string }[];
        }[];

        assert.strictEqual(out[0].reasoning_content, undefined);
        assert.deepStrictEqual(out[0].thinking_blocks, [{ type: "redacted_thinking", data: "ENC3" }]);
    });

    test("convertMessages keeps unsigned thinking parts on reasoning_content", () => {
        const unsignedPart = { value: "plain resume reasoning" };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [unsignedPart as unknown as vscode.LanguageModelTextPart],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages) as { reasoning_content?: string; thinking_blocks?: unknown }[];

        assert.strictEqual(out[0].reasoning_content, "plain resume reasoning");
        assert.strictEqual(out[0].thinking_blocks, undefined);
    });

    test("convertMessages fills empty reasoning_content for active-turn assistant turns", () => {
        const callId = "call-deepseek-1";
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("do the work")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(callId, "run", { x: 1 })],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")])],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("done")],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages, { ensureReasoningContentInActiveTurn: true }) as {
            role: string;
            reasoning_content?: string;
        }[];
        const serialized = JSON.stringify(out);

        assert.strictEqual(out[1].reasoning_content, "", "tool-call turn without reasoning must carry the field");
        assert.strictEqual(out[3].reasoning_content, "", "text turn without reasoning must carry the field");
        assert.ok(serialized.includes('"reasoning_content":""'), "empty string must survive serialization");
        assert.ok(!serialized.includes('reasoning_content":null'), "the field must be a string");
    });

    test("convertMessages leaves completed turns untouched when filling the active turn", () => {
        const firstCallId = "call-deepseek-completed";
        const secondCallId = "call-deepseek-active";
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("first turn")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(firstCallId, "run", {})],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart(firstCallId, [new vscode.LanguageModelTextPart("ok")]),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("second turn")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(secondCallId, "run", {})],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages, { ensureReasoningContentInActiveTurn: true }) as {
            role: string;
            reasoning_content?: string;
        }[];

        assert.strictEqual(out[1].reasoning_content, undefined, "completed turn must keep its original payload");
        assert.strictEqual(out[4].reasoning_content, "", "active turn must carry the empty field");
    });

    test("convertMessages preserves replayed reasoning in the active turn", () => {
        const reasoningPart = { value: "real reasoning" };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("continue")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    reasoningPart as unknown as vscode.LanguageModelTextPart,
                    new vscode.LanguageModelToolCallPart("call-deepseek-reasoned", "run", {}),
                ],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages, { ensureReasoningContentInActiveTurn: true }) as {
            reasoning_content?: string;
        }[];

        assert.strictEqual(out[1].reasoning_content, "real reasoning");
    });

    test("convertMessages does not let a hoisted tool-result image message close the active turn", () => {
        const callId = "call-deepseek-image";
        const image = vscode.LanguageModelDataPart.image(new Uint8Array(Buffer.from("png")), "image/png");
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("inspect")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(callId, "screenshot", {})],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart(callId, [image])],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("call-deepseek-next", "run", {})],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages, {
            toolResultImageMode: "hoist",
            ensureReasoningContentInActiveTurn: true,
        }) as { role: string; reasoning_content?: string }[];

        assert.strictEqual(out[1].reasoning_content, "", "the tool-call turn before the hoisted image is active");
        assert.strictEqual(
            out[out.length - 1].reasoning_content,
            "",
            "the turn after the hoisted image is still active"
        );
    });

    test("convertMessages does not replay signatures for user roles", () => {
        const signedPart = { value: "", id: "id-x", metadata: { signature: "SIGUSER", _completeThinking: "s" } };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [signedPart as unknown as vscode.LanguageModelTextPart],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages) as unknown[];
        const serialized = JSON.stringify(out);
        assert.ok(!serialized.includes("SIGUSER"), "user-role signed thinking must not reach the wire");
        assert.ok(!serialized.includes("thinking_blocks"));
    });

    test("convertMessages keeps blocks of multiple sealed parts in emission order", () => {
        const first = { value: "", id: "a", metadata: { signature: "SIG1", _completeThinking: "one" } };
        const second = { value: "", id: "b", metadata: { redactedData: "ENC9" } };
        const third = { value: "", id: "c", metadata: { signature: "SIG2", _completeThinking: "" } };
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [first, second, third].map((p) => p as unknown as vscode.LanguageModelTextPart),
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];

        const out = convertMessages(messages) as {
            thinking_blocks?: { type: string; thinking?: string; signature?: string; data?: string }[];
        }[];

        assert.deepStrictEqual(out[0].thinking_blocks, [
            { type: "thinking", thinking: "one", signature: "SIG1" },
            { type: "redacted_thinking", data: "ENC9" },
            { type: "thinking", thinking: "", signature: "SIG2" },
        ]);
    });
});
