import * as assert from "assert";
import * as vscode from "vscode";

import { convertMessages } from "../../utils/messageConversion";
import type { OpenAIChatMessage } from "../../types";

/** Builds an assistant tool call plus its tool result message. */
function buildToolResultMessage(callId: string, resultParts: readonly unknown[]): vscode.LanguageModelChatMessage[] {
    return [
        {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            content: [new vscode.LanguageModelToolCallPart(callId, "run", {})],
            name: undefined,
        },
        {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelToolResultPart(callId, resultParts as vscode.LanguageModelTextPart[])],
            name: undefined,
        },
    ];
}

suite("convertMessages", () => {
    test("convertMessages handles text and images", () => {
        const imgData = new Uint8Array(Buffer.from("abc"));
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelTextPart("see this"),
                    vscode.LanguageModelDataPart.image(imgData, "image/png"),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];
        assert.strictEqual(out.length, 1);
        const content = out[0].content as unknown[];
        assert.ok(Array.isArray(content));
        assert.strictEqual((content[0] as { type: string }).type, "text");
        assert.strictEqual((content[0] as { text: string }).text, "see this");
        assert.strictEqual((content[1] as { type: string }).type, "image_url");
        const url = (content[1] as { image_url: { url: string } }).image_url.url;
        assert.ok(url.startsWith("data:image/png;base64,"));
    });

    test("convertMessages emits tool calls and tool results", () => {
        const callId = "call-1";
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelTextPart("do"),
                    new vscode.LanguageModelToolCallPart(callId, "run", { x: 1 }),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok"), { a: 2 }]),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as {
            role: string;
            content: unknown;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
            tool_call_id?: string;
        }[];
        assert.strictEqual(out.length, 2);
        const assistant = out[0];
        assert.strictEqual(assistant.role, "assistant");
        assert.ok(Array.isArray(assistant.tool_calls));
        assert.strictEqual(assistant.tool_calls[0].function.name, "run");
        assert.strictEqual(assistant.tool_calls[0].function.arguments, '{"x":1}');

        // The wire id carries the normalized fc_ prefix.
        assert.ok(
            assistant.tool_calls[0].id.startsWith("fc_"),
            `Expected ID to start with fc_, got ${assistant.tool_calls[0].id}`
        );

        const toolResult = out[1];
        assert.strictEqual(toolResult.role, "tool");
        // The tool_call_id should match the normalized ID from the assistant message
        assert.strictEqual(toolResult.tool_call_id, assistant.tool_calls[0].id);
        assert.strictEqual(toolResult.content, 'ok\n\n{"a":2}');
    });

    test("convertMessages joins tool result text parts with a blank line by default", () => {
        const messages = buildToolResultMessage("call-join", [
            new vscode.LanguageModelTextPart("first"),
            new vscode.LanguageModelTextPart("second"),
            new vscode.LanguageModelTextPart("third"),
        ]);

        const out = convertMessages(messages) as { role: string; content: unknown }[];

        assert.strictEqual(out[1].content, "first\n\nsecond\n\nthird");
    });

    test("convertMessages keeps one text item per part for a provider that preserves items", () => {
        const messages = buildToolResultMessage("call-separate", [
            new vscode.LanguageModelTextPart("first"),
            new vscode.LanguageModelTextPart("second"),
            new vscode.LanguageModelTextPart("third"),
        ]);

        const out = convertMessages(messages, { toolResultTextMode: "separate" }) as {
            role: string;
            content: unknown;
        }[];

        assert.deepStrictEqual(out[1].content, [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
            { type: "text", text: "third" },
        ]);
    });

    test("convertMessages sends a single tool result part as a plain string in either mode", () => {
        const messages = buildToolResultMessage("call-single", [new vscode.LanguageModelTextPart("only")]);

        for (const toolResultTextMode of ["joined", "separate"] as const) {
            const out = convertMessages(messages, { toolResultTextMode }) as { role: string; content: unknown }[];

            assert.strictEqual(out[1].content, "only", toolResultTextMode);
        }
    });

    test("convertMessages carries tool result images natively in both text modes", () => {
        const messages = buildToolResultMessage("call-images", [
            new vscode.LanguageModelTextPart("chart"),
            new vscode.LanguageModelTextPart("legend"),
            vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png"),
        ]);

        for (const toolResultTextMode of ["joined", "separate"] as const) {
            const out = convertMessages(messages, {
                toolResultImageMode: "native",
                toolResultTextMode,
            }) as { role: string; content: unknown }[];

            const content = out[1].content as { type: string; text?: string }[];
            assert.ok(Array.isArray(content), toolResultTextMode);
            assert.strictEqual(content[0].type, "text");
            assert.strictEqual(content[content.length - 1].type, "image_url");
            assert.strictEqual(
                content.filter((item) => item.type === "text").length,
                toolResultTextMode === "separate" ? 2 : 1,
                toolResultTextMode
            );
        }
    });

    test("merges the notes of two result messages into one user message", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelToolCallPart("a", "run", {}),
                    new vscode.LanguageModelToolCallPart("b", "run", {}),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]),
                    new vscode.LanguageModelTextPart("first note"),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("b", [new vscode.LanguageModelTextPart("rb")]),
                    new vscode.LanguageModelTextPart("second note"),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.deepStrictEqual(
            out.map((m) => m.role),
            ["assistant", "tool", "tool", "user"],
            "both notes travel together after the run"
        );
        assert.strictEqual(out[3].content, "first note\n\nsecond note");
    });

    test("keeps the note of a result message before a following assistant turn", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("a", "run", {})],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]),
                    new vscode.LanguageModelTextPart("a note"),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("the answer")],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.deepStrictEqual(
            out.map((m) => m.role),
            ["assistant", "tool", "user", "assistant"]
        );
        assert.strictEqual(out[2].content, "a note");
    });

    test("keeps tool results contiguous when a result message also carries text", () => {
        // A user message between two tool messages is a shape providers reject, so a
        // result message's own text waits until the run of results ends.
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelToolCallPart("a", "run", {}),
                    new vscode.LanguageModelToolCallPart("b", "run", {}),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]),
                    new vscode.LanguageModelTextPart("one note for both"),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart("b", [new vscode.LanguageModelTextPart("rb")])],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.deepStrictEqual(
            out.map((m) => m.role),
            ["assistant", "tool", "tool", "user"],
            "no user message may sit between two tool messages"
        );
        assert.strictEqual(out[3].content, "one note for both");
    });

    test("defers the image a result message carries beside its results", () => {
        // The deferred content is emitted from a separate buffer, so an image the
        // caller attached to its result message has to survive the deferral intact.
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("a", "run", {})],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]),
                    vscode.LanguageModelDataPart.image(new Uint8Array(Buffer.from("png")), "image/png"),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.deepStrictEqual(
            out.map((m) => m.role),
            ["assistant", "tool", "user"]
        );
        const content = out[2].content as { type: string; image_url: { url: string } }[];
        assert.ok(content[0].image_url.url.startsWith("data:image/png;base64,"));
    });

    test("drops empty text parts so a separator never wraps one", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelTextPart(""),
                    new vscode.LanguageModelTextPart("hello"),
                    new vscode.LanguageModelTextPart(""),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.strictEqual(out[0].content, "hello");
    });

    test("carries no blank text item when an image accompanies empty text parts", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelTextPart(""),
                    new vscode.LanguageModelTextPart(""),
                    new vscode.LanguageModelDataPart(Buffer.from("png"), "image/png"),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as { content: { type: string }[] }[];

        assert.deepStrictEqual(
            out[0].content.map((item) => item.type),
            ["image_url"],
            "an empty text part must not become a blank text item"
        );
    });

    test("emits nothing for an assistant turn with no parts", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [], name: undefined },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.deepStrictEqual(
            out.map((m) => m.role),
            ["user"],
            "an empty assistant turn carries nothing to forward"
        );
    });

    test("joins user text parts with a blank line so two blocks stay apart", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("first block"), new vscode.LanguageModelTextPart("second")],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.strictEqual(out[0].content, "first block\n\nsecond");
    });

    test("joins system text parts with a blank line", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.System,
                content: [new vscode.LanguageModelTextPart("rule one"), new vscode.LanguageModelTextPart("rule two")],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.strictEqual(out[0].content, "rule one\n\nrule two");
    });

    test("concatenates assistant text parts so streamed deltas stay one sentence", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("The answer"), new vscode.LanguageModelTextPart(" is 4.")],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];

        assert.strictEqual(out[0].content, "The answer is 4.");
    });

    test("convertMessages maps user/assistant text", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];
        const out = convertMessages(messages) as unknown as Record<string, unknown>[];
        assert.deepEqual(out, [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ]);
    });

    test("convertMessages defaults unknown roles to system", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                // Force an unknown role value to exercise the default branch.
                role: "weird" as unknown as vscode.LanguageModelChatMessageRole,
                content: [new vscode.LanguageModelTextPart("sys")],
                name: undefined,
            },
        ];
        const out = convertMessages(messages) as unknown as { role: string; content: unknown }[];
        assert.strictEqual(out[0].role, "system");
        assert.strictEqual(out[0].content, "sys");
    });

    test("convertMessages emits assistant tool call even without text", () => {
        const callId = "call-2";
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(callId, "run", { x: 1 })],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as { role: string; tool_calls?: { id: string }[] }[];
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].role, "assistant");
        assert.ok(Array.isArray(out[0].tool_calls));
        assert.strictEqual(out[0].tool_calls?.length, 1);
        assert.ok(out[0].tool_calls?.[0].id.startsWith("fc_"));
    });

    test("convertMessages handles tool call with missing id and input", () => {
        const toolCall = new vscode.LanguageModelToolCallPart("", "mytool", undefined as unknown as object);
        const msgs = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [toolCall],
                name: undefined,
            },
        ];

        const out = convertMessages(msgs) as unknown as OpenAIChatMessage[];
        assert.ok(out[0].tool_calls?.[0].id.startsWith("fc_"));
        assert.strictEqual(out[0].tool_calls?.[0].function.arguments, "{}");
    });
});
