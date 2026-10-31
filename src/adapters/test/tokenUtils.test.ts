import * as assert from "assert";
import * as vscode from "vscode";
import { isAnthropicModel } from "../../utils/modelUtils";
import { estimateToolTokens, countTokens, countOpenAIChatMessagesTokens, getReservedOutputTokens } from "../tokenUtils";
import type { LiteLLMModelInfo } from "../../types";

suite("TokenUtils Unit Tests", () => {
    test("countTokens handles strings, single messages, and message arrays", () => {
        const text = "Hello world";
        // "Hello world" is 11 chars. 11/3.5 = 3.14 -> 4 tokens
        // Words: 2 * 1.3 = 2.6 -> 3 tokens
        // Max(4, 3) = 4
        assert.strictEqual(countTokens(text), 4);

        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Hello world")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        assert.strictEqual(countTokens(msg), 4);

        const msgs = [msg, msg];
        assert.strictEqual(countTokens(msgs), 8);
    });

    test("estimateToolTokens estimates based on JSON length", () => {
        const tools = [{ type: "function", function: { name: "test", description: "test desc" } }];
        const expected = Math.ceil(JSON.stringify(tools).length / 4);
        assert.strictEqual(estimateToolTokens(tools), expected);
        assert.strictEqual(estimateToolTokens([]), 0);
        assert.strictEqual(estimateToolTokens(undefined), 0);
    });

    test("estimateToolTokens returns 0 when JSON serialization fails", () => {
        const cyclic: unknown[] = [];
        (cyclic as unknown[]).push(cyclic);

        assert.strictEqual(estimateToolTokens(cyclic as never), 0);
    });

    test("getReservedOutputTokens uses smart defaults between 16k and 64k when max_tokens is omitted", () => {
        const model = {
            id: "test-model",
            maxInputTokens: 200000,
            maxOutputTokens: 128000,
        } as vscode.LanguageModelChatInformation;

        const lowInputReservation = getReservedOutputTokens(model, undefined, { estimatedInputTokens: 2000 });
        const highInputReservation = getReservedOutputTokens(model, undefined, { estimatedInputTokens: 60000 });

        assert.ok(lowInputReservation >= 16000);
        assert.ok(highInputReservation <= 64000);
        assert.ok(highInputReservation > lowInputReservation);
    });

    test("getReservedOutputTokens never exceeds remaining context window", () => {
        const model = {
            id: "small-model",
            maxInputTokens: 0,
            maxOutputTokens: 64000,
        } as vscode.LanguageModelChatInformation;

        const reserved = getReservedOutputTokens(model, undefined, {
            estimatedInputTokens: 31900,
            modelInfo: { max_input_tokens: 32000 } as LiteLLMModelInfo,
        });

        // total 32000 - input 31900 - structural headroom 256 => clamped to minimum 1
        assert.strictEqual(reserved, 1);
    });

    test("isAnthropicModel identifies models correctly", () => {
        assert.strictEqual(isAnthropicModel("claude-3-opus"), true);
        assert.strictEqual(isAnthropicModel("gpt-4o"), false);
        assert.strictEqual(
            isAnthropicModel("some-model", {
                litellm_provider: "anthropic",
            } as unknown as LiteLLMModelInfo),
            true
        );
    });

    test("countOpenAIChatMessagesTokens counts transport tool calls and tool results", () => {
        const count = countOpenAIChatMessagesTokens(
            [
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: {
                                name: "read_file",
                                arguments: '{"path":"a.txt"}',
                            },
                        },
                    ],
                },
                {
                    role: "tool",
                    tool_call_id: "call_1",
                    content: "file contents",
                },
            ],
            "m"
        );

        assert.ok(count > 0);
    });

    test("countOpenAIChatMessagesTokens counts a data-URI image part", () => {
        // 1500 image bytes become a 2000-character base64 payload: 85 base
        // tokens plus ceil(1500 / 750) = 2 scaled tokens.
        const dataUri = `data:image/png;base64,${Buffer.alloc(1500).toString("base64")}`;
        const count = countOpenAIChatMessagesTokens(
            [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUri } }] }],
            "m"
        );

        assert.strictEqual(count, 87);
    });

    test("countOpenAIChatMessagesTokens charges the base image cost for a remote image URL", () => {
        const count = countOpenAIChatMessagesTokens(
            [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
            "m"
        );

        assert.strictEqual(count, 85);
    });
});
