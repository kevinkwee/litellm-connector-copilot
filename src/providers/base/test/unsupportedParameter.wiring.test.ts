import * as assert from "assert";
import * as vscode from "vscode";
import { Transport } from "../transport";
import type { TransportDeps } from "../types";
import type { ConfigManager } from "../../../config/configManager";
import type { LiteLLMClient } from "../../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../../types";

/**
 * Captures the client factory backend so the transport's threading of the
 * unsupported-parameter hook into every per-request LiteLLMClient is observable.
 */
let lastClientParams: { onUnsupportedParameter?: (model: string, param: string) => void } | undefined;

class HookSpyClient {
    async chat(
        _request: OpenAIChatCompletionRequest,
        _mode: string | undefined,
        _token?: vscode.CancellationToken
    ): Promise<ReadableStream<Uint8Array>> {
        return new ReadableStream<Uint8Array>({
            start(c) {
                c.close();
            },
        });
    }
}

function makeTransport(deps: TransportDeps): Transport {
    return new Transport(deps);
}

const req: OpenAIChatCompletionRequest = { model: "m", messages: [{ role: "user", content: "x" }], stream: true };

suite("onUnsupportedParameter wiring", () => {
    function call(transport: Transport): Promise<unknown> {
        return transport.sendRequestToLiteLLM(
            req,
            { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
            new vscode.CancellationTokenSource().token,
            undefined,
            { mode: "chat" },
            { baseUrl: "https://x", apiKey: "k" }
        );
    }

    test("threads the hook through the factory-injected LiteLLMClient", async () => {
        lastClientParams = undefined;
        const onUnsupportedParameter = (_model: string, _param: string) => {};
        const transport = makeTransport({
            configManager: { getConfig: async () => ({}) } as unknown as ConfigManager,
            userAgent: "test-ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
            onUnsupportedParameter,
            liteLLMClientFactory: (backend) => {
                lastClientParams = { onUnsupportedParameter: backend.onUnsupportedParameter };
                return new HookSpyClient() as unknown as LiteLLMClient;
            },
        });

        await call(transport);

        assert.strictEqual(lastClientParams!.onUnsupportedParameter, onUnsupportedParameter);
    });
});
