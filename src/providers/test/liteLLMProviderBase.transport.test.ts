import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { Transport } from "../base/transport";
import { ConfigManager } from "../../config/configManager";

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
