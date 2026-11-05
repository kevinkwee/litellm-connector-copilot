import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { findErrorTextPart, seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";
import { HeadersTimeoutError } from "../../utils/transportRetry";

suite("LiteLLM Chat Provider headers timeout retries", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Runs one chat request whose transport fails with the given errors in order,
     * and counts the attempts the client was asked to make.
     */
    async function runFailingRequest(failures: Error[]): Promise<{
        attempts: number;
        reported: vscode.LanguageModelResponsePart[];
    }> {
        const provider = new LiteLLMChatProvider(TEST_USER_AGENT);
        interface ProviderWithConfigManager {
            _configManager: { getConfig: () => Promise<{ url: string } & Record<string, unknown>> };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            // Five network retries are allowed, so two attempts prove the headers limit ended the turn.
            networkRetries: 5,
            networkRetryDelayMs: 1,
            inactivityTimeout: 60,
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        failures.forEach((failure, index) => {
            chatStub.onCall(index).rejects(failure);
        });
        chatStub.rejects(failures[failures.length - 1]);

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

        return { attempts: chatStub.callCount, reported };
    }

    test("retries a headers timeout once and stops on the second", async () => {
        // Without the limit, five transport retries would mean six attempts, each
        // waiting the full headers timeout for the same guaranteed failure.
        const { attempts, reported } = await runFailingRequest([
            new HeadersTimeoutError(50),
            new HeadersTimeoutError(50),
        ]);

        assert.strictEqual(attempts, 2, "one attempt plus one headers-timeout retry");
        const notice = findErrorTextPart(reported) ?? "";
        assert.ok(notice.includes("is no longer retried"), "the notice must say the request stopped retrying headers");
        assert.match(notice, /The last attempt waited 50ms \(litellm-connector\.headersTimeout\)/);
        assert.doesNotMatch(
            notice,
            /HTTP runtime's own header limit/,
            "the connector's timer fired, not the runtime's"
        );
    });

    test("a runtime header timeout does not blame the setting", async () => {
        const { reported } = await runFailingRequest([
            new HeadersTimeoutError(300_000, "runtime"),
            new HeadersTimeoutError(300_000, "runtime"),
        ]);

        const notice = findErrorTextPart(reported) ?? "";
        assert.match(notice, /HTTP runtime's own header limit/);
        assert.doesNotMatch(notice, /The last attempt waited/, "the setting's wait must not be reported");
    });

    test("a different transport failure between two headers timeouts does not reset the limit", async () => {
        const { attempts } = await runFailingRequest([
            new HeadersTimeoutError(50),
            new TypeError("terminated"),
            new HeadersTimeoutError(50),
        ]);

        assert.strictEqual(attempts, 3, "only the first headers timeout earns a retry");
    });
});
