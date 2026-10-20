import * as assert from "assert";
import * as sinon from "sinon";
import {
    interpretStreamEvent,
    createInitialStreamingState,
    flushPendingBuffers,
    reportUnfinishedToolCallBuffers,
} from "../liteLLMStreamInterpreter";
import { TAGGED_CALL_CLOSER, TAGGED_CALL_OPENER, PIPE_CLOSER, PIPE_OPENER } from "../textToolCallParser";
import { StructuredLogger } from "../../../observability/structuredLogger";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("LiteLLMStreamInterpreter - Tool Call Regressions", () => {
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
        state.completedToolCallIndices.clear();
        state.emittedTextToolCallIds.clear();

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

    test("should parse LiteLLM /responses tool calls and flush on completed", () => {
        const state = createInitialStreamingState();

        // Tool call arrives in fragments
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp", name: "tc_responses", arguments: "{" },
            },
            state
        );
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp", arguments: '"x":1}' },
            },
            state
        );

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: { usage: { input_tokens: 1, output_tokens: 2 } },
            },
            state
        );

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "tc_responses");
            assert.strictEqual(toolCall.args, '{"x":1}');
        }

        const usage = parts.find((p) => p.type === "data");
        assert.ok(usage, "expected usage data part to be emitted");
        assert.strictEqual(usage.type, "data");
        if (usage.type === "data") {
            assert.strictEqual(usage.mimeType, "usage");
            // OpenAI API spec: nested completion_tokens_details.reasoning_tokens and prompt_tokens_details.cached_tokens
            assert.deepStrictEqual(usage.value, {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                prompt_tokens_details: {
                    cached_tokens: 0,
                },
                completion_tokens_details: {
                    reasoning_tokens: 0,
                },
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

    test("should flush /responses tool calls on output_item.done when no completed frame", () => {
        const state = createInitialStreamingState();

        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp-2", name: "tc2", arguments: "{" },
            },
            state
        );
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp-2", arguments: '"y":true}' },
            },
            state
        );

        const parts = interpretStreamEvent({ type: "response.output_item.done" }, state);
        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "tc2");
            assert.strictEqual(toolCall.args, '{"y":true}');
        }
    });

    test("should buffer response.output_item.delta with call_id and emit on output_item.done", () => {
        const state = createInitialStreamingState();

        // Delta 1 — name + partial args, with call_id
        let parts = interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call_abc123", name: "search_tool", arguments: '{"query":' },
            },
            state
        );
        assert.strictEqual(parts.length, 0, "should buffer, not emit yet");

        // Delta 2 — remaining args, same call_id
        parts = interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call_abc123", arguments: '"hello"}' },
            },
            state
        );
        assert.strictEqual(parts.length, 0, "still buffered");

        // Done — should emit the specific call
        parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: {
                    type: "function_call",
                    call_id: "call_abc123",
                    name: "search_tool",
                    arguments: '{"query":"hello"}',
                },
            },
            state
        );

        const toolCallPart = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCallPart, "should emit tool_call part on output_item.done");
        assert.ok(toolCallPart.type === "tool_call");
        assert.strictEqual(toolCallPart.id, "call_abc123");
        assert.strictEqual(toolCallPart.name, "search_tool");
        assert.strictEqual(toolCallPart.args, '{"query":"hello"}');

        // Buffer should be cleared for this callId
        assert.strictEqual(state.responseToolCallBuffers.size, 0);
    });

    test("should buffer anonymous output_item.delta (no call_id) and emit on done", () => {
        const state = createInitialStreamingState();

        // Delta without call_id — anonymous buffering
        let parts = interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", name: "anon_tool", arguments: '{"x":' },
            },
            state
        );
        assert.strictEqual(parts.length, 0, "buffered anonymously");

        // Done without call_id — emit from anonymous buffer
        parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", arguments: '{"x":1}' },
            },
            state
        );

        const toolCallPart = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCallPart, "should emit anonymous tool_call part");
        assert.ok(toolCallPart.type === "tool_call");
        assert.strictEqual(toolCallPart.id, "anonymous");
        assert.strictEqual(toolCallPart.name, "anon_tool");

        // Anonymous buffer should be reset
        assert.strictEqual(state.anonymousResponseToolArgs, "");
        assert.strictEqual(state.anonymousResponseToolName, undefined);
    });

    test("should not re-emit on response.completed what was already flushed by output_item.done", () => {
        const state = createInitialStreamingState();

        // Buffer via output_item.delta
        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "c1", name: "tool1", arguments: '{"a":1}' },
            },
            state
        );

        // Flush via output_item.done — removes from responseToolCallOrder
        interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "c1", name: "tool1", arguments: '{"a":1}' },
            },
            state
        );

        // response.completed should NOT re-emit already-flushed call
        const parts = interpretStreamEvent(
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
            state
        );
        const toolCallParts = parts.filter((p) => p.type === "tool_call");
        assert.strictEqual(toolCallParts.length, 0, "should not double-emit flushed tool call");
    });

    test("should preserve legacy flush-all behavior when output_item.done has no item", () => {
        const state = createInitialStreamingState();

        // Legacy path: output_tool_call.delta populates buffer
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "legacy-id", name: "legacy_tool", arguments: '{"z":9}' },
            },
            state
        );

        // output_item.done with no item → flush all
        const parts = interpretStreamEvent({ type: "response.output_item.done" }, state);
        const toolCallPart = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCallPart, "legacy flush-all should still work");
        assert.ok(toolCallPart.type === "tool_call");
        assert.strictEqual(toolCallPart.name, "legacy_tool");
        assert.strictEqual(state.responseToolCallBuffers.size, 0, "buffer cleared after flush-all");
    });

    test("should parse Gemini native tool call shape", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    functionCall: {
                                        name: "gem_tool",
                                        args: { city: "Paris" },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "gem_tool");
            assert.strictEqual(toolCall.args, '{"city":"Paris"}');
        }
    });

    test("should suppress cache-control VS Code DataPart carrier objects", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                $mid: 1,
                mimeType: "application/vnd.cache-control+json",
                data: "ZXBoZW1lcmFs",
            },
            state
        );

        assert.deepStrictEqual(parts, []);
    });

    test("should pass through non-cache-control VS Code DataPart carrier objects", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                $mid: 2,
                mimeType: "usage",
                data: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            },
            state
        );

        assert.strictEqual(parts.length, 1);
        const [part] = parts;
        assert.strictEqual(part.type, "data");
        if (part.type === "data") {
            assert.strictEqual(part.mimeType, "usage");
            assert.deepStrictEqual(part.value, {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
            });
        }
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
        assert.strictEqual(parts2.length, 2);
        assert.strictEqual(parts2[1].type, "data");

        // response.output_item.done
        const parts3 = interpretStreamEvent({ type: "response.output_item.done" }, state);
        assert.strictEqual(parts3[0].type, "finish");
    });

    test("should handle Gemini native format", () => {
        const state = createInitialStreamingState();
        const chunk = {
            candidates: [
                {
                    content: {
                        parts: [{ text: "hello" }],
                    },
                },
            ],
        };
        const parts = interpretStreamEvent(chunk, state);
        assert.strictEqual(parts[0].type, "text");
        const textPart = parts[0];
        assert.strictEqual(textPart.type, "text");
        assert.strictEqual(textPart.value, "hello");
    });

    test("should parse tagged text tool calls into structured tool_call parts", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            content: `before ${TAGGED_CALL_OPENER}{"id":"call_text_1","name":"search","arguments":{"query":"vscode"}}${TAGGED_CALL_CLOSER} after`,
                        },
                    },
                ],
            },
            state
        );

        const toolCallPart = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCallPart && toolCallPart.type === "tool_call");
        if (toolCallPart && toolCallPart.type === "tool_call") {
            assert.strictEqual(toolCallPart.name, "search");
            assert.strictEqual(toolCallPart.args, '{"query":"vscode"}');
        }

        const textOutput = parts
            .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
            .map((part) => part.value)
            .join("");
        assert.strictEqual(textOutput, "before  after");
    });

    test("should buffer split tagged text tool calls and emit once closed", () => {
        const state = createInitialStreamingState();

        const firstParts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            content: `${PIPE_OPENER}{"name":"filesystem","arguments":{"path":"/tmp"}`,
                        },
                    },
                ],
            },
            state
        );
        assert.strictEqual(firstParts.length, 0, "first partial chunk should not emit output yet");

        const secondParts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            content: `}${PIPE_CLOSER}`,
                        },
                    },
                ],
            },
            state
        );

        const toolCallPart = secondParts.find((part) => part.type === "tool_call");
        assert.ok(toolCallPart && toolCallPart.type === "tool_call");
        if (toolCallPart && toolCallPart.type === "tool_call") {
            assert.strictEqual(toolCallPart.name, "filesystem");
            assert.strictEqual(toolCallPart.args, '{"path":"/tmp"}');
        }
    });
});

