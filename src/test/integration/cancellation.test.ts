import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../types";

suite("LiteLLM Client Cancellation Tests", () => {
    const config = { url: "http://localhost:1234", key: "test-key" };
    const client = new LiteLLMClient(config, "test-ua");

    test("chat should be aborted when token is cancelled during fetch", async () => {
        const cts = new vscode.CancellationTokenSource();
        const request: OpenAIChatCompletionRequest = { model: "test", messages: [], stream: true };

        // Mock fetch to delay then check signal
        const originalFetch = global.fetch;
        (global as typeof globalThis).fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    resolve(
                        new Response(
                            new ReadableStream({
                                start(controller) {
                                    controller.close();
                                },
                            })
                        )
                    );
                }, 100);
                if (init?.signal) {
                    init.signal.addEventListener("abort", () => {
                        clearTimeout(timeout);
                        reject(new DOMException("Aborted", "AbortError"));
                    });
                }
            });
        }) as typeof fetch;

        try {
            const chatPromise = client.chat(request, "chat", cts.token);
            cts.cancel();
            await chatPromise;
            assert.fail("Should have thrown cancellation error");
        } catch (err: unknown) {
            if (err instanceof Error) {
                assert.strictEqual(err.message, "Operation cancelled by user");
            } else {
                assert.fail("Error should be an instance of Error");
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    test("fetchWithRetry does not call fetch when the token is already cancelled", async () => {
        const cts = new vscode.CancellationTokenSource();

        // Track calls to ensure early exit
        let callCount = 0;
        const originalFetch = global.fetch;
        (global as typeof globalThis).fetch = (async () => {
            callCount++;
            // Simulate a working fetch
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const clientAny = client as unknown as {
            fetchWithRetry: (url: string, init: RequestInit, token?: vscode.CancellationToken) => Promise<Response>;
        };

        try {
            const response = await clientAny.fetchWithRetry("http://url", {}, cts.token);
            assert.strictEqual(response.status, 200);
            assert.strictEqual(callCount, 1, "Should succeed immediately");

            callCount = 0;
            cts.cancel();
            const retryPromise = clientAny.fetchWithRetry("http://url", {}, cts.token);

            try {
                await retryPromise;
                assert.fail("Should have thrown cancellation error");
            } catch (err: unknown) {
                if (!(err instanceof Error)) {
                    assert.fail("Error should be an instance of Error");
                }
                assert.strictEqual(err.message, "Operation cancelled by user");
                assert.strictEqual(callCount, 0, "Should not call fetch when token is already cancelled");
            }
        } finally {
            global.fetch = originalFetch;
        }
    });
});
