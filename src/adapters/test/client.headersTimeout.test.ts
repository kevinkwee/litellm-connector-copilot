import * as assert from "assert";
import * as sinon from "sinon";

import { LiteLLMClient } from "../litellmClient";
import { HeadersTimeoutError, isTransportRetriableError } from "../../utils/transportRetry";

suite("LiteLLM Client runtime header timeout", () => {
    const config = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("maps a runtime header timeout to a retriable HeadersTimeoutError with the runtime source", async () => {
        const client = new LiteLLMClient(config, userAgent);
        // The shape Node's fetch actually rejects with.
        const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
        const failure = new TypeError("fetch failed", { cause });
        sandbox.stub(global, "fetch").rejects(failure);

        const error = await client.chat({ model: "m", messages: [] }).then(
            () => assert.fail("the runtime's header limit must throw"),
            (err: unknown) => err
        );

        assert.ok(error instanceof HeadersTimeoutError, "the runtime limit must read as a header timeout");
        assert.strictEqual(error.source, "runtime");
        assert.match(error.message, /HTTP runtime's own header limit/);
        assert.strictEqual(error.cause, failure, "the runtime error stays reachable for diagnostics");
        assert.ok(isTransportRetriableError(error), "the runtime limit stays retriable");
        assert.match(error.message, /expired after 300s/, "the runtime limit reads in seconds, like every other wait");
    });

    test("a connection failure carrying another code is not read as a header timeout", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(global, "fetch").rejects(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));

        const error = await client.chat({ model: "m", messages: [] }).then(
            () => assert.fail("a refused connection must throw"),
            (err: unknown) => err
        );

        assert.ok(!(error instanceof HeadersTimeoutError), "only the header code means a header timeout");
    });
});
