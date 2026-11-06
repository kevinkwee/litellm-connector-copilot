import * as assert from "assert";
import { interpretStreamEvent, createInitialStreamingState, hasBufferedToolCalls } from "../liteLLMStreamInterpreter";

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

    test("flushes a buffered tool call before ending the turn", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            { type: "response.output_tool_call.delta", delta: { id: "call-inc", name: "read_file", arguments: "{}" } },
            state
        );

        const parts = interpretStreamEvent(
            { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
            state
        );

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "read_file");
        assert.strictEqual(hasBufferedToolCalls(state), false);
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
