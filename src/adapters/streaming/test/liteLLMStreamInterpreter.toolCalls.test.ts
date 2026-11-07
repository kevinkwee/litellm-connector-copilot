import * as assert from "assert";
import * as sinon from "sinon";
import { interpretStreamEvent, flushPendingBuffers, hasBufferedToolCalls } from "../liteLLMStreamInterpreter";
import { createInitialStreamingState } from "../streamingState";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { Logger } from "../../../utils/logger";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("Tool call argument deltas", () => {
    function toolCallFrame(toolCall: Record<string, unknown>): Record<string, unknown> {
        return { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] };
    }

    function emittedArgs(state: ReturnType<typeof createInitialStreamingState>): string[] {
        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);
        return parts.flatMap((part) => (part.type === "tool_call" ? [part.args] : []));
    }

    test("serializes an object arguments delta so the call still parses", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            toolCallFrame({ id: "call_obj", function: { name: "read_file", arguments: { p: 1 } } }),
            state
        );

        assert.deepStrictEqual(emittedArgs(state), ['{"p":1}']);
    });

    test("serializes an object arguments delta appended to an open call", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(toolCallFrame({ id: "call_obj", function: { name: "read_file", arguments: "" } }), state);
        interpretStreamEvent(toolCallFrame({ function: { arguments: { p: 1 } } }), state);

        assert.deepStrictEqual(emittedArgs(state), ['{"p":1}']);
    });

    test("ignores a numeric arguments delta", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            toolCallFrame({ id: "call_num", function: { name: "read_file", arguments: '{"p":1}' } }),
            state
        );
        interpretStreamEvent(toolCallFrame({ function: { arguments: 0 } }), state);

        assert.deepStrictEqual(emittedArgs(state), ['{"p":1}']);
    });

    test("ignores a null arguments delta", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            toolCallFrame({ id: "call_null", function: { name: "read_file", arguments: '{"p":1}' } }),
            state
        );
        interpretStreamEvent(toolCallFrame({ function: { arguments: null } }), state);

        assert.deepStrictEqual(emittedArgs(state), ['{"p":1}']);
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
        state.toolCallBuffers.set(0, { id: "bad-call", name: "badtool", args: "{invalid" });
        state.toolCallBuffers.set(1, { id: "good-call", name: "goodtool", args: '{"ok":true}' });

        const parts = flushPendingBuffers(state);

        assert.deepStrictEqual(
            parts.flatMap((part) => (part.type === "tool_call" ? [part.name] : [])),
            ["goodtool"]
        );
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

    test("skips an unnamed /responses call instead of inventing a tool name", () => {
        const state = createInitialStreamingState();
        state.responseToolCallBuffers.set("call-x", { id: "call-x", args: '{"q":1}' });
        state.responseToolCallOrder = ["call-x"];

        const parts = flushPendingBuffers(state);

        assert.deepStrictEqual(
            parts.filter((part) => part.type === "tool_call"),
            []
        );
    });

    test("omits malformed anonymous arguments from its warning", () => {
        const state = createInitialStreamingState();
        const warnStub = sinon.stub(Logger, "warn");
        state.anonymousResponseToolName = "execute_code";
        state.anonymousResponseToolArgs = '{"secret":"token-123"';

        try {
            flushPendingBuffers(state);
        } finally {
            warnStub.restore();
        }

        assert.deepStrictEqual(
            warnStub.getCalls().map((call) => String(call.args[0]).includes("token-123")),
            [false]
        );
    });

    test("drops an id-less chat-completions buffer instead of inventing a call id", () => {
        const state = createInitialStreamingState();
        state.toolCallBuffers.set(0, { id: "", name: "tool", args: '{"mode":"background"}' });

        const parts = flushPendingBuffers(state);

        assert.deepStrictEqual(
            parts.filter((part) => part.type === "tool_call"),
            []
        );
    });

    test("skips a chat-completions buffer whose call id was already emitted", () => {
        const state = createInitialStreamingState();
        state.emittedToolCallIds.add("fc_call_dup");
        state.toolCallBuffers.set(0, { id: "fc_call_dup", name: "read_file", args: '{"p":1}' });

        const parts = flushPendingBuffers(state);

        assert.deepStrictEqual(
            parts.filter((part) => part.type === "tool_call"),
            []
        );
    });
});