suite("flushPendingBuffers Unit Tests", () => {
    test("flushes /responses-format tool calls and emits with reason: incomplete_stream_end", () => {
        const state = createInitialStreamingState();

        // Simulate buffered /responses tool calls
        state.responseToolCallBuffers.set("call-id-1", { id: "call-id-1", name: "search", args: '{"q":"test"}' });
        state.responseToolCallOrder = ["call-id-1"];

        const parts = flushPendingBuffers(state);

        assert.ok(parts.length >= 2, "Should emit tool call + finish part");
        const toolCallPart = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCallPart && toolCallPart.type === "tool_call");
        if (toolCallPart && toolCallPart.type === "tool_call") {
            assert.strictEqual(toolCallPart.name, "search");
        }
        const finishPart = parts[parts.length - 1];
        assert.strictEqual(finishPart.type, "finish");
        assert.strictEqual((finishPart as unknown as { reason: string; type: string }).reason, "incomplete_stream_end");
        assert.strictEqual(state.responseToolCallBuffers.size, 0, "Buffers should be cleared");
        assert.strictEqual(state.responseToolCallOrder.length, 0);
    });

    test("flushes anonymous tool calls when buffered", () => {
        const state = createInitialStreamingState();

        state.anonymousResponseToolName = "execute_code";
        state.anonymousResponseToolArgs = '{"code":"print(123)"}';

        const parts = flushPendingBuffers(state);

        const toolCallPart = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCallPart && toolCallPart.type === "tool_call");
        if (toolCallPart && toolCallPart.type === "tool_call") {
            assert.strictEqual(toolCallPart.name, "execute_code");
        }
        assert.strictEqual(state.anonymousResponseToolName, undefined, "Anonymous state should be cleared");
        assert.strictEqual(state.anonymousResponseToolArgs, "");
    });

    test("skips malformed tool call args and still emits valid ones", () => {
        const state = createInitialStreamingState();

        // Add a malformed tool call (invalid JSON)
        state.toolCallBuffers.set(0, { id: "bad-call", name: "badtool", args: "{invalid" });
        state.toolCallBuffers.set(1, { id: "good-call", name: "goodtool", args: '{"ok":true}' });

        const parts = flushPendingBuffers(state);

        // Should still emit at least the finish part and try to emit good calls
        const toolCallParts = parts.filter((p) => p.type === "tool_call");
        assert.ok(toolCallParts.length <= 2, "Should skip invalid calls or emit only valid ones");
        const finishPart = parts[parts.length - 1];
        assert.strictEqual(finishPart.type, "finish");
        assert.strictEqual((finishPart as unknown as { reason: string; type: string }).reason, "incomplete_stream_end");
    });

    test("handles empty buffers gracefully and still emits finish", () => {
        const state = createInitialStreamingState();

        const parts = flushPendingBuffers(state);

        // Should emit at least a finish part even with empty buffers
        assert.strictEqual(parts.length, 1, "Should emit one finish part");
        const finishPart = parts[0];
        assert.strictEqual(finishPart.type, "finish");
        assert.strictEqual((finishPart as unknown as { reason: string; type: string }).reason, "incomplete_stream_end");
    });
});

