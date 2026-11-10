import * as assert from "assert";
import * as http from "http";
import type { AddressInfo } from "net";
import * as vscode from "vscode";

import { LiteLLMApiError, LiteLLMClient } from "../../adapters/litellmClient";
import { decodeSSE } from "../../adapters/sse/sseDecoder";
import type { LiteLLMClientConfig, OpenAIChatCompletionRequest } from "../../types";
import { failedBeforeReachingProxy, HeadersTimeoutError, isTransportRetriableError } from "../../utils/transportRetry";
import { settleWithin } from "../utils/chatProviderTestUtils";
import { TEST_USER_AGENT } from "../utils/testMocks";

/**
 * The client against the extension host's own `fetch`, talking to a server on the
 * loopback interface.
 *
 * Every other client test stubs `fetch`, so this suite is the only one that sees the
 * error shapes and stream behaviour of the HTTP stack VS Code bundles. The retry loop,
 * the cancellation path, discovery and the spend accounting all read those shapes, so a
 * VS Code release that changes them fails here instead of in a live turn. The runtime's
 * own 300 s header limit is not provoked, because reaching it takes five minutes.
 */

/** Answers one request. `requestNumber` counts from 1 across the server's lifetime. */
type RequestHandler = (response: http.ServerResponse, requestNumber: number) => void;

interface LoopbackServer {
    readonly url: string;
    close(): Promise<void>;
}

const REQUEST: OpenAIChatCompletionRequest = {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
};

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const FIRST_FRAME = JSON.stringify({ choices: [{ delta: { content: "Hel" } }] });
const SECOND_FRAME = JSON.stringify({ choices: [{ delta: { content: "lo" } }] });
const UNFINISHED_JSON = '{"error":';

/** How long the body stays silent before the test aborts it, so the abort lands on a pending read. */
const SILENCE_BEFORE_ABORT_MS = 50;
/** A short bound for the header wait and the discovery timer, so a broken runtime fails fast. */
const CLIENT_BOUND_MS = 200;
/**
 * How long a case waits for the runtime to do what it pins before failing with its own
 * message, rather than at mocha's timeout.
 */
const RUNTIME_SETTLE_BOUND_MS = 2_000;

function formatSseEvent(payload: string): string {
    return `data: ${payload}\n\n`;
}