suite("hasBufferedToolCalls", () => {
    test("is false for a fresh stream", () => {
        assert.strictEqual(hasBufferedToolCalls(createInitialStreamingState()), false);
    });

    test("is true while a chat-completions tool call is open", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ls" } }] } }] },
            state
        );

        assert.strictEqual(hasBufferedToolCalls(state), true);
    });

    test("is true while a /responses tool call is open", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call_1", name: "ls", arguments: "{" },
            },
            state
        );

        assert.strictEqual(hasBufferedToolCalls(state), true);
    });

    test("is true while an anonymous /responses tool call is open", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            { type: "response.output_item.delta", item: { type: "function_call", arguments: "{" } },
            state
        );

        assert.strictEqual(hasBufferedToolCalls(state), true);
    });

    test("is false once a finish frame settles the chat-completions buffers", () => {
        const state = createInitialStreamingState();
        interpretStreamEvent(
            {
                choices: [
                    { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: "{}" } }] } },
                ],
            },
            state
        );
        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.strictEqual(hasBufferedToolCalls(state), false);
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

    test("still emits the buffered call when finish_reason is tool_calls, and leaves the drop to the emitter", () => {
        const state = createInitialStreamingState();
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const debugStub = sandbox.stub(StructuredLogger, "debug");
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
        // The emitter drops this call and owns its single record, so the interpreter
        // logs it at debug only.
        assert.strictEqual(
            errorStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_args_invalid_json").length,
            0
        );
        assert.strictEqual(
            warnStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_args_invalid_json").length,
            0
        );
        const corruptionCalls = debugStub
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
        assert.strictEqual(fields.normalizedId, "bad-call");
        assert.strictEqual(fields.toolName, "badtool");
        assert.strictEqual(fields.argsPreview, "{invalid");
    });

    test("a duplicate id at a tool_calls finish logs the corrupt arguments here", () => {
        // The call reaches neither the emitter nor a resend, so this layer is the one
        // that has to record the corrupt arguments.
        const state = createInitialStreamingState();
        state.emittedToolCallIds.add("fc_call_dup");
        state.toolCallBuffers.set(0, { id: "fc_call_dup", name: "read_file", args: '{"p":' });
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const debugStub = sandbox.stub(StructuredLogger, "debug");

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.strictEqual(
            errorStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_args_invalid_json").length,
            1
        );
        assert.strictEqual(
            debugStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_args_invalid_json").length,
            0
        );
    });
    test("still reports the corrupt arguments of a call whose id was already emitted", () => {
        const state = createInitialStreamingState();
        const errorStub = sandbox.stub(StructuredLogger, "error");
        state.emittedToolCallIds.add("fc_call_dup");
        state.toolCallBuffers.set(0, { id: "fc_call_dup", name: "read_file", args: '{"p":' });

        interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.strictEqual(
            errorStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_args_invalid_json").length,
            1
        );
    });

    test("tags a malformed /responses call skipped by recovery with its request id", () => {
        const state = createInitialStreamingState("req-responses");
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        state.responseToolCallBuffers.set("call-bad", { id: "call-bad", name: "search", args: "{invalid" });
        state.responseToolCallOrder = ["call-bad"];

        flushPendingBuffers(state);

        assert.deepStrictEqual(
            warnStub
                .getCalls()
                .filter((call) => call.args[0] === "stream.responses_tool_call_buffer_dropped")
                .map((call) => (call.args[1] as Record<string, unknown>).requestId),
            ["req-responses"]
        );
    });
});

