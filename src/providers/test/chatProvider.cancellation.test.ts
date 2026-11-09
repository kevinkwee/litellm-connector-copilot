import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient } from "../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../types";
import { ActiveRequestRegistry, type ActiveRequestPhase } from "../activeRequests";
import { CopilotMdManager, type CopilotMdEntry } from "../../observability";
import { StructuredLogger } from "../../observability/structuredLogger";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { Logger } from "../../utils/logger";
import { calculateRequestCost, extractPricing } from "../../utils/pricingCalculator";
import type { LiteLLMModelInfo } from "../../types";
import { collectResponseText, TEST_USER_AGENT } from "../../test/utils/testMocks";
import {
    runChatRequest,
    seedDiscoveredBackend,
    settleWithin,
    stubCleanChatStream,
    stubConfigAndDiscovery,
    waitFor,
    waitForReportedText,
} from "../../test/utils/chatProviderTestUtils";

/** Retry backoff long enough that only a cancellation can end the request promptly. */
const BACKOFF_MS = 5_000;

/** Per-token rates, so an estimated cost is observable in the metrics. */
const MODEL_PRICING = { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 };

suite("LiteLLM Chat Provider Cancellation", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Cancels a request from the connector once its stream has delivered one delta,
     * and returns the stubs that recorded the outcome. The stream never finishes on
     * its own, so the cancellation is the only thing that can end this request.
     */
    async function runConnectorCancelledRequest(): Promise<{
        registry: ActiveRequestRegistry;
        reported: vscode.LanguageModelResponsePart[];
        phaseAtCancel: ActiveRequestPhase | undefined;
        metricStub: sinon.SinonStub;
        exportStub: sinon.SinonStub;
        chatCalls: number;
    }> {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(userAgent, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const encoder = new TextEncoder();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const exportStub = sandbox.stub(CopilotMdManager.instance, "exportEntry").resolves(undefined);
        let chatCalls = 0;
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            chatCalls += 1;
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                },
            });
        });

        const host = new vscode.CancellationTokenSource();
        const request = runChatRequest(provider, reported, host.token).catch(() => undefined);
        let phaseAtCancel: ActiveRequestPhase | undefined;
        try {
            // The cancel has to land mid-stream rather than during request construction.
            await waitForReportedText(reported, "partial");
            const [entry] = registry.list();
            assert.ok(entry, "the live request must be listed while it streams");
            phaseAtCancel = entry.phase;
            entry.cancel();
            await request;
        } finally {
            // Settles the request if the precondition failed before the cancel landed.
            host.cancel();
            await request;
            host.dispose();
        }

        return { registry, reported, phaseAtCancel, metricStub, exportStub, chatCalls };
    }

    /** The entry the provider wrote to the `.copilotmd` transcript. */
    function transcriptOf(exportStub: sinon.SinonStub): CopilotMdEntry {
        const transcript = exportStub.firstCall?.args[0] as CopilotMdEntry | undefined;
        assert.ok(transcript, "the turn must be written to the transcript");
        return transcript;
    }

    test("ends the turn with a notice when the connector cancels the request", async () => {
        const { reported } = await runConnectorCancelledRequest();

        assert.match(collectResponseText(reported), /cancelled from the LiteLLM connector/i);
    });

    test("does not retry a request the connector cancelled", async () => {
        const { chatCalls } = await runConnectorCancelledRequest();

        assert.strictEqual(chatCalls, 1);
    });

    test("lists a request as streaming once its stream starts", async () => {
        const { phaseAtCancel } = await runConnectorCancelledRequest();

        assert.strictEqual(phaseAtCancel, "streaming");
    });

    test("reports a connector cancellation as cancelled, not failed", async () => {
        const { metricStub } = await runConnectorCancelledRequest();

        const statuses = metricStub.getCalls().map((call) => (call.args[0] as { status?: string }).status);
        assert.deepStrictEqual(statuses, ["cancelled"]);
    });

    test("records a connector cancellation in the transcript", async () => {
        const { exportStub } = await runConnectorCancelledRequest();

        const transcript = transcriptOf(exportStub);
        assert.strictEqual(transcript.status, "canceled");
        assert.match(String(transcript.statusReason), /Cancelled from the LiteLLM connector/);
    });

    test("keeps the connector notice out of the transcript", async () => {
        const { exportStub } = await runConnectorCancelledRequest();

        // The transcript records what the model produced, before the notice is added.
        const parts = transcriptOf(exportStub).responseParts;
        assert.deepStrictEqual(
            parts.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "<not text>")),
            ["partial"]
        );
    });

    test("releases its host cancellation listener when the request ends", async () => {
        let registrations = 0;
        let disposeCalls = 0;
        const hostToken: vscode.CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => {
                registrations += 1;
                return {
                    dispose: (): void => {
                        disposeCalls += 1;
                    },
                };
            },
        };
        const provider = new LiteLLMChatProvider(userAgent);
        stubConfigAndDiscovery(sandbox, provider);
        stubCleanChatStream(sandbox, []);
        const reported: vscode.LanguageModelResponsePart[] = [];

        await runChatRequest(provider, reported, hostToken);

        assert.ok(registrations > 0, "the request must register a host listener");
        assert.strictEqual(disposeCalls, registrations, "every listener left on the host token must be released");
    });

    test("leaves the registry empty after a connector cancellation", async () => {
        const { registry } = await runConnectorCancelledRequest();

        assert.deepStrictEqual(registry.list(), []);
    });

    /**
     * Runs a request whose attempts end the way `attemptBehaviour` decides, and
     * cancels it from the connector while the provider sits in its backoff. Only a
     * cancellation that reaches that sleep can end the turn inside 500 ms.
     */
    async function runBackoffCancelledRequest(
        attemptBehaviour: () => ReadableStream<Uint8Array>,
        modelInfo?: Record<string, unknown>
    ): Promise<{
        reported: vscode.LanguageModelResponsePart[];
        chatCalls: number;
        exportStub: sinon.SinonStub;
        metricStub: sinon.SinonStub;
    }> {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(userAgent, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: BACKOFF_MS,
            emptyResponseRetries: 3,
            emptyResponseRetryDelayMs: BACKOFF_MS,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        if (modelInfo) {
            sandbox
                .stub(
                    (provider as unknown as { _registry: { getModelInfo: (id: string) => unknown } })._registry,
                    "getModelInfo"
                )
                .returns(modelInfo);
        }
        const reported: vscode.LanguageModelResponsePart[] = [];
        const exportStub = sandbox.stub(CopilotMdManager.instance, "exportEntry").resolves(undefined);
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        let chatCalls = 0;
        // The retry decision is logged immediately before the sleep, so waiting for it
        // arms the cancel without depending on a fixed delay.
        let retryDecided = false;
        sandbox.stub(StructuredLogger, "warn").callsFake((event: string) => {
            if (event === "request.transport_retry" || event === "request.reasoning_only_retry") {
                retryDecided = true;
            }
        });
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            chatCalls += 1;
            return attemptBehaviour();
        });

        const host = new vscode.CancellationTokenSource();
        const request = runChatRequest(provider, reported, host.token).catch(() => undefined);
        try {
            await waitFor(() => retryDecided, "the retry decision was never logged");
            const [entry] = registry.list();
            assert.ok(entry, "a request waiting to retry must still be listed");
            entry.cancel();
            await settleWithin(request, 500, "the backoff ignored the cancellation");
        } finally {
            host.cancel();
            await request;
            host.dispose();
        }

        return { reported, chatCalls, exportStub, metricStub };
    }

    test("ends the transport backoff at once when the connector cancels", async () => {
        const { reported } = await runBackoffCancelledRequest(() => {
            throw new TypeError("terminated");
        });

        assert.match(collectResponseText(reported), /cancelled from the LiteLLM connector/i);
    });

    test("sends no further request after a backoff cancel", async () => {
        const { chatCalls } = await runBackoffCancelledRequest(() => {
            throw new TypeError("terminated");
        });

        assert.strictEqual(chatCalls, 1);
    });

    test("prices nothing for a refusal that a backoff cancel interrupted", async () => {
        // The cancel inherits the refused attempt's verdict instead of replacing it, so the
        // cancelled turn reports no prompt for a connection the proxy never accepted.
        const { metricStub } = await runBackoffCancelledRequest(() => {
            throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        }, MODEL_PRICING);

        const cancelled = metricStub
            .getCalls()
            .map((call) => call.args[0] as Record<string, unknown>)
            .find((metric) => metric.status === "cancelled");
        assert.deepStrictEqual(
            { prompt: cancelled?.tokensIn, inputCost: cancelled?.estimatedInputCost },
            { prompt: 0, inputCost: 0 },
            "a refused connection is priced for nothing even when a cancel ends the retry"
        );
    });

    test("ends the reasoning-only backoff at once when the connector cancels", async () => {
        const encoder = new TextEncoder();
        const { reported } = await runBackoffCancelledRequest(
            () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n')
                        );
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                })
        );

        assert.match(collectResponseText(reported), /cancelled from the LiteLLM connector/i);
    });

    test("writes the attempt a backoff cancel replaced to the transcript", async () => {
        // The reset that folds a replaced attempt into the request totals runs at the
        // top of the next attempt, so a cancel during the sleep leaves that attempt as
        // the last one instead of clearing it into an estimate for a retry never made.
        const encoder = new TextEncoder();
        const { exportStub } = await runBackoffCancelledRequest(
            () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                        controller.enqueue(
                            encoder.encode(
                                'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\n'
                            )
                        );
                    },
                    pull(controller) {
                        controller.error(new TypeError("terminated"));
                    },
                })
        );

        const transcript = transcriptOf(exportStub);
        assert.deepStrictEqual(
            { prompt: transcript.usage.promptTokens, output: transcript.usage.outputTokens },
            { prompt: 100, output: 10 }
        );
    });

    test("the cancelled metric reports the spend of the attempt that ran", async () => {
        // The metric reads the same snapshot the transcript does, so a cancel during
        // the sleep cannot report an attempt that never ran, and the turn still states
        // what it cost.
        const encoder = new TextEncoder();
        const pricing = { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 };
        const { metricStub } = await runBackoffCancelledRequest(
            () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                        controller.enqueue(
                            encoder.encode(
                                'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\n'
                            )
                        );
                    },
                    pull(controller) {
                        controller.error(new TypeError("terminated"));
                    },
                }),
            pricing as unknown as Record<string, unknown>
        );

        const cancelledMetric = metricStub
            .getCalls()
            .map(
                (call) =>
                    call.args[0] as {
                        status?: string;
                        tokensIn?: number;
                        tokensOut?: number;
                        estimatedTotalCost?: number;
                    }
            )
            .find((metric) => metric.status === "cancelled");
        const pricedAttempt = calculateRequestCost({
            promptTokens: 100,
            completionTokens: 10,
            cachedTokens: 0,
            cacheCreationInputTokens: 0,
            pricing: extractPricing(pricing as unknown as LiteLLMModelInfo),
        });
        assert.deepStrictEqual(
            {
                prompt: cancelledMetric?.tokensIn,
                output: cancelledMetric?.tokensOut,
                cost: cancelledMetric?.estimatedTotalCost,
            },
            { prompt: 100, output: 10, cost: pricedAttempt.totalCost },
            "the cancelled metric reports the attempt's prompt, output and cost"
        );
    });

    test("writes the final usage line for a cancelled turn", async () => {
        const debugStub = sandbox.stub(Logger, "debug");
        const encoder = new TextEncoder();
        await runBackoffCancelledRequest(
            () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                    },
                    pull(controller) {
                        controller.error(new TypeError("terminated"));
                    },
                })
        );

        const finalLines = debugStub
            .getCalls()
            .map((call) => String(call.args[0]))
            .filter((message) => message.includes("[TokenUsage][Final]"));
        assert.strictEqual(finalLines.length, 1, "a cancelled turn publishes its token totals once");
    });

    test("cancels a request that is still waiting for response headers", async () => {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(userAgent, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            headersTimeoutMs: 60_000,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const host = new vscode.CancellationTokenSource();
        // A request that only settles when its signal is aborted, so nothing but a
        // cancellation that reaches the client can end it.
        let fetchStarted = false;
        let fetchSignal: AbortSignal | undefined;
        sandbox.stub(global, "fetch").callsFake(
            (_input: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    fetchSignal = init?.signal ?? undefined;
                    fetchStarted = true;
                    fetchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                })
        );

        const request = runChatRequest(provider, reported, host.token).catch(() => undefined);
        try {
            await waitFor(() => fetchStarted, "the request never reached fetch");
            const [entry] = registry.list();
            assert.ok(entry, "a request that has not received headers must still be listed");
            entry.cancel();

            // Asserted directly, so a wiring that leaves the fetch with the host
            // token fails here instead of hanging until the runner gives up.
            await waitFor(() => fetchSignal?.aborted === true, "the fetch was never aborted", 500);
            await request;

            assert.match(collectResponseText(reported), /cancelled from the LiteLLM connector/i);
            assert.deepStrictEqual(registry.list(), []);
        } finally {
            // Settles the request if an assertion above failed before the cancel
            // reached the client.
            host.cancel();
            await request;
            host.dispose();
        }
    });

    test("reports the sending phase again when a retry starts a new header wait", async () => {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(userAgent, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 2,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const encoder = new TextEncoder();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const phasesAtSend: (string | undefined)[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            phasesAtSend.push(registry.list()[0]?.phase);
            if (phasesAtSend.length === 1) {
                // A stream that dies without output, so the retry resends it.
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new TypeError("terminated"));
                    },
                });
            }
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        await runChatRequest(provider, reported);

        assert.deepStrictEqual(
            phasesAtSend,
            ["sending", "sending"],
            "the second attempt must be listed as waiting for headers, not as streaming"
        );
    });

    test("leaves the registry empty after a failed request", async () => {
        const registry = new ActiveRequestRegistry();
        const provider = new LiteLLMChatProvider(userAgent, registry);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async () => {
            throw new LiteLLMApiError(400, "bad request", "LiteLLM API error: 400 Bad Request\nbad request");
        });

        await runChatRequest(provider, reported);

        assert.deepStrictEqual(registry.list(), [], "a thrown error must not leave a phantom entry");
    });

    test("cancellation during a reasoning-only stream surfaces cancellation, not retry exhaustion", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            networkRetryDelayMs: 1,
            emptyResponseRetries: 2,
            emptyResponseRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const tokenSource = new vscode.CancellationTokenSource();
        // The abort fires while the stream is still open, so decodeSSE ends
        // cleanly and the reasoning-only detector runs on a cancelled request.
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n')
                    );
                },
                pull(controller) {
                    tokenSource.cancel();
                    controller.close();
                },
            });
        });

        await assert.rejects(() => runChatRequest(provider, reported, tokenSource.token), /Operation cancelled/);
        assert.strictEqual(sent.length, 1, "a cancelled request must not be resumed");
    });

    test("cancellation between attempts aborts instead of sending another request", async () => {
        const encoder = new TextEncoder();
        const provider = new LiteLLMChatProvider(userAgent);
        const providerWithConfig = provider as unknown as {
            _configManager: { getConfig: () => Promise<Record<string, unknown>> };
        };
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 3,
            // The backoff sleep must still be pending when cancellation fires,
            // so the delay (200ms) strictly exceeds the cancel timer (50ms).
            networkRetryDelayMs: 200,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        const tokenSource = new vscode.CancellationTokenSource();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        });

        setTimeout(() => tokenSource.cancel(), 50);

        await assert.rejects(
            () => runChatRequest(provider, reported, tokenSource.token),
            /Operation cancelled by user/
        );
        assert.strictEqual(sent.length, 1, "no new request after cancellation during backoff");
    });

    test("provideLanguageModelChatResponse throws on cancellation during request", async () => {
        const provider = new LiteLLMChatProvider(userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("boom"));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const token: vscode.CancellationToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken;

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
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
                        configuration: {
                            baseUrl: "http://localhost:4000",
                            apiKey: "test-api-key",
                        } as unknown as Record<string, unknown>,
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    token
                ),
            /Operation cancelled by user/
        );
    });
});
