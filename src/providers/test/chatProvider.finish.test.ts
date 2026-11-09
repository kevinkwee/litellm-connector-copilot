import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../types";
import { StructuredLogger } from "../../observability/structuredLogger";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { findErrorTextPart, runChatRequest, seedDiscoveredBackend } from "../../test/utils/chatProviderTestUtils";

suite("LiteLLM Chat Provider Finish", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /** A provider that keeps retrying, so a resent turn shows up as a second chat call. */
    function createProvider(): LiteLLMChatProvider {
        const provider = new LiteLLMChatProvider(userAgent);
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
        return provider;
    }

    test("a chat tool turn whose socket dies after its finish completes without a notice", async () => {
        // A chat `tool_calls` finish proves the model ended its turn, so the turn is not
        // resent, retried or replaced by an error notice.
        const encoder = new TextEncoder();
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const provider = createProvider();
        const reported: vscode.LanguageModelResponsePart[] = [];
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}]}}]}\n\n'
                        )
                    );
                    controller.enqueue(
                        encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
                    );
                },
                pull(controller) {
                    controller.error(new TypeError("terminated"));
                },
            });
        });

        await runChatRequest(provider, reported);

        const toolCalls = reported.filter(
            (p): p is vscode.LanguageModelToolCallPart =>
                p instanceof vscode.LanguageModelToolCallPart ||
                typeof (p as unknown as Record<string, unknown>)?.name === "string"
        );
        assert.deepStrictEqual(
            {
                attempts: sent.length,
                calls: toolCalls.length,
                notice: findErrorTextPart(reported),
                errors: errorStub.getCalls().map((call) => call.args[0]),
            },
            { attempts: 1, calls: 1, notice: undefined, errors: [] },
            "a turn that declared its end is neither resent nor reported as failed"
        );
    });
});