suite("Dropped tool call buffer logging", () => {
    const DROPPED_EVENT = "stream.tool_call_buffer_dropped";
    const REQUEST_ID = "req-7";
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
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(toolCallDelta({ function: { arguments: '{"mode":"background"}' } }), state);

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                requestId: REQUEST_ID,
                reason: "incomplete_at_finish",
                index: 0,
                finishReason: "tool_calls",
                hasId: false,
                argsLength: '{"mode":"background"}'.length,
            },
        ]);
    });

    test("drops a call whose name never arrived instead of naming it 'tool'", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(toolCallDelta({ id: "call_noname", function: { arguments: '{"q":1}' } }), state);

        const parts = flushPendingBuffers(state).filter((part) => part.type === "tool_call");

        assert.deepStrictEqual(parts, [], "an unnamed call must not reach VS Code under a placeholder name");
        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["incomplete_at_finish"]
        );
    });

    test("keeps one call when the id arrives after the first fragment", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(toolCallDelta({ function: { name: "read_file", arguments: '{"path"' } }), state);
        interpretStreamEvent(toolCallDelta({ id: "call_late", function: { arguments: ':"a.ts"}' } }), state);

        const parts = flushPendingBuffers(state).filter((part) => part.type === "tool_call");

        assert.strictEqual(parts.length, 1);
        const call = parts[0];
        assert.ok(call.type === "tool_call", "the settled buffer is a tool call");
        assert.ok((call.id ?? "").startsWith("fc_"), "the late id is normalized");
        assert.strictEqual(call.args, '{"path":"a.ts"}');
    });

    test("reports a buffer with no arguments discarded at finish", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_empty", function: { name: "list_files", arguments: "" } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                requestId: REQUEST_ID,
                reason: "incomplete_at_finish",
                index: 0,
                finishReason: "stop",
                hasId: true,
                argsLength: 0,
            },
        ]);
    });

    test("reports a complete call with invalid JSON arguments discarded at a non-tool finish", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_cut", function: { name: "write_file", arguments: '{"path":"a.ts","con' } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "length" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                requestId: REQUEST_ID,
                reason: "invalid_json_args",
                index: 0,
                finishReason: "length",
                hasId: true,
                argsLength: '{"path":"a.ts","con'.length,
            },
        ]);
    });

    test("reports an id-less buffer dropped by premature-end recovery", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(toolCallDelta({ function: { arguments: '{"mode":"background"}' } }), state);

        flushPendingBuffers(state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                requestId: REQUEST_ID,
                reason: "incomplete_at_finish",
                index: 0,
                finishReason: "incomplete_stream_end",
                hasId: false,
                argsLength: '{"mode":"background"}'.length,
            },
        ]);
    });

    test("reports a buffer replaced by a new call id at the same index", () => {
        const state = createInitialStreamingState(REQUEST_ID);
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
                requestId: REQUEST_ID,
                reason: "replaced_by_new_id",
                index: 0,
                finishReason: undefined,
                hasId: true,
                argsLength: '{"p"'.length,
            },
        ]);
    });

    test("stays silent when the buffered tool call is emitted", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_ok", function: { name: "read_file", arguments: '{"p":1}' } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("stays silent when invalid JSON arguments are still emitted at a tool_calls finish", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            toolCallDelta({ id: "call_cut", function: { name: "write_file", arguments: '{"path":' } }),
            state
        );

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("stays silent for an invalid buffer whose call id was already emitted", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        state.emittedToolCallIds.add("call_dup");
        state.toolCallBuffers.set(0, { id: "call_dup", name: "read_file", args: '{"p":' });

        interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("reports a malformed buffer skipped by premature-end recovery", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        state.toolCallBuffers.set(0, { id: "call_cut", name: "write_file", args: "{invalid" });

        flushPendingBuffers(state);

        assert.deepStrictEqual(droppedEventFields(warnStub), [
            {
                requestId: REQUEST_ID,
                reason: "invalid_json_args",
                index: 0,
                finishReason: "incomplete_stream_end",
                hasId: true,
                argsLength: "{invalid".length,
            },
        ]);
    });
});

suite("Tool call drops", () => {
    test("records a /responses call dropped for unparseable arguments", () => {
        const state = createInitialStreamingState("req-dropped");

        const parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-bad", name: "search_files", arguments: "{not json" },
            },
            state
        );

        assert.strictEqual(
            parts.filter((part) => part.type === "tool_call").length,
            0,
            "an unreadable call must not reach VS Code"
        );
        assert.deepStrictEqual(state.droppedToolCalls, [{ id: "call-bad", name: "search_files" }]);
    });

    test("records a /responses call dropped while flushing for a completed response", () => {
        const state = createInitialStreamingState("req-completed");

        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call-keyed", name: "search_files", arguments: "{not json" },
            },
            state
        );
        interpretStreamEvent({ type: "response.completed", response: {} }, state);

        assert.deepStrictEqual(
            state.droppedToolCalls.map((call) => call.name),
            ["search_files"],
            "the completed-response flush records what it drops"
        );
    });

    test("records an anonymous /responses call dropped on output_item.done", () => {
        const state = createInitialStreamingState("req-anon-done");

        interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", name: "search_files", arguments: "{not json" },
            },
            state
        );

        assert.deepStrictEqual(
            state.droppedToolCalls,
            [{ id: "anonymous_req-anon-done", name: "search_files" }],
            "the record carries the request-scoped id"
        );
    });

    test("records every /responses call dropped while flushing buffers", () => {
        const state = createInitialStreamingState("req-flush");

        state.anonymousResponseToolName = "search_files";
        state.anonymousResponseToolArgs = "{not json";
        state.responseToolCallBuffers.set("call-keyed", { id: "call-keyed", name: "read_file", args: "[1," });
        state.responseToolCallOrder.push("call-keyed");

        const parts = flushPendingBuffers(state);

        assert.strictEqual(parts.filter((part) => part.type === "tool_call").length, 0);
        assert.deepStrictEqual(state.droppedToolCalls, [
            { id: "call-keyed", name: "read_file" },
            { id: "anonymous_req-flush", name: "search_files" },
        ]);
    });

    test("records a chat call dropped for unparseable arguments", () => {
        const state = createInitialStreamingState("req-dropped-chat");

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, id: "call-x", function: { name: "read_file", arguments: "" } }],
                        },
                    },
                ],
            },
            state
        );
        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: { tool_calls: [{ index: 0, function: { arguments: "{not json" } }] },
                        finish_reason: "stop",
                    },
                ],
            },
            state
        );

        assert.strictEqual(parts.filter((part) => part.type === "tool_call").length, 0);
        assert.deepStrictEqual(
            state.droppedToolCalls.map((call) => call.name),
            ["read_file"],
            "the dropped call is recorded so the turn can explain it"
        );
    });
});

