import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { Transport } from "../base/transport";
import { ConfigManager } from "../../config/configManager";
import { LiteLLMApiError } from "../../adapters/litellmClient";
import { RateLimitWaitLedger } from "../../utils/rateLimitRetryPolicy";

suite("Transport", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;

    setup(() => {
        sandbox = sinon.createSandbox();
        configManager = sandbox.createStubInstance(ConfigManager);
    });

    teardown(() => sandbox.restore());

    test("sendRequestToLiteLLM throws when no baseUrl in call-time configuration", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const factoryCalls: { url: string; key?: string }[] = [];
        const factory = (backend: { url: string; key?: string }): sinon.SinonStub => {
            factoryCalls.push(backend);
            return sandbox.stub() as unknown as sinon.SinonStub;
        };
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
            liteLLMClientFactory: factory as never,
        });

        await assert.rejects(
            () =>
                localTransport.sendRequestToLiteLLM(
                    { model: "m", messages: [], stream: true, max_tokens: 100 },
                    progress,
                    token
                ),
            /No baseUrl/
        );
        assert.strictEqual(factoryCalls.length, 0, "factory must not be called when configuration is missing");
    });

    test("sendRequestToLiteLLM throws when apiKey is missing", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        });

        await assert.rejects(
            () =>
                localTransport.sendRequestToLiteLLM(
                    { model: "m", messages: [], stream: true, max_tokens: 100 },
                    progress,
                    token,
                    "test",
                    undefined,
                    { baseUrl: "https://example.com", apiKey: "" }
                ),
            /No apiKey/
        );
    });

    test("the /responses fallback shares the attempt's rate-limit ledger", async () => {
        // The fallback resends the same body, so it must spend what the first call
        // already waited rather than starting a fresh allowance.
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const ledgers: unknown[] = [];
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
            liteLLMClientFactory: (() => ({
                chat: (_request: unknown, mode: string, _token: unknown, _id: unknown, ledger: unknown) => {
                    ledgers.push(ledger);
                    if (mode === "responses") {
                        return Promise.reject(
                            new LiteLLMApiError(
                                502,
                                "upstream schema mismatch",
                                "LiteLLM API error: 502 Bad Gateway\nupstream schema mismatch"
                            )
                        );
                    }
                    return Promise.resolve(new ReadableStream());
                },
            })) as never,
        });
        const ledger = new RateLimitWaitLedger();

        await localTransport.sendRequestToLiteLLM(
            { model: "m", messages: [], stream: true, max_tokens: 100 },
            progress,
            token,
            "test",
            { mode: "responses" } as never,
            { baseUrl: "https://example.com", apiKey: "sk-test", allowChatCompletionsFallback: true },
            "request-1",
            "model-1",
            ledger
        );

        assert.strictEqual(ledgers.length, 2, "the 5xx must trigger one fallback");
        assert.strictEqual(ledgers[0], ledger);
        assert.strictEqual(ledgers[1], ledger, "the fallback must not get a fresh budget");
    });

    test("sendRequestToLiteLLM constructs a client with the call-time configuration", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const factoryCalls: { url: string; key?: string }[] = [];
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
            liteLLMClientFactory: ((backend: { url: string; key?: string }) => {
                factoryCalls.push(backend);
                return { chat: () => new ReadableStream() } as never;
            }) as never,
        });

        const stream = await localTransport.sendRequestToLiteLLM(
            { model: "m", messages: [], stream: true, max_tokens: 100 },
            progress,
            token,
            "test",
            undefined,
            { baseUrl: "https://wolfram.example", apiKey: "sk-test" }
        );
        assert.ok(stream);
        assert.strictEqual(factoryCalls.length, 1);
        assert.strictEqual(factoryCalls[0].url, "https://wolfram.example");
        assert.strictEqual(factoryCalls[0].key, "sk-test");
    });
});
