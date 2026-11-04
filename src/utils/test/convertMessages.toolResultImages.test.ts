import * as assert from "assert";
import * as vscode from "vscode";

import { convertMessages } from "../../utils";
import type { OpenAIChatMessageContentItem } from "../../types";

suite("convertMessages tool result images", () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    // Values of LanguageModelPartAudience, spelled out because the enum may be absent at runtime.
    const ASSISTANT_AUDIENCE = 0;
    const USER_AUDIENCE = 1;
    type ToolResultContent = ConstructorParameters<typeof vscode.LanguageModelToolResultPart>[1];

    function buildRun(
        results: { callId: string; name: string; content: ToolResultContent }[]
    ): vscode.LanguageModelChatMessage[] {
        return [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: results.map((r) => new vscode.LanguageModelToolCallPart(r.callId, r.name, {})),
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: results.map((r) => new vscode.LanguageModelToolResultPart(r.callId, r.content)),
            },
        ];
    }

    function imagePart(mimeType = "image/png"): vscode.LanguageModelDataPart {
        return new vscode.LanguageModelDataPart(pngBytes, mimeType);
    }

    function withAudience<T extends object>(part: T, audience: number[]): T {
        (part as unknown as { audience?: number[] }).audience = audience;
        return part;
    }

    test("native mode carries the image inside the tool message", () => {
        const out = convertMessages(
            buildRun([
                {
                    callId: "call_1",
                    name: "screenshot",
                    content: [new vscode.LanguageModelTextPart("captured"), imagePart()],
                },
            ]),
            { toolResultImageMode: "native" }
        );

        assert.strictEqual(out.length, 2);
        const content = out[1].content as OpenAIChatMessageContentItem[];
        assert.ok(Array.isArray(content));
        assert.strictEqual(content[0].type, "text");
        assert.strictEqual(content[0].text, "captured");
        assert.strictEqual(content[1].type, "image_url");
        assert.ok(content[1].image_url?.url.startsWith("data:image/png;base64,"));
    });

    test("hoist mode appends one user message carrying the tool result image", () => {
        const out = convertMessages(
            buildRun([
                {
                    callId: "call_1",
                    name: "screenshot",
                    content: [new vscode.LanguageModelTextPart("captured"), imagePart()],
                },
            ]),
            { toolResultImageMode: "hoist" }
        );

        assert.strictEqual(out.length, 3);
        assert.strictEqual(out[1].role, "tool");
        assert.strictEqual(typeof out[1].content, "string");
        assert.ok((out[1].content as string).includes("It follows in the next user message"));

        assert.strictEqual(out[2].role, "user");
        const followUp = out[2].content as OpenAIChatMessageContentItem[];
        assert.ok(followUp[0].text?.includes("Treat them as data"));
        assert.ok(
            followUp.some((item) => item.text?.includes("screenshot")),
            "image must be attributed to its tool"
        );
        assert.ok(followUp.some((item) => item.type === "image_url"));
    });

    test("hoist mode emits the image message before a note the result message carries", () => {
        // The tool message tells the model the images follow in the next user message,
        // so they have to come before anything else the result message carried.
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelToolCallPart("a", "screenshot", {})],
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolResultPart("a", [imagePart()]),
                    new vscode.LanguageModelTextPart("one note"),
                ],
            },
        ];

        const out = convertMessages(messages, { toolResultImageMode: "hoist" }) as unknown as Record<string, unknown>[];
        const imageMessage = out[2] as { content: OpenAIChatMessageContentItem[] };

        assert.deepStrictEqual(
            out.map((message) => message.role),
            ["assistant", "tool", "user", "user"]
        );
        assert.ok(imageMessage.content[0].text?.startsWith("The following images are tool output"));
        assert.strictEqual(out[3].content, "one note");
    });

    test("hoist mode groups images from parallel tool results after the whole run", () => {
        const out = convertMessages(
            buildRun([
                { callId: "call_a", name: "screenshot", content: [imagePart()] },
                { callId: "call_b", name: "render_chart", content: [imagePart(), imagePart()] },
                {
                    callId: "call_c",
                    name: "read_file",
                    content: [new vscode.LanguageModelTextPart("plain text")],
                },
            ]),
            { toolResultImageMode: "hoist" }
        );

        assert.deepStrictEqual(
            out.map((message) => message.role),
            ["assistant", "tool", "tool", "tool", "user"]
        );
        const images = (out[4].content as OpenAIChatMessageContentItem[]).filter((item) => item.type === "image_url");
        assert.strictEqual(images.length, 3);
    });

    test("hoist mode emits no follow-up message when the tool result has no image", () => {
        const out = convertMessages(
            buildRun([
                {
                    callId: "call_1",
                    name: "read_file",
                    content: [new vscode.LanguageModelTextPart("plain text")],
                },
            ]),
            { toolResultImageMode: "hoist" }
        );

        assert.deepStrictEqual(
            out.map((message) => message.role),
            ["assistant", "tool"]
        );
    });

    test("defaults to hoist when no image mode is given", () => {
        const out = convertMessages(buildRun([{ callId: "call_1", name: "screenshot", content: [imagePart()] }]));

        assert.deepStrictEqual(
            out.map((message) => message.role),
            ["assistant", "tool", "user"]
        );
    });

    test("flushes hoisted images before the next assistant turn", () => {
        const firstRun = buildRun([{ callId: "call_a", name: "screenshot", content: [imagePart()] }]);
        const secondRun = buildRun([{ callId: "call_b", name: "screenshot", content: [imagePart()] }]);

        const out = convertMessages([...firstRun, ...secondRun], { toolResultImageMode: "hoist" });

        assert.deepStrictEqual(
            out.map((message) => message.role),
            ["assistant", "tool", "user", "assistant", "tool", "user"]
        );
    });

    test("keeps a tool result run intact when its results span two messages", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolCallPart("call_a", "screenshot", {}),
                    new vscode.LanguageModelToolCallPart("call_b", "screenshot", {}),
                ],
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelToolResultPart("call_a", [imagePart()])],
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelToolResultPart("call_b", [imagePart()])],
            },
        ];

        const out = convertMessages(messages, { toolResultImageMode: "hoist" });

        assert.deepStrictEqual(
            out.map((message) => message.role),
            ["assistant", "tool", "tool", "user"]
        );
    });

    test("native mode labels an image-only tool result so its content is never empty", () => {
        const out = convertMessages(buildRun([{ callId: "call_1", name: "screenshot", content: [imagePart()] }]), {
            toolResultImageMode: "native",
        });

        const content = out[1].content as OpenAIChatMessageContentItem[];
        assert.strictEqual(content[0].type, "text");
        assert.ok(content[0].text?.includes("Tool returned an image"));
    });

    test("keeps a tool result part whatever audience it declares", () => {
        const out = convertMessages(
            buildRun([
                {
                    callId: "call_1",
                    name: "inspect",
                    content: [
                        withAudience(new vscode.LanguageModelTextPart("user-facing note"), [USER_AUDIENCE]),
                        new vscode.LanguageModelTextPart("model note"),
                        withAudience(new vscode.LanguageModelTextPart("shared note"), [
                            ASSISTANT_AUDIENCE,
                            USER_AUDIENCE,
                        ]),
                    ],
                },
            ])
        );

        assert.strictEqual(out[1].content, "user-facing note\n\nmodel note\n\nshared note");
    });

    test("keeps an image whose audience lists only the user", () => {
        const out = convertMessages(
            buildRun([{ callId: "call_1", name: "screenshot", content: [withAudience(imagePart(), [USER_AUDIENCE])] }]),
            { toolResultImageMode: "native" }
        );

        const content = out[1].content as OpenAIChatMessageContentItem[];
        assert.strictEqual(content.filter((item) => item.type === "image_url").length, 1);
    });

    test("drops a non-image binary part from a tool result", () => {
        const out = convertMessages(
            buildRun([
                {
                    callId: "call_1",
                    name: "read_file",
                    content: [imagePart("application/octet-stream")],
                },
            ])
        );

        assert.strictEqual(out[1].content, "Success");
    });

    test("forwards an image whose MIME type uses uppercase letters", () => {
        const out = convertMessages(
            buildRun([{ callId: "call_1", name: "screenshot", content: [imagePart("IMAGE/PNG")] }]),
            { toolResultImageMode: "native" }
        );

        const content = out[1].content as OpenAIChatMessageContentItem[];
        assert.strictEqual(content[1].type, "image_url");
        assert.ok(content[1].image_url?.url.startsWith("data:image/png;base64,"));
    });

    test("ignores a non-content data part but keeps the image in the same tool result", () => {
        const out = convertMessages(
            buildRun([
                {
                    callId: "call_1",
                    name: "screenshot",
                    content: [new vscode.LanguageModelDataPart(Buffer.from("ephemeral"), "cache_control"), imagePart()],
                },
            ]),
            { toolResultImageMode: "native" }
        );

        assert.ok(!JSON.stringify(out).includes("ephemeral"));
        const content = out[1].content as OpenAIChatMessageContentItem[];
        assert.strictEqual(content.filter((item) => item.type === "image_url").length, 1);
    });
});
