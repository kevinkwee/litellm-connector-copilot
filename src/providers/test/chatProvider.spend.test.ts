import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient, LiteLLMRateLimitError } from "../../adapters/litellmClient";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { Logger } from "../../utils/logger";
import { HeadersTimeoutError } from "../../utils/transportRetry";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { runChatRequest, seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";

/** A body that emits text and a usage frame, then dies of a dropped socket. */
function dyingStreamAfterUsage(promptTokens: number, completionTokens: number): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
            controller.enqueue(
                encoder.encode(
                    `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens}}}\n\n`
                )
            );
        },
        pull(controller) {
            controller.error(new TypeError("terminated"));
        },
    });
}

/** A body that emits text and a usage frame, then closes cleanly. */
function answeredStream(promptTokens: number, completionTokens: number): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
            controller.enqueue(
                encoder.encode(
                    `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens}}}\n\n`
                )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
}

const PRICING = { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 };

suite("LiteLLM Chat Provider Spend", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /** A provider whose model declares rates, so every folded cost is observed. */
    function createProvider(config: Record<string, unknown> = {}): LiteLLMChatProvider {
        const provider = new LiteLLMChatProvider(userAgent);
        const internals = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
            _registry: { getModelInfo: (id: string) => unknown };
        };
        sandbox.stub(internals._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
            ...config,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        sandbox.stub(internals._registry, "getModelInfo").returns(PRICING);
        return provider;
    }

    function metricOf(metricStub: sinon.SinonStub, status: string): Record<string, unknown> | undefined {
        return metricStub
            .getCalls()
            .map((call) => call.args[0] as Record<string, unknown>)
            .find((metric) => metric.status === status);
    }

    test("a failed retried turn reports the prompt of every attempt in its metric", async () => {
        // The proxy billed both attempts, so the failure metric reports their sum
        // rather than the last attempt's prompt.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider({ networkRetries: 1 });
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.onFirstCall().callsFake(async () => dyingStreamAfterUsage(100, 10));
        chatStub.onSecondCall().callsFake(async () => dyingStreamAfterUsage(120, 20));

        await runChatRequest(provider, []);

        const failedMetric = metricOf(metricStub, "failure");
        assert.deepStrictEqual(
            { prompt: failedMetric?.tokensIn, output: failedMetric?.tokensOut },
            { prompt: 220, output: 30 },
            "a failed turn reports the spend of both attempts, not zero output"
        );
    });

    test("a turn that recovered from a refused connection bills only the attempt that ran", async () => {
        // A refused connection never reached the proxy, so its prompt estimate must not
        // be reported as spend.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider({ networkRetries: 1 });
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.onFirstCall().callsFake(async () => {
            throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        });
        chatStub.onSecondCall().callsFake(async () => answeredStream(120, 20));

        await runChatRequest(provider, []);

        assert.strictEqual(
            metricOf(metricStub, "success")?.tokensIn,
            120,
            "the refused attempt's estimate is not billed"
        );
    });

    test("a turn that recovered from a headers timeout keeps that attempt's prompt", async () => {
        // The proxy may have received that request even though it never answered, so the
        // attempt stays billable rather than being written off.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider({ networkRetries: 1, headersTimeoutMs: 1_000 });
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.onFirstCall().callsFake(async () => {
            throw new HeadersTimeoutError(1_000);
        });
        chatStub.onSecondCall().callsFake(async () => answeredStream(120, 20));

        await runChatRequest(provider, []);

        assert.ok(
            ((metricOf(metricStub, "success")?.tokensIn as number | undefined) ?? 0) > 120,
            "the timed-out attempt keeps its prompt estimate alongside the answered one"
        );
    });

    test("a failed turn writes the final usage line", async () => {
        const debugStub = sandbox.stub(Logger, "debug");
        const provider = createProvider({ networkRetries: 0 });
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        });

        await runChatRequest(provider, []);

        const finalLines = debugStub
            .getCalls()
            .map((call) => String(call.args[0]))
            .filter((message) => message.includes("[TokenUsage][Final]"));
        assert.strictEqual(finalLines.length, 1, "a failed turn publishes its token totals once");
    });

    test("a turn whose every attempt was refused reports no prompt cost", async () => {
        // The connection never opened, so the proxy saw no prompt to bill.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        });

        await runChatRequest(provider, []);

        const failed = metricOf(metricStub, "failure");
        assert.deepStrictEqual(
            { prompt: failed?.tokensIn, inputCost: failed?.estimatedInputCost },
            { prompt: 0, inputCost: 0 },
            "a refused turn is priced for nothing"
        );
    });

    test("a 500 refusal keeps its prompt, because the proxy may have run the call", async () => {
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new LiteLLMApiError(500, "boom", "LiteLLM API error: 500 Internal Server Error");
        });

        await runChatRequest(provider, []);

        assert.ok(
            ((metricOf(metricStub, "failure")?.tokensIn as number | undefined) ?? 0) > 0,
            "a 5xx keeps the attempt priced, because the upstream call may have run"
        );
    });

    test("a rate-limit give-up reports no prompt cost", async () => {
        // The proxy records no cost for a request it refused, so the give-up is unbilled.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new LiteLLMRateLimitError(
                { reason: "budget_exhausted", waitedMs: 0, budgetMs: 0 },
                "Too Many Requests",
                "rate limited"
            );
        });

        await runChatRequest(provider, []);

        assert.strictEqual(metricOf(metricStub, "failure")?.tokensIn, 0);
    });

    test("a turn cancelled before it sends a request reports no prompt cost", async () => {
        // Nothing left the connector, so no prompt was consumed.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider();
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => answeredStream(120, 20));
        const cancelled = new vscode.CancellationTokenSource();
        cancelled.cancel();

        await assert.rejects(
            runChatRequest(provider, [], cancelled.token),
            (err: unknown) => err instanceof Error && err.name === "CancellationError",
            "a host cancellation is thrown, because VS Code renders that state itself"
        );

        assert.deepStrictEqual(
            { requests: chatStub.callCount, prompt: metricOf(metricStub, "cancelled")?.tokensIn },
            { requests: 0, prompt: 0 },
            "a turn cancelled before it sends a request is priced for nothing"
        );
    });

    test("a resume that fails before it sends keeps only the prompt of the attempt that ran", async () => {
        // The resume is discarded at the start of the retry, so a failure while the resumed
        // request is built must not price it with the replaced attempt's prompt estimate.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider({ networkRetries: 1 });
        const configStub = (provider as unknown as { _configManager: { getConfig: sinon.SinonStub } })._configManager
            .getConfig;
        let configBroken = false;
        configStub.callsFake(async () => {
            if (configBroken) {
                throw new Error("configuration unavailable");
            }
            return { url: "http://localhost:4000", networkRetryDelayMs: 1, inactivityTimeout: 60 };
        });
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            configBroken = true;
            return dyingStreamAfterUsage(100, 10);
        });

        await runChatRequest(provider, []);

        const failed = metricOf(metricStub, "failure");
        assert.deepStrictEqual(
            { prompt: failed?.tokensIn, output: failed?.tokensOut },
            { prompt: 100, output: 10 },
            "only the attempt that reached the proxy is billed"
        );
    });

    test("a turn the connector refuses for a missing credential reports no prompt cost", async () => {
        // The transport refuses before the fetch, so nothing reached the proxy even though
        // the attempt had already handed the request over.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = new LiteLLMChatProvider(userAgent);
        const internals = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(internals._configManager, "getConfig").resolves({ networkRetryDelayMs: 1, inactivityTimeout: 60 });

        await provider.provideLanguageModelChatResponse(
            {
                id: "model-1",
                name: "model-1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => undefined },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(metricOf(metricStub, "failure")?.tokensIn, 0);
    });

    test("a turn rejected before the stream reports no prompt cost", async () => {
        // A failed turn reports its spend, but a request the proxy refused costs the proxy
        // nothing, so the connector's own prompt estimate must not be reported as spend.
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const provider = createProvider();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new LiteLLMApiError(400, "bad request", "LiteLLM API error: 400 Bad Request");
        });

        await runChatRequest(provider, []);

        const failed = metricOf(metricStub, "failure");
        assert.deepStrictEqual(
            { prompt: failed?.tokensIn, inputCost: failed?.estimatedInputCost },
            { prompt: 0, inputCost: 0 },
            "a rejected turn is priced for nothing"
        );
    });
});
