import * as assert from "assert";
import { interpretStreamEvent } from "../liteLLMStreamInterpreter";
import { createInitialStreamingState } from "../streamingState";
import { UpstreamStreamError } from "../../../utils/transportRetry";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("LiteLLMStreamInterpreter: Tool Call Regressions", () => {
    test("should clear buffered tool calls when stream aborts before finish", () => {
        const state = createInitialStreamingState();

        // Start buffering a tool call but never send finish_reason
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_stale",
                                    function: { name: "tool", arguments: "{" },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        // Simulate abort/reset for a new request on same connection
        state.toolCallBuffers.clear();
        state.emittedToolCallIds.clear();

        // Next request reuses index 0; should not be corrupted by stale args
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_fresh",
                                    function: { name: "tool", arguments: '{"ok":true}' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);
        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.args, '{"ok":true}');
        }
    });

    test("should emit thinking before text and tool calls when mixed in one chunk", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "thought",
                            content: "hi",
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_order",
                                    function: { name: "tool", arguments: "{}" },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const order = parts.map((p) => p.type);
        assert.deepStrictEqual(order, ["thinking", "text"]);
    });

    test("reports the usage of a completed /responses turn after its tool call was flushed", () => {
        const state = createInitialStreamingState();

        // The bridge sends its function calls complete on `output_item.done`.
        const doneParts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-resp", name: "tc_responses", arguments: '{"x":1}' },
            },
            state
        );
        assert.deepStrictEqual(
            doneParts.flatMap((part) => (part.type === "tool_call" ? [part.args] : [])),
            ['{"x":1}']
        );

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: { usage: { input_tokens: 1, output_tokens: 2 } },
            },
            state
        );

        const usage = parts.find((p) => p.type === "data");
        assert.ok(usage, "expected usage data part to be emitted");
        assert.strictEqual(usage.type, "data");
        if (usage.type === "data") {
            assert.strictEqual(usage.mimeType, "usage");
            // A payload without detail objects reports the counts only: the
            // connector leaves an unreported detail undefined instead of zero.
            assert.deepStrictEqual(usage.value, {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
            });
        }
    });

    test("should emit reasoning_content as thinking and optionally merge into content", () => {
        const state = createInitialStreamingState();

        // Default: emit separate thinking part
        let parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            reasoning_content: "reasoning...",
                            content: "answer",
                        },
                    },
                ],
            },
            state
        );

        const thinking = parts.find((p) => p.type === "thinking");
        const text = parts.find((p) => p.type === "text");
        assert.ok(thinking, "expected thinking part");
        assert.ok(text, "expected text part");
        if (thinking && thinking.type === "thinking") {
            assert.strictEqual(thinking.value, "reasoning...");
        }
        if (text && text.type === "text") {
            assert.strictEqual(text.value, "answer");
        }

        // With merge flag: reasoning_content is prepended into content and not emitted separately
        const mergeState = createInitialStreamingState();
        parts = interpretStreamEvent(
            {
                merge_reasoning_content_in_choices: true,
                choices: [
                    {
                        delta: {
                            reasoning_content: "thought ",
                            content: "response",
                        },
                    },
                ],
            },
            mergeState
        );

        const thinkingMerged = parts.find((p) => p.type === "thinking");
        const textMerged = parts.find((p) => p.type === "text");
        assert.strictEqual(thinkingMerged, undefined, "should not emit thinking when merged");
        assert.ok(textMerged, "expected merged text part");
        if (textMerged && textMerged.type === "text") {
            assert.strictEqual(textMerged.value, "thought response");
        }
    });

    test("reports a completed response as a stop finish", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
            state
        );

        const finishes = parts.filter((part) => part.type === "finish");
        assert.deepStrictEqual(finishes, [{ type: "finish", reason: "stop" }]);
    });

    test("reports a completed response the bridge marked incomplete without a stop finish", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: { status: "incomplete", usage: { input_tokens: 1, output_tokens: 2 } },
            },
            state
        );

        assert.deepStrictEqual(
            parts.filter((part) => part.type === "finish"),
            [],
            "a cut-short answer is not a normal finish"
        );
    });

    test("produces no part for a marshalled VS Code object carrying usage", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                $mid: 1,
                mimeType: "usage",
                data: Buffer.from('{"prompt_tokens":1}').toString("base64"),
            },
            state
        );

        assert.deepStrictEqual(parts, []);
    });

    test("should normalize tool call ids on update and merge name/args", () => {
        const state = createInitialStreamingState();

        // Initial fragment with raw id
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "rawId",
                                    function: { name: "tool", arguments: "{" },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        // Update with same raw id to trigger normalization + name update + args concat
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "rawId",
                                    function: { name: "toolUpdated", arguments: '"value"}' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);
        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "toolUpdated");
            assert.strictEqual(toolCall.args, '{"value"}');
            assert.ok(toolCall.id?.startsWith("fc_"));
        }
    });
    test("should flush tool calls only when finish_reason is present (current behavior verification)", () => {
        const state = createInitialStreamingState();

        // Chunk 1: Tool call start
        const chunk1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_123",
                                function: { name: "get_weather", arguments: '{"city":' },
                            },
                        ],
                    },
                },
            ],
        };

        const parts1 = interpretStreamEvent(chunk1, state);
        assert.strictEqual(parts1.length, 0, "Should not emit tool_call yet (incomplete)");

        // Chunk 2: Tool call completion but NO finish_reason
        const chunk2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: { arguments: '"London"}' },
                            },
                        ],
                    },
                },
            ],
        };
        const parts2 = interpretStreamEvent(chunk2, state);
        assert.strictEqual(parts2.length, 0, "Should still not emit tool_call (missing finish_reason)");

        // Chunk 3: finish_reason
        const chunk3 = {
            choices: [
                {
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts3 = interpretStreamEvent(chunk3, state);
        assert.strictEqual(parts3.length, 2);
        assert.strictEqual(parts3[0].type, "tool_call");
        if (parts3[0].type === "tool_call") {
            assert.strictEqual(parts3[0].name, "get_weather");
            assert.strictEqual(parts3[0].args, '{"city":"London"}');
        }
        assert.strictEqual(parts3[1].type, "finish");
    });

    test("should handle tool call corruption if indices collide (theoretical bug)", () => {
        const state = createInitialStreamingState();

        // Turn 1 ends abruptly or re-uses index in weird proxy scenarios
        const chunk1 = {
            choices: [
                {
                    delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "tool1", arguments: "{" } }] },
                },
            ],
        };
        interpretStreamEvent(chunk1, state);

        // Turn 2 uses same index without finish_reason from Turn 1
        const chunk2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, id: "call_2", function: { name: "tool2", arguments: '{"a":1}' } }],
                    },
                },
            ],
        };
        interpretStreamEvent(chunk2, state);

        const chunk3 = { choices: [{ finish_reason: "stop" }] };
        const parts = interpretStreamEvent(chunk3, state);

        const toolCall = parts.find((p) => p.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            // If it concatenates, it's corrupted: "{{\"a\":1}"
            assert.notStrictEqual(
                toolCall.args,
                '{{"a":1}',
                "Tool call arguments should not be corrupted by previous turns"
            );
        }
    });

    test("should NOT emit tool call with invalid JSON args on finish_reason: stop", () => {
        const state = createInitialStreamingState();

        // Tool call with incomplete JSON args
        const chunk1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_bad",
                                function: { name: "bad_tool", arguments: '{"incomplete":' },
                            },
                        ],
                    },
                },
            ],
        };
        interpretStreamEvent(chunk1, state);

        // finish_reason: "stop" should NOT flush incomplete tool calls
        const chunk2 = { choices: [{ finish_reason: "stop" }] };
        const parts = interpretStreamEvent(chunk2, state);

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.strictEqual(toolCall, undefined, "Should not emit tool call with invalid/incomplete JSON args");
    });

    test("should emit tool call with valid JSON args on finish_reason: tool_calls", () => {
        const state = createInitialStreamingState();

        const chunk1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_valid",
                                function: { name: "valid_tool", arguments: '{"key":"value"}' },
                            },
                        ],
                    },
                },
            ],
        };
        interpretStreamEvent(chunk1, state);

        const chunk2 = { choices: [{ finish_reason: "tool_calls" }] };
        const parts = interpretStreamEvent(chunk2, state);

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall, "Should emit tool call with valid JSON args");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "valid_tool");
            assert.strictEqual(toolCall.args, '{"key":"value"}');
        }
    });

    test("should deduplicate tool calls with same ID across turns", () => {
        const state = createInitialStreamingState();

        const chunk = {
            choices: [
                {
                    delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t1", arguments: "{}" } }] },
                    finish_reason: "tool_calls",
                },
            ],
        };

        const parts1 = interpretStreamEvent(chunk, state);
        assert.strictEqual(parts1.filter((p) => p.type === "tool_call").length, 1);

        const parts2 = interpretStreamEvent(chunk, state);
        assert.strictEqual(parts2.filter((p) => p.type === "tool_call").length, 0, "Should not re-emit same ID");
    });

    test("should handle /responses format edge cases", () => {
        const state = createInitialStreamingState();

        // response.completed with partial usage
        const parts2 = interpretStreamEvent(
            {
                type: "response.completed",
                response: { usage: { input_tokens: 10 } },
            },
            state
        );
        assert.strictEqual(parts2.length, 3);
        assert.strictEqual(parts2[1].type, "data");
        assert.deepStrictEqual(parts2[2], { type: "finish", reason: "stop" });

        // An `output_item.done` for a non-call item carries nothing this layer emits.
        const parts3 = interpretStreamEvent({ type: "response.output_item.done" }, state);
        assert.deepStrictEqual(parts3, []);
    });
});

