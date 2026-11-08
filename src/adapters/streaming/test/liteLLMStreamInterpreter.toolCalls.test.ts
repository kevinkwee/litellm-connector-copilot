import * as assert from "assert";
import * as sinon from "sinon";
import { interpretStreamEvent, flushPendingBuffers, hasBufferedToolCalls } from "../liteLLMStreamInterpreter";
import { createInitialStreamingState } from "../streamingState";
import { StructuredLogger } from "../../../observability/structuredLogger";

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

    test("logs the argument detail at debug and drops the buffered call when args are invalid and finish_reason is stop", () => {
        const state = createInitialStreamingState();
        const detailStub = sandbox.stub(StructuredLogger, "debug");
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
        const corruptionCalls = detailStub
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
        const detailStub = sandbox.stub(StructuredLogger, "debug");
        const warnStub = sandbox.stub(StructuredLogger, "warn");
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
        // The emitter drops this call and owns its single record, so this layer keeps
        // the argument detail at debug level and writes no drop record.
        const corruptionCalls = detailStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.tool_call_args_invalid_json");
        assert.strictEqual(corruptionCalls.length, 1);
        const fields = corruptionCalls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(fields.finishReason, "tool_calls");
        assert.strictEqual(
            warnStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_buffer_dropped").length,
            0
        );
    });

    test("flushPendingBuffers records one drop and keeps its argument detail at debug", () => {
        const state = createInitialStreamingState();
        const detailStub = sandbox.stub(StructuredLogger, "debug");
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        state.toolCallBuffers.set(0, { id: "bad-call", name: "badtool", args: "{invalid" });
        state.toolCallBuffers.set(1, { id: "good-call", name: "goodtool", args: '{"ok":true}' });

        const parts = flushPendingBuffers(state);

        const emitted = parts.filter((p) => p.type === "tool_call");
        assert.strictEqual(emitted.length, 1);
        if (emitted[0] && emitted[0].type === "tool_call") {
            assert.strictEqual(emitted[0].name, "goodtool");
        }
        assert.deepStrictEqual(
            warnStub
                .getCalls()
                .filter((call) => call.args[0] === "stream.tool_call_buffer_dropped")
                .map((call) => (call.args[1] as Record<string, unknown>).reason),
            ["invalid_json_args"],
            "the drop leaves exactly one warn record"
        );
        const fields = detailStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.tool_call_args_invalid_json")
            .map((call) => call.args[1] as Record<string, unknown>)[0];
        assert.strictEqual(fields.normalizedId, "bad-call");
        assert.strictEqual(fields.toolName, "badtool");
        assert.strictEqual(fields.argsPreview, "{invalid");
    });

    test("a skipped duplicate writes no record", () => {
        // The call was already delivered, so nothing ran and nothing failed: a skipped
        // duplicate is not a drop and has nothing to explain.
        const state = createInitialStreamingState();
        state.emittedToolCallIds.add("fc_call_dup");
        state.toolCallBuffers.set(0, { id: "fc_call_dup", name: "read_file", args: '{"p":' });
        const detailStub = sandbox.stub(StructuredLogger, "debug");
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        assert.deepStrictEqual(
            {
                detail: detailStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_args_invalid_json")
                    .length,
                drop: warnStub.getCalls().filter((call) => call.args[0] === "stream.tool_call_buffer_dropped").length,
            },
            { detail: 0, drop: 0 }
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

    test("logs a /responses call with no name without recording a drop", () => {
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

    test("logs a /responses call with no arguments without recording a drop", () => {
        // A call whose arguments never arrived was cut off, which the stream reader
        // judges from the finish, so it is not reported as a tool that failed to run.
        const state = createInitialStreamingState(REQUEST_ID);
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-noargs", name: "search_files" },
            },
            state
        );

        assert.deepStrictEqual(
            droppedEventFields(warnStub).map((fields) => fields.reason),
            ["incomplete"]
        );
        assert.deepStrictEqual(state.droppedToolCalls, []);
    });
});

suite("Non-object tool arguments", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("drops a chat call whose arguments are a JSON array", () => {
        // The settle path is the layer that decides, so the gate is asserted here rather
        // than only in the emitter.
        const state = createInitialStreamingState("req-array");

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, id: "call_arr", function: { name: "ls", arguments: "[]" } }],
                        },
                    },
                ],
            },
            state
        );
        const parts = interpretStreamEvent({ choices: [{ finish_reason: "stop" }] }, state);

        assert.deepStrictEqual(
            {
                calls: parts.filter((part) => part.type === "tool_call").length,
                dropped: state.droppedToolCalls.map((call) => call.name),
            },
            { calls: 0, dropped: ["ls"] }
        );
    });

    test("drops a /responses call whose arguments are null", () => {
        // `null` parses as JSON, so only the object check keeps it from becoming a tool
        // input no schema allows.
        const state = createInitialStreamingState("req-null");

        const parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call_null", name: "ls", arguments: "null" },
            },
            state
        );

        assert.deepStrictEqual(
            {
                calls: parts.filter((part) => part.type === "tool_call").length,
                dropped: state.droppedToolCalls.map((call) => call.name),
            },
            { calls: 0, dropped: ["ls"] }
        );
    });

    test("records a /responses drop by its argument length only", () => {
        const state = createInitialStreamingState("req-args-length");
        const warnStub = sandbox.stub(StructuredLogger, "warn");
        const secret = "SECRETVALUE";
        const args = `{"q":"${secret}`;

        interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call_bad", name: "ls", arguments: args },
            },
            state
        );

        const record = warnStub
            .getCalls()
            .filter((call) => call.args[0] === "stream.responses_tool_call_buffer_dropped")
            .map((call) => call.args[1] as Record<string, unknown>)[0];
        assert.deepStrictEqual(
            { carriesText: JSON.stringify(record).includes(secret), argsLength: record.argsLength },
            { carriesText: false, argsLength: args.length }
        );
    });

    test("logs a /responses function call that carries no call id", () => {
        // No supported server sends this shape, and a call the connector cannot address
        // is a drop it has to state rather than swallow.
        const state = createInitialStreamingState("req-no-id");
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", name: "ls", arguments: "{}" },
            },
            state
        );

        assert.deepStrictEqual(
            warnStub
                .getCalls()
                .filter((call) => call.args[0] === "stream.responses_tool_call_buffer_dropped")
                .map((call) => (call.args[1] as Record<string, unknown>).reason),
            ["incomplete"]
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

    test("resolves the name a /responses done frame carries as a wire name", () => {
        const state = createInitialStreamingState("req-names", new Map([["search_files", "search files"]]));

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
});
