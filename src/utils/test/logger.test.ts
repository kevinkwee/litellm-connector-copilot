import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { Logger } from "..//logger";

suite("Logger Unit Tests", () => {
    let mockChannel: {
        info: sinon.SinonSpy;
        warn: sinon.SinonSpy;
        error: sinon.SinonSpy;
        debug: sinon.SinonSpy;
        trace: sinon.SinonSpy;
        show: sinon.SinonSpy;
        dispose: sinon.SinonSpy;
    };
    let createOutputChannelStub: sinon.SinonStub;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockChannel = {
            info: sinon.spy(),
            warn: sinon.spy(),
            error: sinon.spy(),
            debug: sinon.spy(),
            trace: sinon.spy(),
            show: sinon.spy(),
            dispose: sinon.spy(),
        };
        createOutputChannelStub = sandbox
            .stub(vscode.window, "createOutputChannel")
            .returns(mockChannel as unknown as vscode.LogOutputChannel);
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Helper: re-stub createOutputChannel to return a channel with a specific
     * logLevel. Uses the suite's sandbox so it restores cleanly in teardown.
     * Must restore the previous stub before re-stubbing (sinon throws if you
     * wrap an already-wrapped method).
     */
    function restubChannelWithLevel(
        level: vscode.LogLevel
    ): {
        info: sinon.SinonSpy;
        warn: sinon.SinonSpy;
        error: sinon.SinonSpy;
        debug: sinon.SinonSpy;
        trace: sinon.SinonSpy;
        show: sinon.SinonSpy;
        dispose: sinon.SinonSpy;
        logLevel: vscode.LogLevel;
    } {
        const channel = {
            info: sinon.spy(),
            warn: sinon.spy(),
            error: sinon.spy(),
            debug: sinon.spy(),
            trace: sinon.spy(),
            show: sinon.spy(),
            dispose: sinon.spy(),
            logLevel: level,
        };
        // Restore the existing stub before creating a new one.
        createOutputChannelStub.restore();
        createOutputChannelStub = sandbox
            .stub(vscode.window, "createOutputChannel")
            .returns(channel as unknown as vscode.LogOutputChannel);
        return channel;
    }

    test("Logger.initialize creates channel and adds to subscriptions", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        Logger.initialize(mockContext as vscode.ExtensionContext);

        assert.ok(createOutputChannelStub.calledOnce);
        assert.strictEqual(createOutputChannelStub.firstCall.args[0], "LiteLLM");
        assert.strictEqual(mockContext.subscriptions?.length, 1);
        assert.strictEqual(mockContext.subscriptions?.[0], mockChannel as unknown as vscode.LogOutputChannel);
    });

    test("Logger methods call channel methods", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.info("info message");
        assert.ok(mockChannel.info.calledWith("info message"));

        Logger.warn("warn message");
        assert.ok(mockChannel.warn.calledWith("warn message"));

        Logger.debug("debug message");
        assert.ok(mockChannel.debug.calledWith("debug message"));

        Logger.trace("trace message");
        assert.ok(mockChannel.trace.calledWith("trace message"));

        Logger.show();
        assert.ok(mockChannel.show.calledOnce);
    });

    test("Logger.error handles strings and Errors", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.error("error string");
        assert.ok(mockChannel.error.calledWith("error string"));

        const error = new Error("test error");
        error.stack = "test stack";
        Logger.error(error);
        assert.ok(mockChannel.error.calledWith("test error", "test stack"));
    });

    /**
     * Performance regression tests: Logger.trace and Logger.debug MUST skip
     * the channel call entirely when the channel's log level is above them.
     * The streaming hot path fires dozens of Logger.trace calls per SSE
     * event; calling channel.trace (which internally formats the message)
     * on every event caused observable CPU spikes during long chat responses.
     */

    test("Logger.trace skips channel.trace when logLevel > Trace", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        const highLevelChannel = restubChannelWithLevel(vscode.LogLevel.Info);
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.trace("should be skipped", { foo: "bar" });

        assert.strictEqual(
            (highLevelChannel.trace as sinon.SinonSpy).callCount,
            0,
            "channel.trace must NOT be called when logLevel > Trace"
        );
    });

    test("Logger.debug skips channel.debug when logLevel > Debug", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        const highLevelChannel = restubChannelWithLevel(vscode.LogLevel.Info);
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.debug("should be skipped");

        assert.strictEqual(
            (highLevelChannel.debug as sinon.SinonSpy).callCount,
            0,
            "channel.debug must NOT be called when logLevel > Debug"
        );
    });

    test("Logger.trace still logs when logLevel === Trace (preserves verbose behavior)", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        const traceLevelChannel = restubChannelWithLevel(vscode.LogLevel.Trace);
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.trace("should be logged");
        assert.ok((traceLevelChannel.trace as sinon.SinonSpy).calledWith("should be logged"));
    });

    test("Logger.trace logs when channel.logLevel is undefined (no silent drops)", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        // The default mockChannel from setup() has no logLevel set -> undefined.
        // Logger.trace must still fire so we never silently lose diagnostic output.
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.trace("should be logged even with undefined logLevel");
        assert.ok(mockChannel.trace.calledWith("should be logged even with undefined logLevel"));
    });

    test("Logger.info/warn/error are NOT gated (always call channel)", () => {
        const mockContext: Partial<vscode.ExtensionContext> = { subscriptions: [] };
        const offLevelChannel = restubChannelWithLevel(vscode.LogLevel.Off);
        Logger.initialize(mockContext as vscode.ExtensionContext);

        Logger.info("info msg");
        Logger.warn("warn msg");
        Logger.error("error msg");

        // info/warn/error are not gated by this fix — VS Code's channel methods
        // already drop silently at Off, and these paths are not the hot-path
        // source of the CPU spike.
        assert.ok((offLevelChannel.info as sinon.SinonSpy).calledWith("info msg"));
        assert.ok((offLevelChannel.warn as sinon.SinonSpy).calledWith("warn msg"));
        assert.ok((offLevelChannel.error as sinon.SinonSpy).calledWith("error msg"));
    });
});