suite("/responses incomplete tool calls", () => {
    const DROPPED_EVENT = "stream.responses_tool_call_buffer_dropped";
    const REQUEST_ID = "req-incomplete";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    function droppedEventFields(warnStub: sinon.SinonStub): Record<string, unknown>[] {
        return warnStub
            .getCalls()
            .filter((call) => call.args[0] === DROPPED_EVENT)
            .map((call) => call.args[1] as Record<string, unknown>);
    }

    test("logs a keyed /responses call with no name without recording a drop", () => {
        // The model never named the call, so no notice may claim a tool did not run.
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-noname", arguments: '{"q":1}' },
            },
            state
        );

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["incomplete"]
        );
        assert.deepStrictEqual(state.droppedToolCalls, []);
    });

    test("logs a keyed /responses call with no arguments without recording a drop", () => {
        // A call whose arguments never arrived was cut off, which the stream reader
        // judges from the finish, so it is not reported as a tool that failed to run.
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call-noargs", name: "search_files" },
            },
            state
        );

        interpretStreamEvent({ type: "response.completed", response: {} }, state);

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["incomplete"]
        );
        assert.deepStrictEqual(state.droppedToolCalls, []);
    });

    test("logs an incomplete anonymous /responses call at stream end without recording it", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        state.anonymousResponseToolName = "search_files";

        flushPendingBuffers(state);

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["incomplete"]
        );
        assert.deepStrictEqual(state.droppedToolCalls, []);
    });

    test("logs an incomplete anonymous /responses call on output_item.done without recording it", () => {
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        interpretStreamEvent(
            { type: "response.output_item.done", item: { type: "function_call", name: "search_files" } },
            state
        );

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["incomplete"]
        );
        assert.deepStrictEqual(state.droppedToolCalls, []);
    });

    test("logs nothing for an empty anonymous buffer at stream end", () => {
        // A recovery with no anonymous call buffered must not report a drop for a call
        // that never existed.
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        flushPendingBuffers(state);

        assert.deepStrictEqual(droppedEventFields(warnStub), []);
    });

    test("logs a malformed anonymous /responses call under the shared drop event", () => {
        // One event name covers the keyed and anonymous shapes, so a support reader
        // finds every dropped call under the same key.
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        state.anonymousResponseToolName = "search_files";
        state.anonymousResponseToolArgs = "{not json";

        flushPendingBuffers(state);

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["invalid_json_args"]
        );
    });
});

suite("Declared tool name mapping", () => {
    test("emits the declared name when the wire name was sanitized", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                { index: 0, id: "call-1", function: { name: "search_files", arguments: "{}" } },
                            ],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "search files");
    });

    test("leaves an ordinary name unchanged when the map has no entry for it", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, id: "call-2", function: { name: "read_file", arguments: "{}" } }],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "read_file");
    });

    test("resolves the name on a keyed /responses flush that repeats the wire name", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call-3", name: "search_files", arguments: "{}" },
            },
            state
        );

        const parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-3", name: "search_files", arguments: "{}" },
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "search files");
    });

    test("keeps the resolved name when a chat delta repeats the wire name", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, id: "call-4", function: { name: "search_files", arguments: "" } }],
                        },
                    },
                ],
            },
            state
        );
        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, function: { name: "search_files", arguments: "{}" } }],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "search files");
    });

    test("resolves the name on an anonymous /responses flush that repeats the wire name", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", name: "search_files", arguments: "{}" },
            },
            state
        );

        const parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", name: "search_files", arguments: "{}" },
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "search files");
    });

    test("keeps the buffered name when a done frame carries an empty name", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "call-5", name: "search_files", arguments: "{}" },
            },
            state
        );

        const parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-5", name: "", arguments: "{}" },
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "search files");
    });

    test("resolves the name of a Gemini function call", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

        const parts = interpretStreamEvent(
            {
                candidates: [
                    {
                        content: {
                            parts: [{ functionCall: { name: "search_files", args: { q: "x" } } }],
                        },
                    },
                ],
            },
            state
        );

        const toolCall = parts.find((part) => part.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        assert.strictEqual(toolCall.name, "search files");
    });
});
