import * as assert from "assert";
import * as sinon from "sinon";
import type { IMetrics } from "..//telemetry";
import { LiteLLMTelemetry } from "..//telemetry";
import { Logger } from "..//logger";

/**
 * Sinon's `args[0]` is typed as `any`, which trips no-unsafe-* lint rules
 * even when we cast at the call site. Wrapping the read in a typed helper
 * narrows the value once and lets every call site stay clean of `any`.
 */
function firstArg<T>(stub: sinon.SinonStub): T {
    const value: unknown = stub.firstCall.args[0];
    return value as T;
}

suite("Telemetry Unit Tests", () => {
    let loggerDebugStub: sinon.SinonStub;
    let loggerInfoStub: sinon.SinonStub;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        loggerDebugStub = sandbox.stub(Logger, "debug");
        loggerInfoStub = sandbox.stub(Logger, "info");
    });

    teardown(() => {
        sandbox.restore();
    });

    test("reportMetric logs to Logger.debug", () => {
        const metric: IMetrics = {
            requestId: "123",
            model: "gpt-4",
            durationMs: 100,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        assert.ok(logMessage.includes("[Telemetry]"));
        assert.ok(logMessage.includes('"requestId":"123"'));
        assert.ok(loggerInfoStub.calledOnce);
        const infoMessage = firstArg<string>(loggerInfoStub);
        assert.ok(infoMessage.includes("[TokenUsage]"));
        assert.ok(infoMessage.includes("tokens_in=0"));
        assert.ok(infoMessage.includes("tokens_out=0"));
        assert.ok(infoMessage.includes("token_count_max=n/a"));
        assert.ok(infoMessage.includes("total_token_max=n/a"));
    });

    test("IMetrics interface includes cacheReadRatio field", () => {
        const metric: IMetrics = {
            requestId: "999",
            model: "gpt-4-turbo",
            tokensIn: 1000,
            tokensOut: 500,
            cacheReadRatio: 0.35, // 35% cache hit ratio
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        assert.ok(logMessage.includes('"cacheReadRatio":0.35'));
    });

    test("cacheReadRatio is undefined when not provided", () => {
        const metric: IMetrics = {
            requestId: "888",
            model: "claude-3",
            tokensIn: 200,
            tokensOut: 100,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        // Ensure cacheReadRatio is not falsey but undefined, and doesn't appear in debug log
        assert.ok(!logMessage.includes('"cacheReadRatio"'));
    });

    test("Timer methods return numbers", () => {
        const start = LiteLLMTelemetry.startTimer();
        assert.strictEqual(typeof start, "number");

        const duration = LiteLLMTelemetry.endTimer(start);
        assert.strictEqual(typeof duration, "number");
        assert.ok(duration >= 0);
    });

    test("reportMetric includes caller context when provided", () => {
        const metric: IMetrics = {
            requestId: "123",
            model: "gpt-4",
            durationMs: 100,
            status: "success",
            caller: "inline-edit",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        assert.ok(logMessage.includes("[Telemetry]"));
        assert.ok(logMessage.includes('"caller":"inline-edit"'));
    });

    test("reportMetric handles metrics without caller", () => {
        const metric: IMetrics = {
            requestId: "456",
            model: "claude-3",
            status: "failure",
            error: "timeout",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        assert.ok(logMessage.includes("[Telemetry]"));
        assert.ok(logMessage.includes('"status":"failure"'));
    });

    test("reportMetric logs different caller contexts", () => {
        const callers = ["scm-generator", "terminal-chat", "inline-completions"];

        for (const caller of callers) {
            loggerDebugStub.resetHistory();

            const metric: IMetrics = {
                requestId: "test-" + caller,
                model: "gpt-4",
                status: "success",
                caller,
            };

            LiteLLMTelemetry.reportMetric(metric);

            assert.ok(loggerDebugStub.calledOnce);
            const logMessage = firstArg<string>(loggerDebugStub);
            assert.ok(logMessage.includes(`"caller":"${caller}"`), `Should log caller: ${caller}`);
        }
    });
});
