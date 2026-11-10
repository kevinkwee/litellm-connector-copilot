import * as assert from "assert";
import * as vscode from "vscode";
import { Transport } from "../transport";
import type { TransportDeps } from "../types";
import type { ConfigManager } from "../../../config/configManager";
import type { LiteLLMClient } from "../../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../../types";

/** Captures the backend params the transport hands to the client factory. */
let lastClientParams: { url: string; key?: string; headersTimeoutMs?: number } | undefined;

class HeadersSpyClient {
    async chat(): Promise<ReadableStream<Uint8Array>> {
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
    }
}

function makeTransport(): Transport {
    lastClientParams = undefined;
    const deps: TransportDeps = {
        configManager: { getConfig: async () => ({}) } as unknown as ConfigManager,
        userAgent: "test-ua",
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        liteLLMClientFactory: (backend) => {
            lastClientParams = { url: backend.url, key: backend.key, headersTimeoutMs: backend.headersTimeoutMs };
            return new HeadersSpyClient() as unknown as LiteLLMClient;
        },
    };
    return new Transport(deps);
}

const req: OpenAIChatCompletionRequest = { model: "m", messages: [{ role: "user", content: "x" }], stream: true };

async function sendWithConfiguration(configuration: Record<string, unknown>): Promise<void> {
    const transport = makeTransport();
    await transport.sendRequestToLiteLLM(
        req,
        { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
        new vscode.CancellationTokenSource().token,
        "chat",
        { mode: "chat" },
        configuration
    );
}

suite("headersTimeoutMs wiring", () => {
    test("threads a configured headersTimeoutMs into the LiteLLMClient", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k", headersTimeoutMs: 45_000 });

        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams.headersTimeoutMs, 45_000);
    });

    test("leaves the client default when the configuration omits headersTimeoutMs", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k" });

        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams.headersTimeoutMs, undefined);
    });

    test("ignores a headersTimeoutMs of zero", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k", headersTimeoutMs: 0 });

        assert.strictEqual(lastClientParams?.headersTimeoutMs, undefined);
    });

    test("ignores a non-finite headersTimeoutMs", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k", headersTimeoutMs: Number.POSITIVE_INFINITY });

        assert.strictEqual(lastClientParams?.headersTimeoutMs, undefined);
    });

    test("ignores a headersTimeoutMs that is not a number", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k", headersTimeoutMs: "120" });

        assert.strictEqual(lastClientParams?.headersTimeoutMs, undefined);
    });
});
