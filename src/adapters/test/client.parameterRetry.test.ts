import * as assert from "assert";
import * as sinon from "sinon";

import { LiteLLMClient } from "../litellmClient";

/**
 * Builds a failing response shaped the way the client reads one: `text()` for the
 * message, and `clone()` for the retry decision.
 */
function rejectionResponse(status: number, bodyText: string): Response {
    return {
        ok: false,
        status,
        statusText: status === 403 ? "Forbidden" : "Bad Request",
        text: async () => bodyText,
        clone: function (this: unknown) {
            return this;
        },
    } as unknown as Response;
}

suite("LiteLLM Client connector parameter retry", () => {
    const config = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("chat keeps cache_control when a 400 only echoes the marker in the prompt", async () => {
        // Anthropic's error envelope plus an echoed prompt: a realistic body that
        // never reads as a refusal of the marker.
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, onUnsupportedParameter }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub
            .onCall(0)
            .resolves(
                rejectionResponse(
                    400,
                    '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"},"echo":{"prompt":"what does cache_control do?"}}'
                )
            );

        await assert.rejects(async () =>
            client.chat({ model: "anthropic/claude-opus", messages: [], cache_control: { type: "ephemeral" } })
        );

        assert.strictEqual(fetchStub.callCount, 1, "an echoed marker must not cost a second request");
        sinon.assert.notCalled(onUnsupportedParameter);
    });

    test("chat keeps the cache directive when a rejection names only the marker", async () => {
        // A marker rejection must leave the bypass directive alone, because
        // `cache_control` is not the directive's name.
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, disableCaching: true, onUnsupportedParameter }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(rejectionResponse(400, "Extra inputs are not permitted: cache_control"));
        fetchStub.onCall(1).resolves({ ok: true, status: 200, body: new ReadableStream() } as unknown as Response);

        await client.chat({ model: "anthropic/claude-opus", messages: [], cache_control: { type: "ephemeral" } });

        const retryBody = JSON.parse(String((fetchStub.getCall(1).args[1] as RequestInit | undefined)?.body)) as Record<
            string,
            unknown
        >;
        assert.deepStrictEqual(retryBody.cache, { "no-cache": true }, "the accepted directive is kept");
    });

    test("chat keeps the cache directive when an unrelated 400 echoes its name", async () => {
        // The gate covers the bypass family too: a body whose echoed prompt asks why
        // its no-cache header is ignored must not strip the directive or learn it as
        // unsupported.
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, disableCaching: true, onUnsupportedParameter }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub
            .onCall(0)
            .resolves(
                rejectionResponse(
                    400,
                    '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"},"echo":{"prompt":"why is my no-cache header ignored?"}}'
                )
            );

        await assert.rejects(async () => client.chat({ model: "gpt-4", messages: [] }));

        assert.strictEqual(fetchStub.callCount, 1, "a body that refuses no input must not cost a second request");
        sinon.assert.notCalled(onUnsupportedParameter);
    });

    test("chat leaves cache_control alone when the refusal names another parameter", async () => {
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, onUnsupportedParameter }, userAgent);
        sandbox.stub(global, "fetch").resolves(rejectionResponse(400, "Unsupported parameter: 'temperature'"));

        await assert.rejects(async () =>
            client.chat({ model: "anthropic/claude-opus", messages: [], cache_control: { type: "ephemeral" } })
        );

        sinon.assert.notCalled(onUnsupportedParameter);
    });
});