suite("Tool Call Args Corruption Logging", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("logs an error-level event and drops the buffered call when args are invalid and finish_reason is stop", () => {
        const state = createInitialStreamingState();
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const invalidArgs = '{"incomplete":';

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_corrupt",
                                    function: { name: "bad_tool", arguments: invalidArgs },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );
        const parts = interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.strictEqual(
            parts.find((p) => p.type === "tool_call"),
            undefined
        );
        const corruptionCalls = errorStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.tool_call_args_invalid_json");
        assert.strictEqual(corruptionCalls.length, 1);
        const fields = corruptionCalls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(fields.toolName, "bad_tool");
        assert.strictEqual(fields.finishReason, "stop");
        assert.strictEqual(fields.argsLength, invalidArgs.length);
        assert.strictEqual(fields.argsPreview, invalidArgs);
        assert.ok(String(fields.normalizedId).startsWith("fc_"));
    });

    test("still emits the buffered call when finish_reason is tool_calls, and logs the error-level event", () => {
        const state = createInitialStreamingState();
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const invalidArgs = '{"incomplete":';

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_corrupt",
                                    function: { name: "bad_tool", arguments: invalidArgs },
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
        assert.ok(toolCall, "Should still emit the buffered call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "bad_tool");
            assert.strictEqual(toolCall.args, invalidArgs);
        }
        const corruptionCalls = errorStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.tool_call_args_invalid_json");
        assert.strictEqual(corruptionCalls.length, 1);
        const fields = corruptionCalls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(fields.finishReason, "tool_calls");
    });

    test("flushPendingBuffers logs an error-level event when skipping malformed buffered args", () => {
        const state = createInitialStreamingState();
        const errorStub = sandbox.stub(StructuredLogger, "error");

        state.toolCallBuffers.set(0, { id: "bad-call", name: "badtool", args: "{invalid" });
        state.toolCallBuffers.set(1, { id: "good-call", name: "goodtool", args: '{"ok":true}' });

        const parts = flushPendingBuffers(state);

        const emitted = parts.filter((p) => p.type === "tool_call");
        assert.strictEqual(emitted.length, 1);
        if (emitted[0] && emitted[0].type === "tool_call") {
            assert.strictEqual(emitted[0].name, "goodtool");
        }
        const corruptionCalls = errorStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.tool_call_args_invalid_json");
        assert.strictEqual(corruptionCalls.length, 1);
        const fields = corruptionCalls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(fields.callId, "bad-call");
        assert.strictEqual(fields.toolName, "badtool");
        assert.strictEqual(fields.argsPreview, "{invalid");
    });
});

