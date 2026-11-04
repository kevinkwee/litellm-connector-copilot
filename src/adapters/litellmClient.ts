import type * as vscode from "vscode";
import type {
    LiteLLMClientConfig,
    LiteLLMModelInfoResponse,
    OpenAIChatCompletionRequest,
    LiteLLMResponsesRequest,
} from "../types";
import { transformToResponsesFormat } from "./responsesAdapter";
import { StructuredLogger } from "../observability/structuredLogger";
import { Logger } from "../utils/logger";
import { planRateLimitRetry, type RateLimitFailure, type RateLimitWaitSource } from "../utils/rateLimitRetryPolicy";
import { normalizeProxyBaseUrl } from "../utils/proxyBaseUrl";
import { HeadersTimeoutError } from "../utils/transportRetry";

/**
 * Error thrown when a /model/info discovery request times out.
 */
class DiscoveryTimeoutError extends Error {
    public readonly code = "DISCOVERY_TIMEOUT";

    public constructor(timeoutMs: number) {
        super(`discovery timeout after ${timeoutMs}ms`);
        this.name = "DiscoveryTimeoutError";
    }
}

/**
 * Error thrown for a non-2xx proxy response. The message has the
 * `LiteLLM API error: <status> <statusText>\n<body>` shape that the provider's
 * user-facing formatting parses; `status` and `bodyText` stay available for
 * callers that need to explain the rejection.
 */
export class LiteLLMApiError extends Error {
    public constructor(
        public readonly status: number,
        public readonly bodyText: string,
        message: string
    ) {
        super(message);
        this.name = "LiteLLMApiError";
    }
}

/**
 * Error thrown when the client stops retrying a 429. `failure` says why it
 * stopped and how long it waited, so the provider can tell the user which
 * setting bounds the wait.
 */
export class LiteLLMRateLimitError extends LiteLLMApiError {
    public constructor(
        public readonly failure: RateLimitFailure,
        statusText: string,
        bodyText: string
    ) {
        super(429, bodyText, `LiteLLM API error: 429 ${statusText}\n${bodyText}`);
        this.name = "LiteLLMRateLimitError";
    }
}

/** Per-call context for the 429 retry loop. */
interface RateLimitFetchOptions {
    readonly model: string;
    readonly endpoint: string;
    /** Ties the retry logs to the provider's request logs. */
    readonly requestId?: string;
    readonly token?: vscode.CancellationToken;
}

interface RateLimitRetryLogEntry {
    readonly attempt: number;
    readonly delayMs: number;
    readonly waitedMs: number;
    readonly budgetMs: number;
    readonly source: RateLimitWaitSource;
}

const UNSUPPORTED_PARAMETER_PHRASES = [
    "unsupported parameter",
    "unknown parameter",
    "unrecognized request argument",
    "unexpected keyword argument",
    "extra inputs are not permitted",
    "extraneous key",
    "does not support parameter",
];

/** True when a rejection body names a request parameter the model does not accept. */
export function isUnsupportedParameterError(bodyText: string): boolean {
    const lowered = bodyText.toLowerCase();
    return UNSUPPORTED_PARAMETER_PHRASES.some((phrase) => lowered.includes(phrase));
}

/**
 * Names the parameter a rejection body reports as unsupported, when the message
 * puts the name right after the phrase (quoted, in brackets or braces, or after
 * a colon or equals sign). The name is not searched for anywhere else in the
 * body: a JSON body quotes every one of its keys, so a bare quoted-token search
 * would name `error` or `message` instead.
 */
export function findRejectedParameter(bodyText: string): string | undefined {
    const phrase =
        /(?:unsupported|unknown|unrecognized|unexpected|invalid|extraneous|extra|does\s+not\s+support)\s+(?:keyword\s+)?(?:parameter|argument|request argument|inputs?|keys?)s?(?:\s+supplied)?\s*/i;
    const rest = bodyText.match(phrase);
    if (!rest || rest.index === undefined) {
        return undefined;
    }
    const afterPhrase = bodyText.slice(rest.index + rest[0].length);
    // Accepted shapes: `: temperature`, `: ['temperature']`, `: {'temperature': ...}`,
    // `'temperature'`, and Bedrock's `[temperature]`. Anything else (for example
    // "Unsupported parameter for this model") names no parameter, and guessing one
    // would mislead the user.
    const named = afterPhrase.match(
        /^(?:[:=]\s*['"`]?([A-Za-z0-9_.-]+)|[:=]\s*\[\s*['"`]([A-Za-z0-9_.-]+)|[:=]\s*\{\s*['"`]([A-Za-z0-9_.-]+)|['"`]([A-Za-z0-9_.-]+)|\[([A-Za-z0-9_.-]+)\])/
    );
    return named?.[1] ?? named?.[2] ?? named?.[3] ?? named?.[4] ?? named?.[5];
}