async function startServer(handler: RequestHandler): Promise<LoopbackServer> {
    let requests = 0;
    const server = http.createServer((request, response) => {
        requests += 1;
        request.resume();
        handler(response, requests);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                // Stop accepting first, then drop the connections still held open: a
                // handler that never ends its response would otherwise keep `close`
                // waiting forever.
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** A port nothing listens on: bound once, then released. */
async function findClosedPort(): Promise<number> {
    const server = await startServer(() => undefined);
    const port = Number(new URL(server.url).port);
    await server.close();
    return port;
}

interface CloseWatch {
    /** Resolves once a watched response closes; never resolves if nothing was watched. */
    readonly closed: Promise<void>;
    watch(response: http.ServerResponse): void;
}

/**
 * Creates a wait for the close of the responses a handler watches. `close` also fires
 * when a response finishes, so a handler that uses this never ends its response, and a
 * close on that response can only mean the connection closed.
 */
function createCloseWatch(): CloseWatch {
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
    });
    return { closed, watch: (response) => response.on("close", () => markClosed()) };
}

function createClient(url: string, overrides: Partial<LiteLLMClientConfig> = {}): LiteLLMClient {
    return new LiteLLMClient({ url, key: "test-key", ...overrides }, TEST_USER_AGENT);
}

async function readPayloads(body: ReadableStream<Uint8Array>): Promise<string[]> {
    const payloads: string[] = [];
    for await (const payload of decodeSSE(body)) {
        payloads.push(payload);
    }
    return payloads;
}

async function captureFailure(work: Promise<unknown>): Promise<unknown> {
    try {
        await work;
    } catch (error) {
        return error;
    }
    return assert.fail("the request was expected to fail");
}

/** The `code` on an error's cause, where the runtime reports its own failures. */
function readCauseCode(failure: unknown): unknown {
    const cause = failure instanceof Error ? failure.cause : undefined;
    return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
}

suite("LiteLLMClient against the runtime fetch", () => {
    let server: LoopbackServer | undefined;

    teardown(async () => {
        await server?.close();
        server = undefined;
    });

    test("streams a server-sent event body", async () => {
        server = await startServer((response) => {
            response.writeHead(200, SSE_HEADERS);
            response.write(formatSseEvent(FIRST_FRAME));
            response.write(formatSseEvent(SECOND_FRAME));
            response.end(formatSseEvent("[DONE]"));
        });

        const body = await createClient(server.url).chat(REQUEST);

        assert.deepStrictEqual(await readPayloads(body), [FIRST_FRAME, SECOND_FRAME]);
    });

    test("a refused connection proves nothing was sent and is worth a retry", async () => {
        const port = await findClosedPort();

        const failure = await captureFailure(createClient(`http://127.0.0.1:${port}`).chat(REQUEST));

        assert.deepStrictEqual(
            { unreached: failedBeforeReachingProxy(failure), retriable: isTransportRetriableError(failure) },
            { unreached: true, retriable: true },
            "the spend accounting and the retry loop read this failure from its shape"
        );
    });

    test("a refused connection to a name with several addresses proves nothing was sent", async () => {
        // `localhost` usually resolves to an IPv6 and an IPv4 address, and the runtime then
        // reports the failure of the whole multi-address attempt. The verdict must not
        // depend on which shape the machine produces.
        const port = await findClosedPort();

        const failure = await captureFailure(createClient(`http://localhost:${port}`).chat(REQUEST));

        assert.strictEqual(failedBeforeReachingProxy(failure), true);
    });

    test("a connection dropped before any header counts as reached and is worth a retry", async () => {
        // The same "fetch failed" message as a refused connection, but the request was
        // delivered, so the proxy may have billed it.
        server = await startServer((response) => response.socket?.destroy());

        const failure = await captureFailure(createClient(server.url).chat(REQUEST));

        assert.deepStrictEqual(
            { unreached: failedBeforeReachingProxy(failure), retriable: isTransportRetriableError(failure) },
            { unreached: false, retriable: true }
        );
    });

    test("a header wait the server never answers ends at the connector's own bound", async () => {
        server = await startServer(() => undefined);

        const failure = await captureFailure(
            createClient(server.url, { headersTimeoutMs: CLIENT_BOUND_MS }).chat(REQUEST)
        );

        assert.ok(
            failure instanceof HeadersTimeoutError && failure.source === "connector",
            "the abort must interrupt the runtime while it waits for headers"
        );
    });

    test("a cancel during the header wait rejects with the connector's cancellation message", async () => {
        // The client recognises the runtime's abort by the error's name and replaces the
        // runtime's own text with the message the rest of the connector reads.
        let markArrived: () => void = () => undefined;
        const arrived = new Promise<void>((resolve) => {
            markArrived = resolve;
        });
        server = await startServer(() => markArrived());
        const cancellation = new vscode.CancellationTokenSource();
        const pending = captureFailure(
            createClient(server.url, { headersTimeoutMs: 10_000 }).chat(REQUEST, undefined, cancellation.token)
        );

        try {
            // A request that fails before it reaches the server settles `pending` first,
            // which surfaces its real error instead of a timeout.
            await Promise.race([arrived, pending]);
            cancellation.cancel();
            const failure = await pending;

            assert.ok(failure instanceof Error);
            assert.strictEqual(failure.message, "Operation cancelled by user");
        } finally {
            cancellation.dispose();
        }
    });

    test("a socket that dies mid-stream reached the proxy and is worth a retry", async () => {
        // The cause code is the nearest observable stand-in for the runtime's own header
        // timeout, which the client recognises by the same `cause.code` convention.
        let killSocket: () => void = () => undefined;
        server = await startServer((response) => {
            response.writeHead(200, SSE_HEADERS);
            response.write(formatSseEvent(FIRST_FRAME));
            killSocket = () => response.socket?.destroy();
        });
        const body = await createClient(server.url).chat(REQUEST);

        killSocket();
        const failure = await captureFailure(readPayloads(body));

        assert.deepStrictEqual(
            {
                unreached: failedBeforeReachingProxy(failure),
                retriable: isTransportRetriableError(failure),
                causeCode: readCauseCode(failure),
            },
            { unreached: false, retriable: true, causeCode: "UND_ERR_SOCKET" },
            "an open stream may already be billed, and the retry loop resumes it"
        );
    });

    test("an abort while the body is silent ends the read without an error", async () => {
        // A cancel must settle a pending read as done rather than reject it. The decoder's
        // abort relies on that to end cleanly, and the inactivity watchdog needs the read
        // to settle at all.
        server = await startServer((response) => {
            response.writeHead(200, SSE_HEADERS);
            response.write(formatSseEvent(FIRST_FRAME));
        });
        const body = await createClient(server.url).chat(REQUEST);
        const watchdog = new AbortController();
        const payloads: string[] = [];

        for await (const payload of decodeSSE(body, undefined, watchdog.signal)) {
            payloads.push(payload);
            setTimeout(() => watchdog.abort(), SILENCE_BEFORE_ABORT_MS);
        }

        assert.deepStrictEqual(payloads, [FIRST_FRAME]);
    });

    test("cancelling an open body closes the upstream connection", async () => {
        // Closing the connection is the only way the connector stops upstream generation,
        // and with it the spend: `cancelUpstreamBody` runs on every exit from a stream.
        const openResponse = createCloseWatch();
        server = await startServer((response) => {
            openResponse.watch(response);
            response.writeHead(200, SSE_HEADERS);
            response.write(formatSseEvent(FIRST_FRAME));
        });
        const body = await createClient(server.url).chat(REQUEST);

        // Production callers ignore a rejected cancel, so only the closed connection counts.
        await body.cancel().catch(() => undefined);

        await settleWithin(
            openResponse.closed,
            RUNTIME_SETTLE_BOUND_MS,
            "the upstream connection stayed open after its body was cancelled"
        );
    });

    test("a rejected request whose body stalls reports its status and the text received so far", async () => {
        // The error body is read within the header bound, and a stalled read is stopped by
        // cancelling it, which must settle the pending read rather than fail it.
        server = await startServer((response) => {
            response.writeHead(400, JSON_HEADERS);
            response.write(UNFINISHED_JSON);
        });

        const failure = await captureFailure(
            createClient(server.url, { headersTimeoutMs: CLIENT_BOUND_MS }).chat(REQUEST)
        );

        assert.ok(failure instanceof LiteLLMApiError);
        assert.deepStrictEqual(
            { status: failure.status, body: failure.bodyText },
            { status: 400, body: UNFINISHED_JSON }
        );
    });

    test("a server error's unfinished body is cancelled, which closes its connection", async () => {
        // The cancel-before-retry order is pinned by `cancels the 5xx body before retrying`
        // in the stubbed client suite; this case pins that the runtime closes the
        // connection when the client cancels the body.
        const failedResponse = createCloseWatch();
        server = await startServer((response, requestNumber) => {
            if (requestNumber === 1) {
                failedResponse.watch(response);
                response.writeHead(503, JSON_HEADERS);
                response.write(UNFINISHED_JSON);
                return;
            }
            response.writeHead(200, SSE_HEADERS);
            response.end(formatSseEvent(FIRST_FRAME));
        });

        await createClient(server.url).chat(REQUEST);

        await settleWithin(
            failedResponse.closed,
            RUNTIME_SETTLE_BOUND_MS,
            "the failed response kept its connection open"
        );
    });

    test("a discovery body that stalls after its headers ends at the discovery bound", async () => {
        // The discovery timer aborts the request signal, which must also stop a body read
        // that has already started, or a stalled proxy would hold the model picker open.
        server = await startServer((response) => {
            response.writeHead(200, JSON_HEADERS);
            response.write('{"data": [');
        });

        const discovery = createClient(server.url, { discoveryTimeoutMs: CLIENT_BOUND_MS }).getModelInfo();

        const failure = await captureFailure(
            settleWithin(
                discovery.then(() => undefined),
                RUNTIME_SETTLE_BOUND_MS,
                "discovery kept reading a stalled body past its own bound"
            )
        );

        assert.ok(failure instanceof Error);
        assert.strictEqual(failure.name, "DiscoveryTimeoutError", failure.message);
    });
});
