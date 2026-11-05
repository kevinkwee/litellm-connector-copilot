import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient } from "../../adapters/litellmClient";
import { StructuredLogger } from "../../observability/structuredLogger";
import { Logger } from "../../utils/logger";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { findErrorTextPart, seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";

interface TurnResult {
    attempts: number;
    reported: vscode.LanguageModelResponsePart[];
    /** The rate-limit ledger each HTTP call received, in call order. */
    ledgers: unknown[];
}

suite("LiteLLM Chat Provider retry budget accounting", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    function textDelta(text: string): string {
        return `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`;
    }

    function reasoningDelta(text: string): string {
        return `data: {"choices":[{"delta":{"reasoning_content":"${text}"}}]}\n\n`;
    }

    /** A stream that emits the given frames and then dies. */
    function dyingStream(events: string[], failure: Error): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const event of events) {
                    controller.enqueue(encoder.encode(event));
                }
            },
            pull(controller) {
                controller.error(failure);
            },
        });
    }

    /** A stream that emits the given frames and ends cleanly. */
    function endingStream(events: string[]): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const event of events) {
                    controller.enqueue(encoder.encode(event));
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
    }

    /**
     * Runs one chat request against a client stub that answers with the given
     * replies in order. The clock advances by a fixed step per attempt, so the
     * five-millisecond budget is spent deterministically rather than by elapsed
     * wall-clock time.
     */
    async function runTurn(
        replies: (() => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>)[],
        config: Record<string, unknown> = {}
    ): Promise<TurnResult> {
        const provider = new LiteLLMChatProvider(TEST_USER_AGENT);
        interface ProviderWithConfigManager {
            _configManager: { getConfig: () => Promise<{ url: string } & Record<string, unknown>> };
        }
        sandbox.stub((provider as unknown as ProviderWithConfigManager)._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            networkRetries: 5,
            networkRetryDelayMs: 1,
            retryBudgetMs: 5,
            emptyResponseRetries: 3,
            emptyResponseRetryDelayMs: 1,
            inactivityTimeout: 60,
            ...config,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        let now = 1_000;
        sandbox.stub(Date, "now").callsFake(() => now);
        const ledgers: unknown[] = [];
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        replies.forEach((reply, index) => {
            chatStub.onCall(index).callsFake(async (...args: unknown[]) => {
                ledgers.push(args[4]);
                now += 10;
                return reply();
            });
        });

        const reported: vscode.LanguageModelResponsePart[] = [];
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
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        return { attempts: chatStub.callCount, reported, ledgers };
    }

    test("an attempt that streamed new text restarts the retry clock", async () => {
        // Both failing attempts deliver text, and the second failure happens ten
        // milliseconds after the clock started, well past the five-millisecond
        // budget. Without the restart the turn would end there.
        const { attempts, reported } = await runTurn([
            () => dyingStream([textDelta("one")], new TypeError("terminated")),
            () => dyingStream([textDelta(" two")], new TypeError("terminated")),
            () => endingStream([textDelta(" done")]),
        ]);

        assert.strictEqual(attempts, 3, "a productive attempt earns another retry");
        assert.strictEqual(findErrorTextPart(reported), undefined, "the turn must complete without a failure notice");
    });

    test("an attempt that streamed nothing after the budget is refused", async () => {
        const { attempts, reported } = await runTurn([
            () => dyingStream([textDelta("one")], new TypeError("terminated")),
            () => dyingStream([], new TypeError("terminated")),
        ]);

        assert.strictEqual(attempts, 2, "the second failure spends the budget, because nothing new was produced");
        assert.match(findErrorTextPart(reported) ?? "", /litellm-connector\.retryBudgetSeconds/);
    });

    test("a reasoning-only resend that adds reasoning restarts the retry clock", async () => {
        const { attempts, reported } = await runTurn([
            () => endingStream([reasoningDelta("first thought")]),
            () => endingStream([reasoningDelta(" and more")]),
            () => endingStream([textDelta("answer")]),
        ]);

        assert.strictEqual(attempts, 3, "each resume that thinks further earns the next one");
        assert.strictEqual(findErrorTextPart(reported), undefined);
    });

    test("a reasoning-only resend that adds nothing is refused by the budget", async () => {
        const { attempts, reported } = await runTurn([
            () => endingStream([reasoningDelta("first thought")]),
            () => endingStream(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']),
        ]);

        assert.strictEqual(attempts, 2, "the second attempt adds nothing, so the spent budget stands");
        assert.match(findErrorTextPart(reported) ?? "", /litellm-connector\.retryBudgetSeconds/);
    });

    test("the include_usage resend reuses the attempt's rate-limit ledger", async () => {
        const { attempts, ledgers } = await runTurn([
            () =>
                Promise.reject(
                    new LiteLLMApiError(
                        400,
                        "Unsupported parameter: stream_options.include_usage",
                        "LiteLLM API error: 400 Bad Request\nUnsupported parameter: stream_options.include_usage"
                    )
                ),
            () => endingStream([textDelta("answer")]),
        ]);

        assert.strictEqual(attempts, 2, "the resend is a second HTTP call");
        assert.ok(ledgers[0], "the client must receive a ledger");
        assert.strictEqual(ledgers[1], ledgers[0], "a resend of the same body must not get a fresh budget");
    });

    test("a length cut with no output keeps the truncation wording", async () => {
        // A length finish ended the attempt before the model could answer, so the
        // reply is cut short rather than empty, and the notice must say so.
        const { reported } = await runTurn(
            [() => endingStream(['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'])],
            { emptyResponseRetries: 0 }
        );

        const notice = findErrorTextPart(reported) ?? "";
        assert.match(notice, /truncating generation mid-reasoning/);
        assert.doesNotMatch(notice, /empty reply/);
    });

    test("a final stop after earlier reasoning keeps the truncation wording", async () => {
        // The user already saw reasoning from the first attempt, so a second attempt
        // that stops with nothing new was cut short, not empty.
        const { attempts, reported } = await runTurn(
            [
                () => endingStream([reasoningDelta("first thought")]),
                () => endingStream(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']),
            ],
            // A budget that cannot expire here, so the resend count is what ends the turn.
            { emptyResponseRetries: 1, retryBudgetMs: 60_000 }
        );

        assert.strictEqual(attempts, 2, "the empty stop must be the attempt the notice describes");
        const notice = findErrorTextPart(reported) ?? "";
        assert.match(notice, /truncating generation mid-reasoning/);
        assert.doesNotMatch(notice, /empty reply/);
    });

    test("a resumed attempt starts with its own rate-limit ledger", async () => {
        const { attempts, ledgers } = await runTurn([
            () => dyingStream([textDelta("one")], new TypeError("terminated")),
            () => endingStream([textDelta(" two")]),
        ]);

        assert.strictEqual(attempts, 2);
        assert.ok(ledgers[0], "the client must receive a ledger");
        assert.notStrictEqual(ledgers[1], ledgers[0], "a new attempt is a new budget");
    });

    test("an exhausted reasoning-only turn logs one error", async () => {
        const erroredEvents: unknown[] = [];
        sandbox.stub(StructuredLogger, "error").callsFake((...args: unknown[]) => {
            erroredEvents.push(args[0]);
        });
        sandbox.stub(StructuredLogger, "warn").callsFake(() => undefined);
        sandbox.stub(StructuredLogger, "info").callsFake(() => undefined);
        sandbox.stub(StructuredLogger, "debug").callsFake(() => undefined);
        const erroredLines: unknown[] = [];
        sandbox.stub(Logger, "error").callsFake((...args: unknown[]) => {
            erroredLines.push(args[0]);
        });

        await runTurn([() => endingStream([reasoningDelta("first thought")])], { emptyResponseRetries: 0 });

        assert.deepStrictEqual(erroredEvents, ["request.failed"], "the boundary is the one place that logs a failure");
        assert.strictEqual(erroredLines.length, 1, "the output channel gets one error line for the same failure");
    });
});