suite("Upstream error frames", () => {
    function assertThrowsUpstreamError(fn: () => void): UpstreamStreamError {
        try {
            fn();
        } catch (err) {
            assert.ok(err instanceof UpstreamStreamError, `expected UpstreamStreamError, got ${String(err)}`);
            return err;
        }
        assert.fail("expected the frame to throw");
    }

    test("a LiteLLM mid-stream error frame throws with its status and code", () => {
        const state = createInitialStreamingState("req-err");

        const error = assertThrowsUpstreamError(() =>
            interpretStreamEvent(
                {
                    error: {
                        message: "Overloaded",
                        type: "overloaded_error",
                        code: 529,
                    },
                },
                state
            )
        );

        assert.strictEqual(error.status, 529);
        assert.strictEqual(error.type, "overloaded_error");
        assert.strictEqual(error.detail, "Overloaded");
        assert.strictEqual(error.retriable, true);
        assert.match(error.message, /Overloaded/);
    });

    test("a rejected request in an error frame is not retriable", () => {
        const state = createInitialStreamingState();

        const error = assertThrowsUpstreamError(() =>
            interpretStreamEvent(
                {
                    error: {
                        message: "Unsupported parameter: temperature",
                        type: "invalid_request_error",
                        code: "400",
                    },
                },
                state
            )
        );

        assert.strictEqual(error.status, 400);
        assert.strictEqual(error.retriable, false);
    });

    test("a symbolic code is not read as an HTTP status", () => {
        const error = assertThrowsUpstreamError(() =>
            interpretStreamEvent(
                { error: { code: "rate_limit_exceeded", message: "slow down" } },
                createInitialStreamingState()
            )
        );

        assert.strictEqual(error.status, undefined);
        assert.strictEqual(error.code, "rate_limit_exceeded");
        assert.strictEqual(error.retriable, true);
    });

    test("/responses error and response.failed events throw", () => {
        const fromErrorEvent = assertThrowsUpstreamError(() =>
            interpretStreamEvent(
                { type: "error", code: "server_error", message: "upstream exploded" },
                createInitialStreamingState()
            )
        );
        assert.strictEqual(fromErrorEvent.code, "server_error");
        assert.strictEqual(fromErrorEvent.detail, "upstream exploded");

        const fromFailedEvent = assertThrowsUpstreamError(() =>
            interpretStreamEvent(
                { type: "response.failed", response: { error: { code: 503, message: "unavailable" } } },
                createInitialStreamingState()
            )
        );
        assert.strictEqual(fromFailedEvent.status, 503);
        assert.strictEqual(fromFailedEvent.retriable, true);
    });

    test("a response.failed event without an error payload still throws", () => {
        const withoutResponse = assertThrowsUpstreamError(() =>
            interpretStreamEvent({ type: "response.failed" }, createInitialStreamingState())
        );
        assert.strictEqual(withoutResponse.type, "response.failed");

        const withEmptyResponse = assertThrowsUpstreamError(() =>
            interpretStreamEvent({ type: "response.failed", response: {} }, createInitialStreamingState())
        );
        assert.strictEqual(withEmptyResponse.type, "response.failed");
    });

    test("an empty error object still marks the frame as a failure", () => {
        const error = assertThrowsUpstreamError(() =>
            interpretStreamEvent({ error: {} }, createInitialStreamingState())
        );

        assert.strictEqual(error.type, "error");
    });

    test("a null error field is not a failure frame", () => {
        const parts = interpretStreamEvent(
            { choices: [{ delta: { content: "still fine" } }], error: null },
            createInitialStreamingState()
        );

        assert.deepStrictEqual(
            parts.flatMap((part) => (part.type === "text" ? [part.value] : [])),
            ["still fine"]
        );
    });

    test("a plain string error field becomes an unlabelled failure", () => {
        const error = assertThrowsUpstreamError(() =>
            interpretStreamEvent({ error: "gateway closed" }, createInitialStreamingState())
        );

        assert.strictEqual(error.detail, "gateway closed");
        assert.strictEqual(error.retriable, false);
    });

    test("emits tool-call-shaped text in the answer as plain text", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            content: 'before <tool_call>{"name":"search"}</tool_call> after',
                        },
                    },
                ],
            },
            state
        );

        assert.deepStrictEqual(
            parts.flatMap((part) => (part.type === "text" ? [part.value] : [])),
            ['before <tool_call>{"name":"search"}</tool_call> after']
        );
        assert.deepStrictEqual(
            parts.filter((part) => part.type === "tool_call"),
            []
        );
    });

    test("splits a text answer across deltas without buffering it", () => {
        const state = createInitialStreamingState();

        const firstParts = interpretStreamEvent(
            { choices: [{ delta: { content: "<tool_call>{half of a payload" } }] },
            state
        );
        const secondParts = interpretStreamEvent({ choices: [{ delta: { content: " that never closes" } }] }, state);

        assert.deepStrictEqual(
            firstParts.flatMap((part) => (part.type === "text" ? [part.value] : [])),
            ["<tool_call>{half of a payload"]
        );
        assert.deepStrictEqual(
            secondParts.flatMap((part) => (part.type === "text" ? [part.value] : [])),
            [" that never closes"]
        );
    });
});