/**
 * True when a rejection body says it refused an input, which is what separates a
 * rejection of a connector-added parameter from a body that merely echoes the prompt.
 *
 * `isUnsupportedParameterError` covers the parameter wordings, including Bedrock's
 * "extraneous key [<name>] is not permitted". The cache-bypass directive has a refusal
 * that names no parameter at all: the proxy's cache-control check answers 403 with
 * "Not allowed to set no-cache as a cache control" (`litellm/proxy/hooks/cache_control_check.py`).
 */
function saysItRefusedAnInput(errorText: string): boolean {
    return isUnsupportedParameterError(errorText) || errorText.toLowerCase().includes("not allowed to set");
}

/**
 * Error thrown when a `/model/info` discovery request fails with a non-2xx
 * response. `status` lets the caller tell an unhealthy endpoint (worth
 * retrying, and worth falling back to the last known model list) from a group
 * that is misconfigured (400, 401, 403, or 404), where the stale list would hide
 * the problem.
 */
export class LiteLLMDiscoveryError extends Error {
    public constructor(
        public readonly status: number,
        public readonly statusText: string
    ) {
        super(`Failed to fetch model info: ${status} ${statusText}`);
        this.name = "LiteLLMDiscoveryError";
    }
}

export class LiteLLMClient {
    private static readonly DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
    private static readonly DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 120_000;
    /** Wait for response headers when the setting is absent. */
    private static readonly DEFAULT_HEADERS_TIMEOUT_MS = 120_000;
    /** 5xx retries per call. The client is the only layer that retries a 5xx. */
    private static readonly MAX_SERVER_ERROR_RETRIES = 2;
    private static readonly SERVER_ERROR_RETRY_DELAY_MS = 1_000;

    constructor(
        private readonly config: LiteLLMClientConfig,
        private readonly userAgent: string
    ) {
        // Every endpoint URL is `${config.url}${endpoint}`, so the base is
        // normalized once here rather than at each call site.
        this.config = { ...config, url: normalizeProxyBaseUrl(config.url) };
    }

    /**
     * Fetches model information from the LiteLLM proxy.
     */
    async getModelInfo(token?: vscode.CancellationToken): Promise<LiteLLMModelInfoResponse> {
        const controller = new AbortController();

        const timeoutMs = this.config.discoveryTimeoutMs ?? LiteLLMClient.DEFAULT_DISCOVERY_TIMEOUT_MS;
        const timer = setTimeout(() => controller.abort(new DiscoveryTimeoutError(timeoutMs)), timeoutMs);

        const urls = this.getModelInfoUrls();
        const registration = token?.onCancellationRequested(() => controller.abort());

        Logger.trace(`Fetching model info from ${urls[0]}`);
        try {
            let lastResponse: Response | undefined;
            for (const url of urls) {
                const resp = await fetch(url, {
                    headers: this.getHeaders(),
                    signal: controller.signal,
                });
                if (resp.ok) {
                    // Awaited inside the try so the timeout and the cancellation
                    // signal also cover a body that stalls after the headers.
                    return (await resp.json()) as LiteLLMModelInfoResponse;
                }

                lastResponse = resp;
                if (resp.status === 404) {
                    Logger.warn(`Model info endpoint returned 404, trying fallback URL: ${url}`);
                    this.discardBody(resp);
                    continue;
                }

                Logger.error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
                this.discardBody(resp);
                throw new LiteLLMDiscoveryError(resp.status, resp.statusText);
            }

            const status = lastResponse?.status ?? 404;
            const statusText = lastResponse?.statusText ?? "Not Found";
            Logger.error(`Failed to fetch model info after trying fallback URLs: ${status} ${statusText}`);
            throw new LiteLLMDiscoveryError(status, statusText);
        } catch (err) {
            // Check if the error was caused by our timeout
            if (controller.signal.aborted && controller.signal.reason instanceof DiscoveryTimeoutError) {
                Logger.warn(`Discovery timeout after ${timeoutMs}ms`);
                throw controller.signal.reason;
            }

            throw err;
        } finally {
            clearTimeout(timer);
            registration?.dispose();
        }
    }

