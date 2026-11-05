import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMApiError, LiteLLMClient } from "../litellmClient";

/**
 * Builds a real response whose body never finishes, so the client has to end the
 * read itself, and records whether the stream's own cancel ran. A fake body would
 * let `cancel()` succeed where a real locked stream refuses, which is exactly the
 * defect this suite has to catch.
 */
function stalledResponse(status: number, statusText: string, partialBody = "") {
    const cancel = sinon.spy();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            if (partialBody) {
                controller.enqueue(new TextEncoder().encode(partialBody));
            }
            // Never closes after that: only a cancel ends the read.
        },
        cancel,
    });
    return { response: new Response(body, { status, statusText }), cancel };
}

suite("LiteLLM Client error body reads", () => {
    const config = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("a stalled error body gives up inside the headers bound, cancels the body, and keeps what it read", async () => {
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 20 }, userAgent);
        const stalled = stalledResponse(400, "Bad Request", "partial evidence");
        sandbox.stub(global, "fetch").resolves(stalled.response);
        const startedAt = Date.now();

        const error = await client.chat({ model: "m", messages: [] }).then(
            () => assert.fail("a rejected request must throw"),
            (err: unknown) => err
        );

        assert.ok(error instanceof LiteLLMApiError, "the status must reach the caller");
        assert.strictEqual(error.status, 400);
        assert.ok(Date.now() - startedAt < 1_000, "the read must not outlive its bound");
        sinon.assert.calledOnce(stalled.cancel);
        assert.strictEqual(error.bodyText, "partial evidence", "the text read so far must survive the timeout");
    });

    test("cancelling during the body read stops the read and cancels the body", async () => {
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 10_000 }, userAgent);
        const stalled = stalledResponse(400, "Bad Request");
        sandbox.stub(global, "fetch").resolves(stalled.response);
        const emitter = new vscode.EventEmitter<void>();
        const token = { isCancellationRequested: false, onCancellationRequested: emitter.event };

        const request = client.chat({ model: "m", messages: [] }, undefined, token as vscode.CancellationToken);
        // Let the request reach the body read, so the cancel lands mid-read rather
        // than before the fetch.
        await new Promise((resolve) => setTimeout(resolve, 20));
        emitter.fire();

        await assert.rejects(() => request, /Operation cancelled by user/);
        sinon.assert.calledOnce(stalled.cancel);
    });

    test("a token that is already cancelled sends nothing", async () => {
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 10_000 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves(stalledResponse(400, "Bad Request").response);
        const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) };

        await assert.rejects(
            () => client.chat({ model: "m", messages: [] }, undefined, token as vscode.CancellationToken),
            /Operation cancelled by user/
        );
        sinon.assert.notCalled(fetchStub);
    });

    test("a complete error body still reaches the error message", async () => {
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 20 }, userAgent);
        sandbox
            .stub(global, "fetch")
            .resolves(new Response("schema violation", { status: 422, statusText: "Unprocessable" }));

        await assert.rejects(
            () => client.chat({ model: "m", messages: [] }),
            (err: unknown) => err instanceof LiteLLMApiError && err.message.includes("schema violation")
        );
    });
});
