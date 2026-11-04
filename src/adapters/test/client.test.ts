import * as assert from "assert";
import {
    findRejectedParameter,
    isUnsupportedParameterError,
    LiteLLMApiError,
    LiteLLMClient,
    LiteLLMDiscoveryError,
    LiteLLMRateLimitError,
} from "../litellmClient";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { StructuredLogger } from "../../observability/structuredLogger";
import type { LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../../types";
import { Logger } from "../../utils/logger";
import type { RateLimitFailure } from "../../utils/rateLimitRetryPolicy";
import { HeadersTimeoutError } from "../../utils/transportRetry";

function createRateLimitResponse(retryAfter?: string): Response {
    return new Response("Rate limit exceeded", {
        status: 429,
        statusText: "Too Many Requests",
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
}

function createStreamResponse(): Response {
    return new Response(new ReadableStream(), { status: 200, statusText: "OK" });
}

/** Runs a chat request expected to fail and returns the rate-limit facts it gave up with. */
async function captureRateLimitFailure(client: LiteLLMClient): Promise<RateLimitFailure> {
    try {
        await client.chat({ model: "m", messages: [] });
    } catch (err) {
        if (err instanceof LiteLLMRateLimitError) {
            return err.failure;
        }
        throw err;
    }
    throw new Error("chat resolved, but a LiteLLMRateLimitError was expected");
}

suite("LiteLLM Client Unit Tests", () => {
    const config = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("getHeaders includes Authorization and X-API-Key", () => {
        const client = new LiteLLMClient(config, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headers = client.getHeaders();
        assert.strictEqual(headers["Authorization"], "Bearer test-key");
        assert.strictEqual(headers["X-API-Key"], "test-key");
        assert.strictEqual(headers["User-Agent"], userAgent);
    });

    test("getHeaders never sets a Cache-Control header", () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headers = client.getHeaders();
        assert.strictEqual(headers["Cache-Control"], undefined, "the fork reads the body directive, not this header");
    });

    test("chat sends a top-level cache directive when caching is disabled", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "gpt-4", messages: [] });

        const args0 = fetchStub.getCall(0).args;
        const requestInit = args0[1] as RequestInit | undefined;
        const bodyStr = requestInit?.body as string | undefined;
        const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};
        assert.deepStrictEqual(body.cache, { "no-cache": true });
        assert.strictEqual(body.extra_body, undefined);
        const headers = (requestInit?.headers as Record<string, string>) ?? {};
        assert.strictEqual(headers["Cache-Control"], undefined, "the fork reads the body directive, not the header");
    });

    test("chat sends the cache directive for Claude models too", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "claude-3-opus", messages: [] });

        const args0 = fetchStub.getCall(0).args;
        const requestInit = args0[1] as RequestInit | undefined;
        const bodyStr = requestInit?.body as string | undefined;
        const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};
        assert.deepStrictEqual(body.cache, { "no-cache": true }, "the proxy cache is not provider specific");
    });

    test("chat omits the cache directive when caching is enabled", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "gpt-4", messages: [] });

        const requestInit = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const bodyStr = requestInit?.body as string | undefined;
        const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(body.cache, undefined);
    });

    test("a /responses request carries the cache directive too", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }, "responses");

        const url = fetchStub.getCall(0).args[0];
        assert.strictEqual(url, "http://localhost:4000/responses");
        const requestInit = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
        assert.deepStrictEqual(body.cache, { "no-cache": true }, "the proxy cache is not endpoint specific");
    });

    test("posts to the normalized base even when the configured URL has an endpoint path", async () => {
        const client = new LiteLLMClient({ url: "https://p/v1/chat/completions/", key: "k" }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "gpt-4", messages: [] });

        assert.strictEqual(fetchStub.getCall(0).args[0], "https://p/v1/chat/completions");
    });

    test("cancels the 5xx body before retrying", async () => {
        const client = new LiteLLMClient(config, userAgent);
        let cancelled = false;
        const failingBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("boom"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(new Response(failingBody, { status: 503, statusText: "Service Unavailable" }));
        fetchStub.onCall(1).resolves(createStreamResponse());

        await client.chat({ model: "gpt-4", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2, "a 5xx is retried");
        assert.strictEqual(cancelled, true, "the retried response must not keep its body open");
    });

    test("cancels the 429 body before waiting", async () => {
        const client = new LiteLLMClient(config, userAgent);
        let cancelled = false;
        const rateLimitBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("slow down"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(
            new Response(rateLimitBody, {
                status: 429,
                statusText: "Too Many Requests",
                headers: { "retry-after": "0.01" },
            })
        );
        fetchStub.onCall(1).resolves(createStreamResponse());

        await client.chat({ model: "gpt-4", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2, "a 429 is retried within the budget");
        assert.strictEqual(cancelled, true, "the waited-on response must not keep its body open");
    });

    test("getEndpoint resolves correctly", () => {
        const client = new LiteLLMClient(config, userAgent);
        // @ts-expect-error - accessing private method for testing
        assert.strictEqual(client.getEndpoint("chat"), "/chat/completions");
        // @ts-expect-error - accessing private method for testing
        assert.strictEqual(client.getEndpoint("responses"), "/responses");
        // @ts-expect-error - accessing private method for testing
        assert.strictEqual(client.getEndpoint(undefined), "/chat/completions");
    });

    test("chat retries once when the proxy refuses the cache directive", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);

        const errorResponse = {
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: async () => "Not allowed to set no-cache as a cache control",
            clone: function () {
                return this;
            },
        };

        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({ model: "gpt-4", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2, "a refused directive is retried once");

        const firstCallInit = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const firstCallBody = JSON.parse(String(firstCallInit?.body)) as Record<string, unknown>;
        assert.deepStrictEqual(firstCallBody.cache, { "no-cache": true });

        const secondCallInit = fetchStub.getCall(1).args[1] as RequestInit | undefined;
        const secondCallBody = JSON.parse(String(secondCallInit?.body)) as Record<string, unknown>;
        assert.strictEqual(secondCallBody.cache, undefined, "the retry omits the refused directive");
    });

    test("chat surfaces a rejected model parameter instead of stripping and resending it", async () => {
        const client = new LiteLLMClient(config, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Unsupported parameter: 'temperature'",
            clone: function () {
                return this;
            },
        };

        const fetchStub = sandbox.stub(global, "fetch").resolves(errorResponse as unknown as Response);

        await assert.rejects(
            client.chat({ model: "o1-mini", messages: [], temperature: 1 }),
            (err: unknown) => err instanceof LiteLLMApiError && err.status === 400
        );

        assert.strictEqual(fetchStub.callCount, 1, "a model parameter is never stripped and retried");
        const init = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.strictEqual(body.temperature, 1);
    });

    test("findRejectedParameter names the parameter a 400 body rejects", () => {
        assert.strictEqual(findRejectedParameter("Unsupported parameter: 'temperature'"), "temperature");
        assert.strictEqual(findRejectedParameter('unknown parameter "top_p"'), "top_p");
        assert.strictEqual(findRejectedParameter("unexpected keyword argument 'stop'"), "stop");
        assert.strictEqual(findRejectedParameter("extraneous key [cache_control] is not permitted"), "cache_control");
        assert.strictEqual(
            findRejectedParameter('{"error":{"message":"Unsupported parameter: temperature","param":"temperature"}}'),
            "temperature"
        );
        assert.strictEqual(
            findRejectedParameter("anthropic does not support parameters: ['reasoning_effort']"),
            "reasoning_effort"
        );
        assert.strictEqual(
            findRejectedParameter("unknown parameter: {'reasoning_effort': 'high'}"),
            "reasoning_effort"
        );
        // A JSON body quotes every key, so nothing may be named from a quote alone.
        assert.strictEqual(findRejectedParameter('{"error":{"message":"bad request"}}'), undefined);
        assert.strictEqual(findRejectedParameter("Unsupported parameter for this model"), undefined);
    });

    test("isUnsupportedParameterError only matches parameter-rejection bodies", () => {
        assert.strictEqual(isUnsupportedParameterError("Unsupported parameter: temperature"), true);
        assert.strictEqual(isUnsupportedParameterError("Extra inputs are not permitted"), true);
        assert.strictEqual(isUnsupportedParameterError("extraneous key [cache_control] is not permitted"), true);
        assert.strictEqual(isUnsupportedParameterError("Maximum context length exceeded"), false);
    });

    test("chat strips the cache directive on a 400 that names it as an unknown parameter", async () => {
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, disableCaching: true, onUnsupportedParameter }, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Unknown parameter: cache",
            clone: function () {
                return this;
            },
        };

        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({ model: "gpt-4", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2, "a rejected directive is retried once");

        const retryCallInit = fetchStub.getCall(1).args[1] as RequestInit | undefined;
        const retryCallBody = JSON.parse(String(retryCallInit?.body)) as Record<string, unknown>;
        assert.strictEqual(retryCallBody.cache, undefined);

        sinon.assert.calledWith(onUnsupportedParameter, "gpt-4", "cache");
    });

    test("chat strips a rejected cache_control marker and records the incompatibility", async () => {
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, onUnsupportedParameter }, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Extra inputs are not permitted: cache_control",
            clone: function () {
                return this;
            },
        };
        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({
            model: "anthropic/claude-opus",
            messages: [],
            cache_control: { type: "ephemeral" },
        });

        assert.strictEqual(fetchStub.callCount, 2, "Should have retried once");
        assert.ok(onUnsupportedParameter.calledOnceWithExactly("anthropic/claude-opus", "cache_control"));

        const retryCallInit = fetchStub.getCall(1).args[1] as RequestInit | undefined;
        const retryCallBodyStr = retryCallInit?.body as string | undefined;
        const retryCallBody = retryCallBodyStr ? (JSON.parse(retryCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(retryCallBody.cache_control, undefined);
    });

    test("chat strips cache_control when the error names it after a colon", async () => {
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, onUnsupportedParameter }, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Unsupported parameter: 'cache_control'",
            clone: function () {
                return this;
            },
        };
        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({
            model: "anthropic/claude-opus",
            messages: [],
            cache_control: { type: "ephemeral", ttl: "1h" },
        });

        assert.strictEqual(fetchStub.callCount, 2);
        assert.ok(onUnsupportedParameter.calledOnceWithExactly("anthropic/claude-opus", "cache_control"));

        const retryCallBodyStr = (fetchStub.getCall(1).args[1] as RequestInit | undefined)?.body as string | undefined;
        const retryCallBody = retryCallBodyStr ? (JSON.parse(retryCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(retryCallBody.cache_control, undefined);
    });

    test("chat leaves cache_control untouched when the 400 mentions no parameter", async () => {
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, onUnsupportedParameter }, userAgent);

        const rejected = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "daily spend limit exceeded",
            clone: function () {
                return this;
            },
        };
        sandbox.stub(global, "fetch").resolves(rejected as unknown as Response);

        await assert.rejects(
            async () =>
                client.chat({
                    model: "anthropic/claude-opus",
                    messages: [],
                    cache_control: { type: "ephemeral" },
                }),
            /daily spend limit exceeded/
        );

        assert.ok(onUnsupportedParameter.notCalled);
    });

    test("parseRetryAfterDelayMs handles seconds, future date, and invalid values", () => {
        const client = new LiteLLMClient(config, userAgent);

        const mkResp = (value: string | null): Response =>
            ({
                headers: {
                    get: (k: string) => (k.toLowerCase() === "retry-after" ? value : null),
                },
            }) as unknown as Response;

        // @ts-expect-error - accessing private method for testing
        const parse = client.parseRetryAfterDelayMs.bind(client) as (r: Response) => number | undefined;

        assert.strictEqual(parse(mkResp("2")), 2000);

        const future = new Date(Date.now() + 5_000).toUTCString();
        const delta = parse(mkResp(future));
        assert.ok(typeof delta === "number" && delta > 0 && delta <= 5_000);

        assert.strictEqual(parse(mkResp("not-a-date")), undefined);
        assert.strictEqual(parse(mkResp(null)), undefined);
    });

    test("getModelInfo returns JSON when response is ok", async () => {
        const client = new LiteLLMClient(config, userAgent);

        const jsonStub = sandbox.stub().resolves({ data: [] });
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            status: 200,
            statusText: "OK",
            json: jsonStub,
        } as unknown as Response);

        const res = await client.getModelInfo();
        assert.deepStrictEqual(res, { data: [] });
        assert.strictEqual(fetchStub.calledOnce, true);
        assert.strictEqual(jsonStub.calledOnce, true);
    });

    test("getModelInfo retries with normalized URL when first endpoint returns 404", async () => {
        const client = new LiteLLMClient({ url: "http://localhost:4000/v1", key: "test-key" }, userAgent);

        const jsonStub = sandbox.stub().resolves({ data: [] });
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves({
            ok: false,
            status: 404,
            statusText: "Not Found",
        } as unknown as Response);
        fetchStub.onCall(1).resolves({
            ok: true,
            status: 200,
            statusText: "OK",
            json: jsonStub,
        } as unknown as Response);

        const res = await client.getModelInfo();
        assert.deepStrictEqual(res, { data: [] });
        assert.strictEqual(fetchStub.callCount, 2);
        assert.strictEqual(fetchStub.getCall(0).args[0], "http://localhost:4000/v1/model/info");
        assert.strictEqual(fetchStub.getCall(1).args[0], "http://localhost:4000/model/info");
    });

    test("getModelInfo cancels the 404 body before trying the next URL", async () => {
        const client = new LiteLLMClient({ url: "http://localhost:4000/v1", key: "test-key" }, userAgent);
        const cancel = sandbox.stub().resolves();
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves({
            ok: false,
            status: 404,
            statusText: "Not Found",
            body: { cancel },
        } as unknown as Response);
        fetchStub.onCall(1).resolves({
            ok: true,
            status: 200,
            statusText: "OK",
            json: sandbox.stub().resolves({ data: [] }),
        } as unknown as Response);

        await client.getModelInfo();

        sinon.assert.calledOnce(cancel);
    });

    test("getModelInfo cancels the failing body before throwing", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const cancel = sandbox.stub().resolves();

        sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            body: { cancel },
        } as unknown as Response);

        await assert.rejects(() => client.getModelInfo(), LiteLLMDiscoveryError);

        sinon.assert.calledOnce(cancel);
    });

    test("chat cancels the rejected body before the strip-and-retry", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const cancel = sandbox.stub().resolves();
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            body: { cancel },
            text: async () => "Not allowed to set no-cache as a cache control",
            clone() {
                return this;
            },
        } as unknown as Response);
        fetchStub.onCall(1).resolves(createStreamResponse());

        await client.chat({ model: "gpt-4", messages: [] });

        sinon.assert.calledOnce(cancel);
    });

    test("getModelInfo throws with status details when response is not ok", async () => {
        const client = new LiteLLMClient(config, userAgent);

        sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        } as unknown as Response);

        await assert.rejects(
            () => client.getModelInfo(),
            (err: unknown) =>
                err instanceof LiteLLMDiscoveryError &&
                err.status === 500 &&
                err.message.includes("Failed to fetch model info") &&
                err.message.includes("Internal Server Error")
        );
    });

    test("getModelInfo reports the last 404 when every fallback URL fails", async () => {
        const client = new LiteLLMClient({ url: "http://localhost:4000/v1", key: "test-key" }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 404,
            statusText: "Not Found",
        } as unknown as Response);

        await assert.rejects(
            () => client.getModelInfo(),
            (err: unknown) =>
                err instanceof LiteLLMDiscoveryError &&
                err.status === 404 &&
                err.message.includes("Failed to fetch model info")
        );
        assert.ok(fetchStub.callCount > 1, "every candidate URL is tried before giving up");
    });

    test("chat does not resend a body when the rejection names nothing strippable", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Unsupported parameter: prompt_cache_key",
            clone: function () {
                return this;
            },
        } as unknown as Response);

        await assert.rejects(
            () => client.chat({ model: "gpt-4", messages: [] }),
            (err: unknown) => err instanceof LiteLLMApiError && err.status === 400
        );
        assert.strictEqual(fetchStub.callCount, 1, "an unchanged body would be rejected identically");
    });

    test("chat does not resend a body that has no cache_control marker to strip", async () => {
        const onUnsupportedParameter = sandbox.stub();
        const client = new LiteLLMClient({ ...config, onUnsupportedParameter }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Extra inputs are not permitted: cache_control",
            clone: function () {
                return this;
            },
        } as unknown as Response);

        await assert.rejects(
            () => client.chat({ model: "gpt-4", messages: [] }),
            (err: unknown) => err instanceof LiteLLMApiError
        );
        assert.strictEqual(fetchStub.callCount, 1, "there was nothing to remove");
        assert.strictEqual(onUnsupportedParameter.called, false, "no incompatibility was proven");
    });

    test("getModelInfo aborts fetch when cancellation token fires", async () => {
        const client = new LiteLLMClient(config, userAgent);

        let abortSignal: AbortSignal | undefined;
        sandbox.stub(global, "fetch").callsFake(async (_input: string | URL | Request, init?: RequestInit) => {
            abortSignal = init?.signal as AbortSignal | undefined;
            // Never resolve; we expect the abort signal to flip.
            await new Promise((_resolve) => {
                // Keep promise pending
            });
            return {} as Response;
        });

        let onCancel: (() => void) | undefined;
        const token = {
            onCancellationRequested: (cb: () => void) => {
                onCancel = cb;
                return {
                    dispose() {
                        // No-op for mock
                    },
                };
            },
        } as unknown as { onCancellationRequested: (cb: () => void) => { dispose(): void } };

        void client.getModelInfo(token as never);

        // Wait a tick for fetch to be invoked and signal captured.
        await Promise.resolve();
        assert.ok(abortSignal, "Expected fetch to be called with an AbortSignal");
        assert.strictEqual(abortSignal?.aborted, false);

        onCancel?.();
        assert.strictEqual(abortSignal?.aborted, true);
    });

    test("getModelInfo rejects with the discovery timeout when the body stalls after the headers", async () => {
        const client = new LiteLLMClient({ ...config, discoveryTimeoutMs: 10 }, userAgent);
        sandbox.stub(global, "fetch").callsFake(async (_input: string | URL | Request, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal | undefined;
            const body = new ReadableStream({
                start(controller) {
                    // Abort reaches the body only through the signal, exactly as a
                    // real fetch streams it, so the read stays pending until it fires.
                    signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
                },
            });
            return new Response(body, { status: 200, statusText: "OK" });
        });

        await assert.rejects(() => client.getModelInfo(), /discovery timeout after 10ms/);
    });

    test("getModelInfo disposes its cancellation registration when the request settles", async () => {
        const dispose = sinon.spy();
        const token = {
            onCancellationRequested: () => ({ dispose }),
        } as unknown as vscode.CancellationToken;
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        fetchStub.resolves(new Response(JSON.stringify({ data: [] }), { status: 200, statusText: "OK" }));
        await client.getModelInfo(token);

        assert.strictEqual(dispose.callCount, 1);

        fetchStub.resolves(new Response("boom", { status: 500, statusText: "Internal Server Error" }));
        await assert.rejects(() => client.getModelInfo(token));

        assert.strictEqual(dispose.callCount, 2);
    });

    test("fetchWithRetry retries on 429 with backoff", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const rateLimitResponse = {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            clone: function () {
                return this;
            },
            text: async () => "Rate limit exceeded",
            headers: {
                get: (name: string) => {
                    if (name.toLowerCase() === "retry-after") {
                        return "0.5";
                    }
                    return null;
                },
            },
        } as Response;

        const successResponse = new Response(new ReadableStream(), {
            status: 200,
            statusText: "OK",
        });

        fetchStub.onCall(0).resolves(rateLimitResponse);
        fetchStub.onCall(1).resolves(successResponse);

        await client.chat({ model: "m", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2);
    });

    test("does not retry a connection failure inside the client", async () => {
        // The provider owns network retries: only it knows whether the failed
        // attempt produced output, so only it can decide resend versus resume.
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").rejects(new TypeError("fetch failed"));

        await assert.rejects(() => client.chat({ model: "m", messages: [] }), /fetch failed/);

        assert.strictEqual(fetchStub.callCount, 1, "one wire call, and the provider decides whether to retry");
    });

    test("retries a 5xx response twice and then surfaces it", async () => {
        // The client is the only layer that retries a 5xx.
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.callsFake(async () => new Response("boom", { status: 503, statusText: "Service Unavailable" }));

        await assert.rejects(() => client.chat({ model: "m", messages: [] }), LiteLLMApiError);

        assert.strictEqual(fetchStub.callCount, 3, "one attempt plus two 5xx retries");
    });

    test("aborts the attempt and reports a headers timeout when the proxy never answers", async () => {
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 5 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").callsFake(
            (_input: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                })
        );

        await assert.rejects(() => client.chat({ model: "m", messages: [] }), HeadersTimeoutError);

        assert.strictEqual(fetchStub.callCount, 1, "the headers timeout is the client's last word");
    });

    test("keeps a user cancellation distinct from a headers timeout", async () => {
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 5_000 }, userAgent);
        sandbox.stub(global, "fetch").callsFake(
            (_input: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                })
        );
        const emitter = new vscode.EventEmitter<void>();
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: emitter.event,
        } as vscode.CancellationToken;

        const request = client.chat({ model: "m", messages: [] }, undefined, token);
        emitter.fire();

        await assert.rejects(() => request, /Operation cancelled by user/);
    });

    test("does not abort a response whose headers already arrived", async () => {
        // The timer is armed on the controller that also governs the body, so a
        // timer left running would abort a healthy stream once the header bound
        // passed. The 120 s default hides that, which is why this test sets 5 ms.
        const client = new LiteLLMClient({ ...config, headersTimeoutMs: 5 }, userAgent);
        let capturedSignal: AbortSignal | undefined;
        sandbox.stub(global, "fetch").callsFake((_input: string | URL | Request, init?: RequestInit) => {
            capturedSignal = init?.signal ?? undefined;
            return Promise.resolve(new Response(new ReadableStream(), { status: 200, statusText: "OK" }));
        });

        await client.chat({ model: "m", messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.ok(capturedSignal, "the request must carry a signal");
        assert.strictEqual(capturedSignal.aborted, false, "the header timer must not outlive the headers");
    });

    test("rateLimitMaxDelayMs=0 disables 429 retries inside fetchWithRateLimit", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 0 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const rateLimitResponse = {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            clone: function () {
                return this;
            },
            text: async () => "Rate limit exceeded",
            headers: {
                get: (name: string) => {
                    if (name.toLowerCase() === "retry-after") {
                        return "0.5";
                    }
                    return null;
                },
            },
        } as Response;

        fetchStub.resolves(rateLimitResponse);

        await assert.rejects(() => client.chat({ model: "m", messages: [] }));

        assert.strictEqual(fetchStub.callCount, 1);
    });

    test("reports rate-limit retries as disabled when the budget is 0", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 0 }, userAgent);
        sandbox.stub(global, "fetch").callsFake(async () => createRateLimitResponse("1"));

        const failure = await captureRateLimitFailure(client);

        assert.deepStrictEqual(failure, {
            reason: "retries_disabled",
            waitedMs: 0,
            budgetMs: 0,
            retryAfterMs: 1_000,
        });
    });

    test("gives up without waiting when Retry-After is longer than the budget", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").callsFake(async () => createRateLimitResponse("300"));

        const failure = await captureRateLimitFailure(client);

        assert.deepStrictEqual(
            { failure, fetchCount: fetchStub.callCount },
            {
                failure: {
                    reason: "retry_after_exceeds_budget",
                    waitedMs: 0,
                    budgetMs: 120_000,
                    retryAfterMs: 300_000,
                },
                fetchCount: 1,
            }
        );
    });

    test("gives up without waiting when a Retry-After date is beyond the budget", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const tenMinutesAhead = new Date(Date.now() + 600_000).toUTCString();
        sandbox.stub(global, "fetch").callsFake(async () => createRateLimitResponse(tenMinutesAhead));

        const failure = await captureRateLimitFailure(client);

        assert.strictEqual(failure.reason, "retry_after_exceeds_budget");
    });

    test("keeps the proxy's 429 body and status on the rate-limit error", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(global, "fetch").callsFake(async () => createRateLimitResponse("300"));

        await assert.rejects(
            () => client.chat({ model: "m", messages: [] }),
            (err: unknown) =>
                err instanceof LiteLLMRateLimitError &&
                err.status === 429 &&
                err.bodyText === "Rate limit exceeded" &&
                err.message === "LiteLLM API error: 429 Too Many Requests\nRate limit exceeded"
        );
    });

    test("gives up once backoff waits spend the budget", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 20 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").callsFake(async () => createRateLimitResponse());

        const failure = await captureRateLimitFailure(client);

        assert.deepStrictEqual(
            { failure, fetchCount: fetchStub.callCount },
            {
                failure: { reason: "budget_exhausted", waitedMs: 20, budgetMs: 20, retryAfterMs: undefined },
                fetchCount: 2,
            }
        );
    });

    test("backs off instead of retrying at once on Retry-After 0", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 10 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).callsFake(async () => createRateLimitResponse("0"));
        fetchStub.onCall(1).callsFake(async () => createStreamResponse());
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        await client.chat({ model: "m", messages: [] });

        sinon.assert.calledWith(warnStub, "request.rate_limit_retry", sinon.match({ source: "backoff", delayMs: 10 }));
    });

    test("counts a sub-millisecond Retry-After as a 1ms wait", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).callsFake(async () => createRateLimitResponse("0.0001"));
        fetchStub.onCall(1).callsFake(async () => createStreamResponse());
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        await client.chat({ model: "m", messages: [] });

        sinon.assert.calledWith(
            warnStub,
            "request.rate_limit_retry",
            sinon.match({ source: "retry_after", delayMs: 1 })
        );
    });

    test("backs off on a Retry-After that is not a finite number", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 10 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).callsFake(async () => createRateLimitResponse("Infinity"));
        fetchStub.onCall(1).callsFake(async () => createStreamResponse());
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        await client.chat({ model: "m", messages: [] });

        sinon.assert.calledWith(warnStub, "request.rate_limit_retry", sinon.match({ source: "backoff", delayMs: 10 }));
    });

    test("backs off on a Retry-After too large to express in milliseconds", async () => {
        const client = new LiteLLMClient({ ...config, rateLimitMaxDelayMs: 10 }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).callsFake(async () => createRateLimitResponse("1e306"));
        fetchStub.onCall(1).callsFake(async () => createStreamResponse());
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        await client.chat({ model: "m", messages: [] });

        sinon.assert.calledWith(warnStub, "request.rate_limit_retry", sinon.match({ source: "backoff", delayMs: 10 }));
    });

    test("stops waiting out a 429 when the request is cancelled", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const cancellation = new vscode.CancellationTokenSource();
        const fetchStub = sandbox.stub(global, "fetch").callsFake(async () => {
            setTimeout(() => cancellation.cancel(), 5);
            return createRateLimitResponse("30");
        });

        await assert.rejects(
            () => client.chat({ model: "m", messages: [] }, "chat", cancellation.token),
            /Operation cancelled by user/
        );
        assert.strictEqual(fetchStub.callCount, 1);
    });

    test("logs a structured event for each 429 wait, tagged with the request id", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).callsFake(async () => createRateLimitResponse("0.01"));
        fetchStub.onCall(1).callsFake(async () => createStreamResponse());
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        await client.chat({ model: "m", messages: [] }, "chat", undefined, "req-123");

        sinon.assert.calledWithExactly(
            warnStub,
            "request.rate_limit_retry",
            { requestId: "req-123", attempt: 1, delayMs: 10, waitedMs: 0, budgetMs: 120_000, source: "retry_after" },
            { requestId: "req-123", model: "m", endpoint: "/chat/completions" }
        );
    });

    test("writes a readable warning for each 429 wait, tagged with the request id", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).callsFake(async () => createRateLimitResponse("0.01"));
        fetchStub.onCall(1).callsFake(async () => createStreamResponse());
        const warnStub = sandbox.stub(Logger, "warn");

        await client.chat({ model: "m", messages: [] }, "chat", undefined, "req-123");

        sinon.assert.calledWith(
            warnStub,
            "[rateLimitRetry] request=req-123 429 on /chat/completions, retry 1 in 10ms (retry_after), waited 0ms of 120000ms"
        );
    });

    test("fetchWithRetry retries on 5xx", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const serverErrorResponse = new Response("Service Unavailable", {
            status: 503,
            statusText: "Service Unavailable",
        });

        const successResponse = new Response(new ReadableStream(), { status: 200, statusText: "OK" });

        fetchStub.onCall(0).resolves(serverErrorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({ model: "m", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2);
    });

    test("fetchWithRetry does not retry on non-429 4xx", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const badRequestResponse = new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });

        fetchStub.resolves(badRequestResponse as unknown as Response);

        await assert.rejects(() => client.chat({ model: "m", messages: [] }));
        assert.strictEqual(fetchStub.callCount, 1);
    });

    test("checkConnection handles empty or invalid data", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(client, "getModelInfo").resolves({
            data: [] as { model_name?: string; model_info?: LiteLLMModelInfo }[],
        } as unknown as LiteLLMModelInfoResponse);

        const res = await client.checkConnection();
        assert.strictEqual(res.modelCount, 0);
        assert.deepStrictEqual(res.sampleModelIds, []);
    });

    test("checkConnection extracts model IDs correctly", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(client, "getModelInfo").resolves({
            data: [{ model_name: "m1", model_info: { key: "k1" } }, { model_name: "m2" }, {}],
        } as unknown as LiteLLMModelInfoResponse);

        const res = await client.checkConnection();
        assert.strictEqual(res.modelCount, 3);
        assert.deepStrictEqual(res.sampleModelIds, ["k1", "m2", "unknown"]);
    });

    test("chat handles missing response body", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(global, "fetch").resolves({
            ok: true,
            status: 200,
            body: null,
        } as Response);

        await assert.rejects(() => client.chat({ model: "m", messages: [] }), /No response body/);
    });
});
