import * as assert from "assert";
import * as sinon from "sinon";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient } from "../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../types";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { runChatRequest, stubConfigAndDiscovery } from "../../test/utils/chatProviderTestUtils";

suite("LiteLLM Chat Provider usage opt-out", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Stubs the client once per test and records each request it is asked to send.
     * The reply is settable, so a test can run several turns against one stub.
     */
    function harness(): {
        sent: OpenAIChatCompletionRequest[];
        reply: (next: () => Promise<ReadableStream<Uint8Array>>) => void;
    } {
        let current: () => Promise<ReadableStream<Uint8Array>> = async () => cleanStream();
        const sent: OpenAIChatCompletionRequest[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request: OpenAIChatCompletionRequest) => {
            sent.push(request);
            return current();
        });
        return {
            sent,
            reply: (next) => {
                current = next;
            },
        };
    }

    function createProvider(): LiteLLMChatProvider {
        const provider = new LiteLLMChatProvider(TEST_USER_AGENT);
        stubConfigAndDiscovery(sandbox, provider);
        return provider;
    }

    function cleanStream(): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
    }

    test("an echoed flag in a rejection of another parameter keeps usage on the next request", async () => {
        // The body refuses temperature and merely echoes the request, which carries
        // stream_options. Dropping the usage flag on that evidence would leave the
        // session without token or cost figures.
        const provider = createProvider();
        const stub = harness();
        const refusalBody = 'Unsupported parameter: temperature {"stream_options":{"include_usage":true}}';
        const refusal = new LiteLLMApiError(400, refusalBody, `LiteLLM API error: 400 Bad Request\n${refusalBody}`);
        stub.reply(() => Promise.reject(refusal));
        await runChatRequest(provider, []).catch(() => undefined);

        stub.reply(async () => cleanStream());
        await runChatRequest(provider, []);

        assert.deepStrictEqual(stub.sent.at(-1)?.stream_options, { include_usage: true });
    });
});