suite("Dropped tool call buffer logging", () => {
    const DROPPED_EVENT = "stream.tool_call_buffer_dropped";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    function toolCallDelta(toolCall: Record<string, unknown>): Record<string, unknown> {
        return { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] };
    }

    function droppedEventFields(warnStub: sinon.SinonStub): Record<string, unknown>[] {
        return warnStub
            .getCalls()
            .filter((call) => call.args[0] === DROPPED_EVENT)
            .map((call) => call.args[1] as Record<string, unknown>);
    }

    test("reports an id-less buffer discarded at finish", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(toolCallDelta({ function: { arguments: '{"mode":"background"}' } }), state);

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                reason: "incomplete_at_finish",
                index: 0,
                finishReason: "tool_calls",
                hasId: false,
                argsLength: '{"mode":"background"}'.length,
            },
        ]);
    });

    test("reports a buffer with no arguments discarded at finish", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_empty", function: { name: "list_files", arguments: "" } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                reason: "incomplete_at_finish",
                index: 0,
                finishReason: "stop",
                hasId: true,
                argsLength: 0,
            },
        ]);
    });

    test("reports a complete call with invalid JSON arguments discarded at a non-tool finish", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_cut", function: { name: "write_file", arguments: '{"path":"a.ts","con' } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "length" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                reason: "invalid_json_args",
                index: 0,
                finishReason: "length",
                hasId: true,
                argsLength: '{"path":"a.ts","con'.length,
            },
        ]);
    });

    test("reports every buffer still open when a stream ends without a finish frame", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_open", function: { name: "read_file", arguments: '{"p":1}' } }),
            state
        );
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 1, id: "call_second", function: { name: "ls", arguments: "{}" } }],
                        },
                    },
                ],
            },
            state
        );

        reportUnfinishedToolCallBuffers(state);

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => [fields.reason, fields.index]),
            [
                ["stream_ended_before_finish", 0],
                ["stream_ended_before_finish", 1],
            ]
        );
    });

    test("reports a buffer replaced by a new call id at the same index", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_first", function: { name: "read_file", arguments: '{"p"' } }),
            state
        );

        interpretStreamEvent(
            toolCallDelta({ id: "call_second", function: { name: "list_files", arguments: "" } }),
            state
        );

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                reason: "replaced_by_new_id",
                index: 0,
                finishReason: undefined,
                hasId: true,
                argsLength: '{"p"'.length,
            },
        ]);
    });

    test("stays silent when the buffered tool call is emitted", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_ok", function: { name: "read_file", arguments: '{"p":1}' } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("stays silent when invalid JSON arguments are still emitted at a tool_calls finish", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_cut", function: { name: "write_file", arguments: '{"path":' } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("stays silent for an invalid buffer whose call id was already emitted as tagged text", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_dup", function: { name: "read_file", arguments: '{"p":' } }),
            state
        );
        const taggedCall = JSON.stringify({ id: "call_dup", name: "read_file", arguments: { p: 1 } });
        interpretStreamEvent(
            { choices: [{ delta: { content: `${TAGGED_CALL_OPENER}${taggedCall}${TAGGED_CALL_CLOSER}` } }] },
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("reports nothing unfinished after a finish frame settles every buffer", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_ok", function: { name: "read_file", arguments: '{"p":1}' } }),
            state
        );
        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        reportUnfinishedToolCallBuffers(state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("reports a malformed buffer skipped by premature-end recovery", () => {
        const state = createInitialStreamingState();
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        state.toolCallBuffers.set(0, { id: "call_cut", name: "write_file", args: "{invalid" });

        flushPendingBuffers(state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                reason: "invalid_json_args",
                index: 0,
                finishReason: undefined,
                hasId: true,
                argsLength: "{invalid".length,
            },
        ]);
    });
});

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
