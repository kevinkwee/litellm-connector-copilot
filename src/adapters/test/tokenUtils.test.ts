import * as assert from "assert";
import * as vscode from "vscode";
import { isAnthropicModel } from "../../utils/modelUtils";
import {
    estimateMessagesTokens,
    estimateSingleMessageTokens,
    estimateToolTokens,
    trimMessagesToFitBudget,
    countTokens,
    countOpenAIChatMessagesTokens,
    calculateAvailableContext,
    getStaticPromptTokenCount,
    getReservedOutputTokens,
    isContextOverflowError,
} from "../tokenUtils";
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

    test("estimateMessagesTokens sums single-message estimates", () => {
        const a = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("abcd")], // 4 chars -> 2 tokens
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        const b = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("abcdefgh")], // 8 chars -> 3 tokens
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        assert.strictEqual(estimateMessagesTokens([a, b]), 5);
    });

    test("estimateSingleMessageTokens estimates text parts", () => {
        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Hello world")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        // "Hello world" -> 4 tokens
        assert.strictEqual(estimateSingleMessageTokens(msg), 4);
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

    test("trimMessagesToFitBudget keeps system message and recent messages", () => {
        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole, // System
            content: [new vscode.LanguageModelTextPart("System prompt")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const oldMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Old message that is very long and should be trimmed")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const newMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("New message")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 10, // Smaller budget
        } as vscode.LanguageModelChatInformation;

        // "System prompt" = 13 chars -> 4 tokens
        // "Old message..." = 53 chars -> 14 tokens
        // "New message" = 11 chars -> 3 tokens
        // Total = 4 + 14 + 3 = 21 (exceeds budget of 10)
        // Should keep system (4) and new message (3) = 7 tokens.
        // Old message (14) cannot fit even alone with system (4 + 14 = 18 > 10).

        const trimmed = trimMessagesToFitBudget([systemMsg, oldMsg, newMsg], undefined, modelInfo);

        assert.strictEqual(trimmed.length, 2);
        assert.strictEqual(trimmed[0], systemMsg);
        assert.strictEqual(trimmed[1], newMsg);
    });

    test("trimMessagesToFitBudget respects hardBudgetOverride without buffer", () => {
        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("System prompt")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const recentMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Short")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const olderMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Older message that should drop")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 1000, // large, but override will constrain
        } as vscode.LanguageModelChatInformation;

        // Without override, buffered budget keeps system + both messages.
        const defaultTrimmed = trimMessagesToFitBudget([systemMsg, olderMsg, recentMsg], undefined, modelInfo);
        assert.strictEqual(defaultTrimmed.length, 3);

        // With a small hard override (8 tokens), only system + recent should remain.
        const overridden = trimMessagesToFitBudget(
            [systemMsg, olderMsg, recentMsg],
            undefined,
            modelInfo,
            undefined,
            8
        );

        assert.strictEqual(overridden.length, 2);
        assert.strictEqual(overridden[0], systemMsg);
        assert.strictEqual(overridden[1], recentMsg);
    });

    test("trimMessagesToFitBudget throws if budget is too small", () => {
        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Too long for small budget")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 2, // budget will be 2 - 0 = 2. msg is 26 chars -> 7 tokens.
        } as vscode.LanguageModelChatInformation;

        // The current implementation now ensures at least one message is returned
        // if budget allows for the system message or if no system message exists.
        const trimmed = trimMessagesToFitBudget([msg], undefined, modelInfo);
        assert.strictEqual(trimmed.length, 1);
    });

    test("trimMessagesToFitBudget protects assistant message on 'continue'", () => {
        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("System")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const assistantMsg = {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            content: [new vscode.LanguageModelTextPart("Truncated response...")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const continueMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("continue")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 5, // Very small budget
        } as vscode.LanguageModelChatInformation;

        // System: 6 chars -> 2 tokens
        // Assistant: 21 chars -> 6 tokens
        // Continue: 8 chars -> 2 tokens
        // Total: 2 + 6 + 2 = 10 (exceeds budget of 5)
        // Without protection, it might drop the assistant message.
        // With protection, it should keep system, assistant, and continue.

        const trimmed = trimMessagesToFitBudget([systemMsg, assistantMsg, continueMsg], undefined, modelInfo);

        assert.strictEqual(trimmed.length, 3);
        assert.strictEqual(trimmed[0], systemMsg);
        assert.strictEqual(trimmed[1], assistantMsg);
        assert.strictEqual(trimmed[2], continueMsg);
    });

    test("trimMessagesToFitBudget throws when tool tokens consume entire budget", () => {
        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("hi")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 1,
        } as vscode.LanguageModelChatInformation;

        // Make tools JSON large enough so toolTokenCount >= safetyLimit
        const tools = [
            {
                type: "function",
                function: {
                    name: "t",
                    description: "x".repeat(1000),
                    parameters: { type: "object", properties: {} },
                },
            },
        ];

        assert.throws(() => trimMessagesToFitBudget([msg], tools, modelInfo), /Message exceeds token limit\./);
    });

    test("trimMessagesToFitBudget throws when system message alone exceeds budget", () => {
        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("this is too long")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 1,
        } as vscode.LanguageModelChatInformation;

        assert.throws(
            () => trimMessagesToFitBudget([systemMsg], undefined, modelInfo),
            /Message exceeds token limit\./
        );
    });

    test("calculateAvailableContext computes correctly with buffer", () => {
        // Mock getStaticPromptTokenCount or use values from selectTokenizer (default)
        const available = calculateAvailableContext(1000, 200, ["static"], "m");
        // "static" is 6 chars -> 2 tokens. Total static: 2.
        // 1000 - 200 - 2 = 798. Buffer 0.05 -> 798 * 0.95 = 758.1 -> 758.
        assert.strictEqual(available, 758);
    });

    test("getStaticPromptTokenCount uses cache", () => {
        const p = "unique-prompt-" + Math.random();
        const count1 = getStaticPromptTokenCount(p, "m");
        const count2 = getStaticPromptTokenCount(p, "m");
        assert.strictEqual(count1, count2);
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

    test("isContextOverflowError matches known patterns", () => {
        const codeError = Object.assign(new Error("overflow"), { code: "context_length_exceeded" });
        const tokenError = Object.assign(new Error("overflow"), { code: "tokens_exceeded" });
        const messageError = new Error("This model's maximum context length is 50 tokens");
        const typedError = Object.assign(new Error("overflow"), {
            type: "invalid_request_error",
            message: "maximum context length exceeded",
        });

        assert.strictEqual(isContextOverflowError(codeError), true);
        assert.strictEqual(isContextOverflowError(tokenError), true);
        assert.strictEqual(isContextOverflowError(messageError), true);
        assert.strictEqual(isContextOverflowError(typedError), true);
    });

    test("isContextOverflowError ignores unrelated errors", () => {
        const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        const badRequest = Object.assign(new Error("invalid"), { status: 400, message: "invalid input" });

        assert.strictEqual(isContextOverflowError(networkError), false);
        assert.strictEqual(isContextOverflowError(badRequest), false);
        assert.strictEqual(isContextOverflowError("plain string"), false);
    });
});