    private getModelInfoUrls(): string[] {
        const base = this.config.url;
        const withoutV1 = base.replace(/\/v1$/i, "");
        return [...new Set([base, withoutV1].filter((candidate) => candidate.length > 0))].map(
            (candidate) => `${candidate}/model/info`
        );
    }

    /**
     * Checks the connection to the LiteLLM proxy.
     */
    async checkConnection(
        token?: vscode.CancellationToken
    ): Promise<{ latencyMs: number; modelCount: number; sampleModelIds: string[] }> {
        const startTime = Date.now();
        const { data } = await this.getModelInfo(token);
        const latencyMs = Date.now() - startTime;

        const modelCount = Array.isArray(data) ? data.length : 0;
        const sampleModelIds = Array.isArray(data)
            ? data
                  .slice(0, 5)
                  .map(
                      (entry: { model_info?: { key?: string }; model_name?: string }) =>
                          entry.model_info?.key ?? entry.model_name ?? "unknown"
                  )
            : [];

        return { latencyMs, modelCount, sampleModelIds };
    }

    /**
     * Sends a chat request to the LiteLLM proxy.
     *
     * @throws LiteLLMRateLimitError when the client stops retrying a 429.
     * @throws LiteLLMApiError for any other non-2xx response.
     */
    async chat(
        request: OpenAIChatCompletionRequest,
        mode?: string,
        token?: vscode.CancellationToken,
        requestId?: string
    ): Promise<ReadableStream<Uint8Array>> {
        const endpoint = this.getEndpoint(mode);
        let body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest = request;

        if (endpoint === "/responses") {
            body = transformToResponsesFormat(request);
        }
        // LiteLLM reads the bypass from a top-level `cache` member, and lists
        // `cache` in `all_litellm_params`, so LiteLLM consumes it and never
        // forwards it upstream.
        if (this.config.disableCaching) {
            body = this.withNoCacheDirective(body);
        }

        Logger.trace(`Sending chat request to ${endpoint}`, { model: request.model });
        const url = `${this.config.url}${endpoint}`;
        const rateLimitOptions: RateLimitFetchOptions = { model: request.model, endpoint, requestId, token };
        let response = await this.fetchWithRateLimit(
            url,
            {
                method: "POST",
                headers: this.getHeaders(),
                body: JSON.stringify(body),
            },
            rateLimitOptions
        );

        // Only the parameters this connector adds on its own are ever stripped
        // and retried. A parameter the proxy itself claimed to support is
        // reported instead: hiding it would send the same rejected body on
        // every later request.
        if (response.status === 400 || response.status === 403) {
            const retryBody = this.planConnectorParameterRetry(await response.clone().text(), body, request.model);
            if (retryBody) {
                Logger.warn(`Retrying ${request.model} without a connector-added parameter the proxy rejected`);
                this.discardBody(response);
                response = await this.fetchWithRateLimit(
                    url,
                    {
                        method: "POST",
                        headers: this.getHeaders(),
                        body: JSON.stringify(retryBody),
                    },
                    rateLimitOptions
                );
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            // The body can echo the prompt, so it stays on the error for the
            // user-facing notice; the provider logs identifiers only.
            throw new LiteLLMApiError(
                response.status,
                errorText,
                `LiteLLM API error: ${response.status} ${response.statusText}\n${errorText}`
            );
        }

        if (!response.body) {
            Logger.error("No response body from LiteLLM API");
            throw new Error("No response body from LiteLLM API");
        }

        return response.body as ReadableStream<Uint8Array>;
    }

    /**
     * Builds the retry body for a 400 or 403 that rejects a parameter this
     * connector adds itself. Returns undefined when the body does not read as a
     * refusal, names no such parameter, or does not carry it, in which case the
     * caller must surface the error instead.
     *
     * Two families qualify:
     * - `cache_control`, the Anthropic prompt-caching marker added by the
     *   request builder. It is reported through `onUnsupportedParameter` so
     *   later requests omit it without paying a failed round trip.
     * - the cache-bypass directive added for `litellm-connector.disableCaching`
     *   (`cache["no-cache"]`). A key the proxy does not allow to set it answers
     *   403, so the same strip-and-retry covers both statuses.
     *
     * The refusal requirement applies to both families. The rejection body can echo
     * the prompt, and stripping and learning on a parameter name alone would let an
     * unrelated 400 that quotes `cache_control` or `no-cache` disable prompt caching
     * or the cache bypass for the session.
     *
     * Nothing else in the body is touched: any other parameter is either the
     * user's own configuration or was accepted by the proxy's capability data,
     * and the caller reports the rejection instead of guessing.
     */
    private planConnectorParameterRetry(
        errorText: string,
        body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest,
        modelId: string
    ): OpenAIChatCompletionRequest | LiteLLMResponsesRequest | undefined {
        if (!saysItRefusedAnInput(errorText)) {
            return undefined;
        }
        const errorLower = errorText.toLowerCase();
        const promptCachingRejected = errorLower.includes("cache_control");
        // The directive's own name is the standalone word `cache`, which the proxy's
        // permission refusal reports as `no-cache`. A word boundary does not match
        // across the underscore in `cache_control`, so the marker name alone leaves
        // this family unmatched.
        const cacheBypassRejected = /\bcache\b/.test(errorLower);
        if (!promptCachingRejected && !cacheBypassRejected) {
            return undefined;
        }

        const retryBody = JSON.parse(JSON.stringify(body)) as OpenAIChatCompletionRequest | LiteLLMResponsesRequest;
        const retryBodyRecord = retryBody as unknown as Record<string, unknown>;
        let strippedSomething = false;

        if (promptCachingRejected && "cache_control" in retryBodyRecord) {
            Logger.info(`Stripping ${modelId} prompt-caching marker: cache_control rejected`);
            delete retryBodyRecord.cache_control;
            this.config.onUnsupportedParameter?.(modelId, "cache_control");
            strippedSomething = true;
        }

        if (cacheBypassRejected && retryBody.cache !== undefined) {
            Logger.info(`Stripping ${modelId} cache bypass: the proxy's key may not set no-cache`);
            delete retryBodyRecord.cache;
            this.config.onUnsupportedParameter?.(modelId, "cache");
            strippedSomething = true;
        }

        // A body that did not change would be rejected identically, so do not
        // spend a second request on it.
        return strippedSomething ? retryBody : undefined;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (this.config.key) {
            headers.Authorization = `Bearer ${this.config.key}`;
            headers["X-API-Key"] = this.config.key;
        }
        return headers;
    }

    private getEndpoint(mode?: string): string {
        if (mode === "chat" || mode === "completions") {
            return "/chat/completions";
        }
        if (mode === "responses") {
            return "/responses";
        }
        // Default to chat/completions for backward compatibility
        return "/chat/completions";
    }

    private withNoCacheDirective(
        body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest
    ): OpenAIChatCompletionRequest | LiteLLMResponsesRequest {
        return {
            ...body,
            cache: { ...body.cache, "no-cache": true },
        };
    }

    /**
     * Sends one request and retries only a 5xx response.
     *
     * A connection failure is deliberately NOT retried here: the provider owns
     * network retries, because only it knows whether the failed attempt produced
     * output and therefore whether the request should resume or be resent
     * unchanged. Retrying in both layers would multiply the attempts.
     *
     * The wait for response headers is bounded here, because undici's own
     * header timeout is neither reachable through `fetch` options nor present in
     * the web build, and because the proxy buffers the first streamed chunk
     * before it writes headers, which leaves the body watchdog nothing to watch.
     */
    private async fetchWithRetry(url: string, init: RequestInit, token?: vscode.CancellationToken): Promise<Response> {
        const headersTimeoutMs = this.config.headersTimeoutMs ?? LiteLLMClient.DEFAULT_HEADERS_TIMEOUT_MS;
        let serverErrorAttempt = 0;
        while (true) {
            if (token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const controller = new AbortController();
            const disposable = token?.onCancellationRequested(() => controller.abort());
            let headersTimedOut = false;
            // The timer is armed on the controller whose signal also governs the body,
            // so it must be cleared as soon as the headers arrive or the attempt ends.
            // A timer left running would abort a healthy stream.
            const headersTimer = setTimeout(() => {
                headersTimedOut = true;
                controller.abort();
            }, headersTimeoutMs);

            try {
                const response = await fetch(url, { ...init, signal: controller.signal });
                if (response.ok || response.status < 500 || response.status >= 600) {
                    return response;
                }
                if (serverErrorAttempt >= LiteLLMClient.MAX_SERVER_ERROR_RETRIES) {
                    return response;
                }
                serverErrorAttempt++;
                this.discardBody(response);
            } catch (err: unknown) {
                if (headersTimedOut) {
                    throw new HeadersTimeoutError(headersTimeoutMs);
                }
                if (err instanceof Error && err.name === "AbortError") {
                    throw new Error("Operation cancelled by user", { cause: err });
                }
                throw err;
            } finally {
                clearTimeout(headersTimer);
                disposable?.dispose();
            }

            await this.sleep(LiteLLMClient.SERVER_ERROR_RETRY_DELAY_MS, token);
        }
    }

    /**
     * Fetches with retries on 429 rate limiting, within a total wait budget
     * for this call. A budget of 0 disables the retries.
     * {@link planRateLimitRetry} picks each wait. A 5xx response is retried by
     * {@link fetchWithRetry}; a connection failure is not, because the provider
     * owns network retries.
     *
     * @throws LiteLLMRateLimitError when the client stops retrying a 429.
     */
    private async fetchWithRateLimit(
        url: string,
        init: RequestInit,
        options: RateLimitFetchOptions
    ): Promise<Response> {
        const budgetMs = this.config.rateLimitMaxDelayMs ?? LiteLLMClient.DEFAULT_RATE_LIMIT_MAX_DELAY_MS;
        let waitedMs = 0;
        let attempt = 0;

        while (true) {
            if (options.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const response = await this.fetchWithRetry(url, init, options.token);
            if (response.status !== 429) {
                return response;
            }

            const retryAfterMs = this.parseRetryAfterDelayMs(response);
            const decision = planRateLimitRetry({ attempt, waitedMs, budgetMs, retryAfterMs });
            if (decision.kind === "give_up") {
                throw new LiteLLMRateLimitError(
                    { reason: decision.reason, waitedMs, budgetMs, retryAfterMs },
                    response.statusText,
                    await response.text()
                );
            }

            attempt++;
            this.discardBody(response);
            this.logRateLimitRetry(options, {
                attempt,
                delayMs: decision.delayMs,
                waitedMs,
                budgetMs,
                source: decision.source,
            });
            waitedMs += decision.delayMs;
            await this.sleep(decision.delayMs, options.token);
        }
    }

    private logRateLimitRetry(options: RateLimitFetchOptions, entry: RateLimitRetryLogEntry): void {
        Logger.warn(
            `[rateLimitRetry] request=${options.requestId ?? "no-request"} 429 on ${options.endpoint}, ` +
                `retry ${entry.attempt} in ${entry.delayMs}ms (${entry.source}), ` +
                `waited ${entry.waitedMs}ms of ${entry.budgetMs}ms`
        );
        StructuredLogger.warn(
            "request.rate_limit_retry",
            { requestId: options.requestId, ...entry },
            { requestId: options.requestId, model: options.model, endpoint: options.endpoint }
        );
    }

    private discardBody(response: Response): void {
        // An unread body holds the connection open, so a retried request would
        // keep both responses' sockets alive until the garbage collector runs.
        void response.body?.cancel().catch(() => undefined);
    }

    private sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) {
            return Promise.reject(new Error("Operation cancelled by user"));
        }
        return new Promise((resolve, reject) => {
            const registration = token?.onCancellationRequested(() => {
                clearTimeout(timer);
                registration?.dispose();
                reject(new Error("Operation cancelled by user"));
            });
            const timer = setTimeout(() => {
                registration?.dispose();
                resolve();
            }, ms);
        });
    }

    /**
     * Reads Retry-After as seconds or an HTTP date. Seconds round up to whole
     * milliseconds, because Node timers wait at least 1 ms and cannot sleep a
     * fraction, and the budget must not be charged less than the wait costs.
     */
    private parseRetryAfterDelayMs(response: Response): number | undefined {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
            const delayMs = Math.ceil(Number(retryAfter) * 1000);
            if (Number.isFinite(delayMs) && delayMs >= 0) {
                return delayMs;
            }
            const asDate = Date.parse(retryAfter);
            if (!Number.isNaN(asDate)) {
                const delta = asDate - Date.now();
                if (delta > 0) {
                    return delta;
                }
            }
        }
        return undefined;
    }
}
