import * as assert from "assert";
import * as sinon from "sinon";

import { LiteLLMClient, LiteLLMRateLimitError } from "../litellmClient";

/** A 429 that asks for the given wait, in milliseconds. */
function rateLimited(retryAfterMs: number): Response {
    return new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": String(retryAfterMs / 1_000) },
    });
}

/** A 403 that refuses the cache directive, so the client strips it and resends. */
function cacheDirectiveRejected(): Response {
    return new Response("Not allowed to set no-cache as a cache control", {
        status: 403,
        statusText: "Forbidden",
    });
}

function streamResponse(): Response {
    return new Response(new ReadableStream(), { status: 200, statusText: "OK" });
}

suite("LiteLLM Client rate-limit budget", () => {
    const config = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("the strip-and-retry spends the same budget as the call it replaces", async () => {
        // 60 ms of the 100 ms budget is already spent when the resend meets the same
        // 429, so this call gives up instead of waiting another full allowance.
        const client = new LiteLLMClient({ ...config, disableCaching: true, rateLimitMaxDelayMs: 100 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(rateLimited(60));
        fetchStub.onCall(1).resolves(cacheDirectiveRejected());
        fetchStub.onCall(2).resolves(rateLimited(60));

        const error = await client.chat({ model: "m", messages: [] }).then(
            () => assert.fail("the resend must not receive a second budget"),
            (err: unknown) => err
        );

        assert.ok(error instanceof LiteLLMRateLimitError, "the turn ends on the shared budget");
        assert.strictEqual(error.failure.waitedMs, 60, "only the first wait was taken");
        assert.strictEqual(fetchStub.callCount, 3);
    });

    test("a new request starts with a fresh budget", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 100 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(rateLimited(60));
        fetchStub.onCall(1).resolves(streamResponse());
        fetchStub.onCall(2).resolves(rateLimited(60));
        fetchStub.onCall(3).resolves(streamResponse());

        await client.chat({ model: "m", messages: [] });
        await client.chat({ model: "m", messages: [] });

        assert.strictEqual(fetchStub.callCount, 4, "each request waits once and succeeds");
    });
});
