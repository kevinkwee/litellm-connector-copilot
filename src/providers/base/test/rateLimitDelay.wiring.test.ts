import * as assert from "assert";
import * as vscode from "vscode";
import { Transport } from "../transport";
import type { TransportDeps } from "../types";
import type { ConfigManager } from "../../../config/configManager";
import type { LiteLLMClient } from "../../../adapters/litellmClient";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../../types";

/**
 * Captures the most recent backend params passed to the factory, so the
 * transport's threading of rateLimitMaxDelayMs is observable.
 */
let lastClientParams: { url: string; key?: string; disableCaching?: boolean; rateLimitMaxDelayMs?: number } | undefined;
/** Request id the transport handed to the most recent `chat` call. */
let lastChatRequestId: string | undefined;

class RateLimitSpyClient {
    public readonly rateLimitMaxDelayMs?: number;
    constructor(cfg: { url: string; key?: string; disableCaching?: boolean; rateLimitMaxDelayMs?: number }) {
        this.rateLimitMaxDelayMs = cfg.rateLimitMaxDelayMs;
    }
    async chat(
        _request: OpenAIChatCompletionRequest,
        _mode: string | undefined,
        _token?: vscode.CancellationToken,
        _modelInfo?: LiteLLMModelInfo,
        requestId?: string
    ): Promise<ReadableStream<Uint8Array>> {
        lastChatRequestId = requestId;
        return new ReadableStream<Uint8Array>({
            start(c) {
                c.close();
            },
        });
    }
}

function makeTransport(): Transport {
    lastClientParams = undefined;
    lastChatRequestId = undefined;
    const deps: TransportDeps = {
        configManager: { getConfig: async () => ({}) } as unknown as ConfigManager,
        userAgent: "test-ua",
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        liteLLMClientFactory: (backend) => {
            lastClientParams = {
                url: backend.url,
                key: backend.key,
                disableCaching: backend.disableCaching,
                rateLimitMaxDelayMs: backend.rateLimitMaxDelayMs,
            };
            return new RateLimitSpyClient(backend) as unknown as LiteLLMClient;
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

suite("rateLimitMaxDelayMs wiring", () => {
    test("threads a configured rateLimitMaxDelayMs into the LiteLLMClient", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k", rateLimitMaxDelayMs: 45000 });
        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams!.rateLimitMaxDelayMs, 45000);
    });

    test("leaves the client default when the configuration omits rateLimitMaxDelayMs", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k" });
        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams!.rateLimitMaxDelayMs, undefined);
    });

    test("ignores non-numeric rateLimitMaxDelayMs in the configuration", async () => {
        await sendWithConfiguration({ baseUrl: "https://x", apiKey: "k", rateLimitMaxDelayMs: "slow" });
        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams!.rateLimitMaxDelayMs, undefined);
    });

    test("hands the request id to the client so its retry logs match the provider's", async () => {
        const transport = makeTransport();

        await transport.sendRequestWithRetry({
            request: req,
            messages: [],
            model: { maxOutputTokens: 100 } as vscode.LanguageModelChatInformation,
            options: {} as vscode.ProvideLanguageModelChatResponseOptions,
            progress: { report: () => {} },
            token: new vscode.CancellationTokenSource().token,
            caller: "chat",
            modelInfo: { mode: "chat" },
            configuration: { baseUrl: "https://x", apiKey: "k" },
            requestId: "req-42",
        });

        assert.strictEqual(lastChatRequestId, "req-42");
    });
});
