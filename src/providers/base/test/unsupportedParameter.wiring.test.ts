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
            { baseUrl: "https://x", apiKey: "k" },
            "req-1",
            "host.example/wire-model-name"
        );
    }

    test("threads the hook through the factory-injected LiteLLMClient under the learned-limits key", async () => {
        lastClientParams = undefined;
        const recorded: { model: string; param: string }[] = [];
        const onUnsupportedParameter = (model: string, param: string) => {
            recorded.push({ model, param });
        };
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

        const hook = lastClientParams!.onUnsupportedParameter;
        assert.ok(hook, "the transport must pass a hook to the client");
        hook("wire-model-name", "cache_control");
        assert.deepStrictEqual(
            recorded,
            [{ model: "host.example/wire-model-name", param: "cache_control" }],
            "the hook records under the namespaced picker id, not the wire name"
        );
    });
});
