import * as assert from "assert";
import { interpretStreamEvent } from "../liteLLMStreamInterpreter";
import { createInitialStreamingState } from "../streamingState";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("Anthropic prompt-cache usage parsing", () => {
    test("forwards top-level Anthropic cache counters on response.completed", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: {
                    usage: {
                        input_tokens: 200,
                        output_tokens: 10,
                        cache_creation_input_tokens: 40,
                        cache_read_input_tokens: 60,
                    },
                },
            },
            state
        );

        const usagePart = parts.find((p) => p.type === "data" && p.mimeType === "usage");
        assert.ok(usagePart && usagePart.type === "data");
        const usage = usagePart.value as {
            prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
        };
        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 60);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 40);
    });
});

suite("/responses reasoning", () => {
    test("emits a thinking part for a reasoning summary delta", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            { type: "response.reasoning_summary_text.delta", delta: "weighing options" },
            state
        );

        const thinking = parts.find((part) => part.type === "thinking");
        assert.ok(thinking, "reasoning must reach VS Code as a thinking part");
        if (thinking?.type === "thinking") {
            assert.strictEqual(thinking.value, "weighing options");
            assert.strictEqual(thinking.id, "litellm-thinking-1");
        }
    });

    test("keeps consecutive reasoning deltas in one block", () => {
        const state = createInitialStreamingState();

        const first = interpretStreamEvent({ type: "response.reasoning_summary_text.delta", delta: "one " }, state);
        const second = interpretStreamEvent({ type: "response.reasoning_text.delta", delta: "two" }, state);

        const firstPart = first.find((part) => part.type === "thinking");
        const secondPart = second.find((part) => part.type === "thinking");
        assert.ok(firstPart?.type === "thinking" && secondPart?.type === "thinking");
        assert.strictEqual(secondPart.id, firstPart.id, "one reply's reasoning stays in one part");
    });

    test("ignores a reasoning delta with no text", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent({ type: "response.reasoning_summary_text.delta", delta: "" }, state);

        assert.strictEqual(parts.length, 0);
    });
});

suite("response.incomplete", () => {
    test("reports the output-token limit as a length finish", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.incomplete",
                response: {
                    usage: { input_tokens: 30, output_tokens: 40 },
                    incomplete_details: { reason: "max_output_tokens" },
                },
            },
            state
        );

        const finish = parts.find((p) => p.type === "finish");
        assert.ok(finish && finish.type === "finish");
        assert.strictEqual(finish.reason, "length");
        const usagePart = parts.find((p) => p.type === "data" && p.mimeType === "usage");
        assert.ok(usagePart, "an incomplete turn still reports its usage");
    });

    test("reports a content filter as a content_filter finish", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.incomplete",
                response: { incomplete_details: { reason: "content_filter" } },
            },
            state
        );

        const finish = parts.find((p) => p.type === "finish");
        assert.ok(finish && finish.type === "finish");
        assert.strictEqual(finish.reason, "content_filter");
    });

    test("emits usage without a finish for an unrecognized reason", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.incomplete",
                response: { usage: { input_tokens: 5, output_tokens: 6 }, incomplete_details: { reason: "other" } },
            },
            state
        );

        assert.strictEqual(
            parts.some((p) => p.type === "finish"),
            false
        );
        assert.ok(parts.some((p) => p.type === "data" && p.mimeType === "usage"));
    });

    test("emits usage without a finish when incomplete_details is absent", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            { type: "response.incomplete", response: { usage: { input_tokens: 5, output_tokens: 6 } } },
            state
        );

        assert.strictEqual(
            parts.some((p) => p.type === "finish"),
            false
        );
        assert.ok(parts.some((p) => p.type === "data" && p.mimeType === "usage"));
    });

    test("reads the plural usage detail objects on a completed turn", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: {
                    usage: {
                        input_tokens: 100,
                        output_tokens: 20,
                        input_tokens_details: { cached_tokens: 70, cache_creation_input_tokens: 10 },
                        output_tokens_details: { reasoning_tokens: 8 },
                    },
                },
            },
            state
        );

        const usagePart = parts.find((p) => p.type === "data" && p.mimeType === "usage");
        assert.ok(usagePart && usagePart.type === "data");
        const usage = usagePart.value as {
            prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number };
        };
        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 70);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 10);
        assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 8);
    });
});
