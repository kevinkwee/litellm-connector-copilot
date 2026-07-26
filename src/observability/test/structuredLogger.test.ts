import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { StructuredLogger } from "../structuredLogger";
import type { LogLevel, LogEvent } from "../types";

suite("StructuredLogger", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Log level filtering is now handled by VS Code's LogOutputChannel UI
     * (the dropdown in the output panel). StructuredLogger.isEnabled() always
     * returns true because all logs are sent to the channel and the channel
     * decides what to display based on the user-selected level.
     */

    test("isEnabled always returns true (filtering handled by output channel UI)", () => {
        // Regardless of previous state, isEnabled should always return true
        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("isEnabled returns true for all levels when using trace", () => {
        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("isEnabled returns true for all levels when using error", () => {
        // All levels return true - output channel UI handles filtering
        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("initialize uses distinct structured logger output channel name", () => {
        const mockChannel = {
            trace: () => undefined,
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.LogOutputChannel;

        const createOutputChannelStub = sandbox.stub(vscode.window, "createOutputChannel").returns(mockChannel);

        const context: Partial<vscode.ExtensionContext> = { subscriptions: [] };

        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = undefined;

        StructuredLogger.initialize(context as vscode.ExtensionContext);

        assert.ok(createOutputChannelStub.calledOnce);
        assert.strictEqual(createOutputChannelStub.firstCall.args[0], "LiteLLM Structured");
    });

    test("trace, debug, info, warn, error delegate to log with correct level", () => {
        const logStub = sandbox.stub(StructuredLogger, "log" as keyof typeof StructuredLogger);

        StructuredLogger.trace("t", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("trace", "t", {}, { requestId: "r" }));

        StructuredLogger.debug("d", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("debug", "d", {}, { requestId: "r" }));

        StructuredLogger.info("i", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("info", "i", {}, { requestId: "r" }));

        StructuredLogger.warn("w", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("warn", "w", {}, { requestId: "r" }));

        StructuredLogger.error("e", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("error", "e", {}, { requestId: "r" }));
    });

    test("log constructs correct LogEvent shape and calls channel", () => {
        const mockChannel = {
            info: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.info(
            "request.ingress",
            { foo: "bar" },
            { requestId: "req-1", model: "gpt-4", endpoint: "/v1", caller: "test" }
        );

        assert.ok((mockChannel.info as sinon.SinonStub).calledOnce);
        const logStr = (mockChannel.info as sinon.SinonStub).firstCall.args[0] as string;
        const parsedLog: unknown = JSON.parse(logStr);
        if (!parsedLog || typeof parsedLog !== "object") {
            throw new Error("Parsed log is not an object");
        }
        const logObj = parsedLog as LogEvent;

        assert.strictEqual(logObj.requestId, "req-1");
        assert.strictEqual(logObj.level, "info");
        assert.strictEqual(logObj.event, "request.ingress");
        assert.deepStrictEqual(logObj.data, { foo: "bar" });
        assert.strictEqual(logObj.model, "gpt-4");
        assert.strictEqual(logObj.endpoint, "/v1");
        assert.strictEqual(logObj.caller, "test");
        assert.ok(logObj.timestamp);
    });

    test("log calls warn and error channel methods for respective levels", () => {
        const mockChannel = {
            warn: sandbox.stub(),
            error: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.warn("test.warn", { data: "test" });
        assert.ok((mockChannel.warn as sinon.SinonStub).calledOnce);
        const warnLogStr = (mockChannel.warn as sinon.SinonStub).firstCall.args[0] as string;
        const warnParsed = JSON.parse(warnLogStr) as { event: string; level: string };
        assert.strictEqual(warnParsed.event, "test.warn");
        assert.strictEqual(warnParsed.level, "warn");

        StructuredLogger.error("test.error", { data: "test" });
        assert.ok((mockChannel.error as sinon.SinonStub).calledOnce);
        const errorLogStr = (mockChannel.error as sinon.SinonStub).firstCall.args[0] as string;
        const errorParsed = JSON.parse(errorLogStr) as { event: string; level: string };
        assert.strictEqual(errorParsed.event, "test.error");
        assert.strictEqual(errorParsed.level, "error");
    });

    test("log uses no-request default when requestId not provided", () => {
        const mockChannel = {
            info: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.info("test", { foo: "bar" });

        const logStr = (mockChannel.info as sinon.SinonStub).firstCall.args[0] as string;
        const parsed: unknown = JSON.parse(logStr);
        if (!parsed || typeof parsed !== "object") {
            throw new Error("Parsed log is not an object");
        }
        const logObj = parsed as LogEvent;
        assert.strictEqual(logObj.requestId, "no-request");
    });

    test("show calls channel.show", () => {
        const mockChannel = {
            show: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.show(false);
        assert.ok((mockChannel.show as sinon.SinonStub).calledOnce);
    });

    test("log lazily creates channel when called before initialize", () => {
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;

        const createOutputChannelStub = sandbox.stub(vscode.window, "createOutputChannel").returns(mockChannel);

        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = undefined;

        assert.doesNotThrow(() => {
            StructuredLogger.info("test", {});
        });

        assert.ok(createOutputChannelStub.calledOnce);
        assert.strictEqual(createOutputChannelStub.firstCall.args[0], "LiteLLM Structured");
        assert.ok((mockChannel.info as sinon.SinonStub).calledOnce);
    });

    /**
     * Performance regression tests: trace and debug MUST skip all work
     * (no LogEvent construction, no JSON.stringify, no channel call) when the
     * channel's log level is above the message level. The streaming hot path
     * fires dozens of trace calls per SSE event; building then discarding the
     * payload on every event caused observable CPU spikes and GC pressure
     * during long chat responses.
     */

    test("trace skips JSON.stringify and channel.trace when logLevel > Trace", () => {
        const stringifySpy = sandbox.spy(JSON, "stringify");
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
            logLevel: vscode.LogLevel.Info, // above Trace -> trace should be skipped
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.trace("stream.event_received", { payload: "x".repeat(1000) });

        assert.strictEqual(
            (mockChannel.trace as sinon.SinonStub).callCount,
            0,
            "channel.trace must NOT be called when level > Trace"
        );
        // JSON.stringify may have been called by other test infrastructure, so
        // we assert only that the trace path didn't add a call for the LogEvent.
        // A more direct check: no call args contain our event name.
        const traceCalls = stringifySpy
            .getCalls()
            .filter((c) => typeof c.args[0] === "object" && (c.args[0] as { event?: string }).event === "stream.event_received");
        assert.strictEqual(traceCalls.length, 0, "JSON.stringify must not be called for a skipped trace event");
    });

    test("debug skips JSON.stringify and channel.debug when logLevel > Debug", () => {
        const stringifySpy = sandbox.spy(JSON, "stringify");
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
            logLevel: vscode.LogLevel.Info, // above Debug -> debug should be skipped
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.debug("param.suppressed", { param: "temperature" });

        assert.strictEqual(
            (mockChannel.debug as sinon.SinonStub).callCount,
            0,
            "channel.debug must NOT be called when level > Debug"
        );
        const debugCalls = stringifySpy
            .getCalls()
            .filter((c) => typeof c.args[0] === "object" && (c.args[0] as { event?: string }).event === "param.suppressed");
        assert.strictEqual(debugCalls.length, 0, "JSON.stringify must not be called for a skipped debug event");
    });

    test("trace still logs when logLevel === Trace (preserves behavior when verbose logging is enabled)", () => {
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
            logLevel: vscode.LogLevel.Trace,
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.trace("stream.event_received", { foo: "bar" });

        assert.ok((mockChannel.trace as sinon.SinonStub).calledOnce, "trace must fire when level === Trace");
        const logStr = (mockChannel.trace as sinon.SinonStub).firstCall.args[0] as string;
        const parsed = JSON.parse(logStr) as { event: string; level: string };
        assert.strictEqual(parsed.event, "stream.event_received");
        assert.strictEqual(parsed.level, "trace");
    });

    test("debug still logs when logLevel === Debug (preserves behavior when verbose logging is enabled)", () => {
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
            logLevel: vscode.LogLevel.Debug,
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.debug("param.suppressed", { param: "top_p" });

        assert.ok((mockChannel.debug as sinon.SinonStub).calledOnce, "debug must fire when level === Debug");
    });

    test("trace logs when channel.logLevel is undefined (no filtering when level unknown)", () => {
        // Some test stubs and pre-initialize calls may have no logLevel set.
        // Default to "log everything" so we never silently drop diagnostic output.
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
            // logLevel intentionally omitted -> undefined
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.trace("stream.event_received", { foo: "bar" });

        assert.ok((mockChannel.trace as sinon.SinonStub).calledOnce, "trace must fire when logLevel is undefined");
    });

    test("info/warn/error always log regardless of trace/debug gating", () => {
        const mockChannel = {
            trace: sandbox.stub(),
            debug: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
            error: sandbox.stub(),
            show: sandbox.stub(),
            dispose: sandbox.stub(),
            logLevel: vscode.LogLevel.Off, // even "Off" should still hit info/warn/error
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        // info/warn/error are NOT gated by this fix — they always go through log().
        // VS Code's channel.info/.warn/.error already drop silently when level is Off,
        // and these paths are not the hot-path source of the CPU spike.
        StructuredLogger.info("request.ingress", {});
        StructuredLogger.warn("param.suppressed", {});
        StructuredLogger.error("request.error", {});

        assert.ok((mockChannel.info as sinon.SinonStub).calledOnce);
        assert.ok((mockChannel.warn as sinon.SinonStub).calledOnce);
        assert.ok((mockChannel.error as sinon.SinonStub).calledOnce);
    });
});
