import * as assert from "assert";
import { interpretStreamEvent, createInitialStreamingState } from "../liteLLMStreamInterpreter";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("Anthropic prompt-cache usage parsing", () => {
    test("normalizes LiteLLM Anthropic usage counters on chat frames", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 50,
                    total_tokens: 1050,
                    prompt_tokens_details: { cached_tokens: 400, cache_creation_tokens: 100 },
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 400,
                },
            },
            state
        );

        const usagePart = parts.find((p) => p.type === "data" && p.mimeType === "usage");
        assert.ok(usagePart && usagePart.type === "data");
        const usage = usagePart.value as {
            prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
        };
        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 400);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 100);
    });
});

suite("Anthropic thinking block preservation", () => {
    test("streams text deltas under one id and seals the block with signature metadata", () => {
        const state = createInitialStreamingState();

        const first = interpretStreamEvent({ choices: [{ delta: { reasoning_content: "First " } }] }, state);
        const second = interpretStreamEvent({ choices: [{ delta: { reasoning_content: "chunk" } }] }, state);
        const seal = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "",
                            thinking_blocks: [{ type: "thinking", thinking: "First chunk", signature: "SIG1" }],
                        },
                    },
                ],
            },
            state
        );

        for (const part of [...first, ...second]) {
            assert.strictEqual(part.type, "thinking");
            assert.strictEqual((part as { id?: string }).id, "litellm-thinking-1");
            assert.ok((part as { value: string }).value.length > 0);
        }
        const sealed = seal[0];
        assert.strictEqual(sealed.type, "thinking");
        assert.strictEqual((sealed as { id?: string }).id, "litellm-thinking-1");
        const metadata = (sealed as { metadata?: Record<string, unknown> }).metadata;
        assert.strictEqual(metadata?.signature, "SIG1");
        assert.strictEqual(metadata?._completeThinking, "First chunk");
    });

    test("seals an omitted-display block with an empty text replay", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "",
                            thinking_blocks: [{ type: "thinking", thinking: "", signature: "SIG2" }],
                        },
                    },
                ],
            },
            state
        );

        assert.strictEqual(parts.length, 1);
        assert.strictEqual(parts[0].type, "thinking");
        assert.strictEqual((parts[0] as { id?: string }).id, "litellm-thinking-1");
        const metadata = (parts[0] as { metadata?: Record<string, unknown> }).metadata;
        assert.strictEqual(metadata?.signature, "SIG2");
        assert.strictEqual(metadata?._completeThinking, "");
    });

    test("emits redacted blocks as redactedData metadata", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "",
                            thinking_blocks: [{ type: "redacted_thinking", data: "ENC3" }],
                        },
                    },
                ],
            },
            state
        );

        assert.strictEqual(parts.length, 1);
        const metadata = (parts[0] as { metadata?: Record<string, unknown> }).metadata;
        assert.strictEqual(metadata?.redactedData, "ENC3");
        assert.strictEqual(metadata?.signature, undefined);
        assert.strictEqual(metadata?._completeThinking, undefined);
    });

    test("starts a fresh id after a sealed block", () => {
        const state = createInitialStreamingState();

        interpretStreamEvent({ choices: [{ delta: { reasoning_content: "block one" } }] }, state);
        const firstSeal = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "",
                            thinking_blocks: [{ type: "thinking", thinking: "block one", signature: "SIG1" }],
                        },
                    },
                ],
            },
            state
        );
        const laterText = interpretStreamEvent({ choices: [{ delta: { reasoning_content: "block two" } }] }, state);
        const secondSeal = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "",
                            thinking_blocks: [{ type: "thinking", thinking: "block two", signature: "SIG9" }],
                        },
                    },
                ],
            },
            state
        );

        assert.strictEqual((firstSeal[0] as { id?: string }).id, "litellm-thinking-1");
        assert.strictEqual((laterText[0] as { id?: string }).id, "litellm-thinking-2");
        assert.strictEqual((secondSeal[0] as { id?: string }).id, "litellm-thinking-2");
    });

    test("ignores unsigned thinking_blocks entries", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "piece",
                            thinking_blocks: [{ type: "thinking", thinking: "piece" }],
                        },
                    },
                ],
            },
            state
        );

        const thinkingParts = parts.filter((p) => p.type === "thinking");
        assert.strictEqual(thinkingParts.length, 1, "only the text delta part is emitted");
        const metadata = (thinkingParts[0] as { metadata?: Record<string, unknown> }).metadata;
        assert.strictEqual(metadata, undefined);
    });

    test("ignores blocks with malformed signature or data fields", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "",
                            thinking_blocks: [
                                { type: "thinking", signature: 42, thinking: "x" },
                                { type: "redacted_thinking", data: 42 },
                            ],
                        },
                    },
                ],
            },
            state
        );

        assert.strictEqual(parts.filter((p) => p.type === "thinking").length, 0);
    });
});
