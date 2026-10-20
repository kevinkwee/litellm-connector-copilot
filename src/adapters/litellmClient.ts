import type * as vscode from "vscode";
import type {
    LiteLLMClientConfig,
    LiteLLMModelInfoResponse,
    OpenAIChatCompletionRequest,
    LiteLLMResponsesRequest,
    LiteLLMModelInfo,
    LiteLLMTokenCounterRequest,
    LiteLLMTokenCounterResponse,
} from "../types";
import { transformToResponsesFormat } from "./responsesAdapter";
import { Logger } from "../utils/logger";
import { isAnthropicModel } from "../utils/modelUtils";
import { LiteLLMTelemetry } from "../utils/telemetry";

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

const UNSUPPORTED_PARAMETER_PHRASES = [
    "unsupported parameter",
    "unknown parameter",
    "unrecognized request argument",
    "unexpected keyword argument",
    "extra inputs are not permitted",
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
        /(?:unsupported|unknown|unrecognized|unexpected|invalid|extra|does\s+not\s+support)\s+(?:keyword\s+)?(?:parameter|argument|request argument|inputs?|keys?)s?(?:\s+supplied)?\s*/i;
    const rest = bodyText.match(phrase);
    if (!rest || rest.index === undefined) {
        return undefined;
    }
    const afterPhrase = bodyText.slice(rest.index + rest[0].length);
    // Accepted shapes: `: temperature`, `: ['temperature']`, `: {'temperature': ...}`,
    // `'temperature'`. Anything else (for example "Unsupported parameter for this
    // model") names no parameter, and guessing one would mislead the user.
    const named = afterPhrase.match(
        /^(?:[:=]\s*['"`]?([A-Za-z0-9_.-]+)|[:=]\s*\[\s*['"`]([A-Za-z0-9_.-]+)|[:=]\s*\{\s*['"`]([A-Za-z0-9_.-]+)|['"`]([A-Za-z0-9_.-]+))/
    );
    return named?.[1] ?? named?.[2] ?? named?.[3] ?? named?.[4];
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

    constructor(
        private readonly config: LiteLLMClientConfig,
        private readonly userAgent: string
    ) {}

    /**
     * Fetches model information from the LiteLLM proxy.
     */
    async getModelInfo(token?: vscode.CancellationToken): Promise<LiteLLMModelInfoResponse> {
        const controller = new AbortController();

        const timeoutMs = this.config.discoveryTimeoutMs ?? LiteLLMClient.DEFAULT_DISCOVERY_TIMEOUT_MS;
        const timer = setTimeout(() => controller.abort(new DiscoveryTimeoutError(timeoutMs)), timeoutMs);

        if (token) {
            token.onCancellationRequested(() => controller.abort());
        }

        const urls = this.getModelInfoUrls();
        Logger.trace(`Fetching model info from ${urls[0]}`);
        try {
            let lastResponse: Response | undefined;
            for (const url of urls) {
                const resp = await fetch(url, {
                    headers: this.getHeaders(),
                    signal: controller.signal,
                });
                if (resp.ok) {
                    return resp.json() as Promise<LiteLLMModelInfoResponse>;
                }

                lastResponse = resp;
                if (resp.status === 404) {
                    Logger.warn(`Model info endpoint returned 404, trying fallback URL: ${url}`);
                    continue;
                }

                Logger.error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
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
        }
    }

    private getModelInfoUrls(): string[] {
        const trimmed = this.config.url.replace(/\/+$/, "");
        const stripTerminalEndpoint = (url: string): string =>
            url.replace(/\/(?:chat\/completions|completions|responses|model\/info)$/i, "");
        const stripV1 = (url: string): string => url.replace(/\/v1$/i, "");

        const baseCandidates = new Set<string>([
            trimmed,
            stripTerminalEndpoint(trimmed),
            stripV1(trimmed),
            stripV1(stripTerminalEndpoint(trimmed)),
            stripTerminalEndpoint(stripV1(trimmed)),
        ]);

        const urls: string[] = [];
        for (const base of baseCandidates) {
            if (!base) {
                continue;
            }
            urls.push(`${base}/model/info`);
        }
        return urls;
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
     * Counts tokens for a prompt or messages using LiteLLM's token counter.
     */
    async countTokens(
        request: LiteLLMTokenCounterRequest,
        token?: vscode.CancellationToken
    ): Promise<LiteLLMTokenCounterResponse> {
        const controller = new AbortController();
        if (token) {
            token.onCancellationRequested(() => controller.abort());
        }

        Logger.trace(`Counting tokens for model ${request.model} at ${this.config.url}/utils/token_counter`);
        const resp = await fetch(`${this.config.url}/utils/token_counter`, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(request),
            signal: controller.signal,
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            Logger.error(`Failed to count tokens: ${resp.status} ${resp.statusText} - ${errorText}`);
            throw new Error(`Failed to count tokens: ${resp.status} ${resp.statusText}`);
        }

        return resp.json() as Promise<LiteLLMTokenCounterResponse>;
    }

    /**
     * Sends a chat request to the LiteLLM proxy.
     */
    async chat(
        request: OpenAIChatCompletionRequest,
        mode?: string,
        token?: vscode.CancellationToken,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const endpoint = this.getEndpoint(mode);
        let body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest = request;

        const isAnthropic = isAnthropicModel(request.model, modelInfo);

        if (this.config.disableCaching) {
            if (isAnthropic) {
                Logger.info(`Bypassing 'disable caching' for Anthropic/Claude model: ${request.model}`);
                LiteLLMTelemetry.reportMetric({
                    requestId: `bypass-${Math.random().toString(36).substring(7)}`,
                    model: request.model,
                    status: "caching_bypassed",
                });
            } else {
                body = this.withNoCacheExtraBody(body);
            }
        }

        if (endpoint === "/responses") {
            body = transformToResponsesFormat(request);
            if (this.config.disableCaching && !isAnthropic) {
                body = this.withNoCacheExtraBody(body);
            }
        }

        Logger.trace(`Sending chat request to ${endpoint}`, { model: request.model });
        const url = `${this.config.url}${endpoint}`;
        let response = await this.fetchWithRateLimit(
            url,
            {
                method: "POST",
                headers: this.getHeaders(request.model, modelInfo),
                body: JSON.stringify(body),
            },
            { token }
        );

        // Only the parameters this connector adds on its own are ever stripped
        // and retried. A parameter the proxy itself claimed to support is
        // reported instead: hiding it would send the same rejected body on
        // every later request.
        if (response.status === 400) {
            const retry = this.planConnectorParameterRetry(
                await response.clone().text(),
                body,
                request.model,
                modelInfo
            );
            if (retry) {
                Logger.warn(`Retrying ${request.model} without a connector-added parameter the proxy rejected`);
                response = await this.fetchWithRateLimit(
                    url,
                    {
                        method: "POST",
                        headers: retry.headers,
                        body: JSON.stringify(retry.body),
                    },
                    { token }
                );
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            Logger.error(`LiteLLM API error: ${response.status} ${response.statusText}`, errorText);
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
     * Builds the retry body and headers for a 400 that rejects a parameter this
     * connector adds itself. Returns undefined when the rejection names no such
     * parameter, in which case the caller must surface the error instead.
     *
     * Two families qualify:
     * - `cache_control`, the Anthropic prompt-caching marker added by the
     *   request builder. It is reported through `onUnsupportedParameter` so
     *   later requests omit it without paying a failed round trip.
     * - the cache-bypass flag added for `litellm-connector.disableCaching`
     *   (`extra_body.cache["no-cache"]` plus its `Cache-Control` header).
     *
     * Nothing else in the body is touched: any other parameter is either the
     * user's own configuration or was accepted by the proxy's capability data,
     * and the caller reports the rejection instead of guessing.
     */
    private planConnectorParameterRetry(
        errorText: string,
        body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest,
        modelId: string,
        modelInfo: LiteLLMModelInfo | undefined
    ): { body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest; headers: Record<string, string> } | undefined {
        const errorLower = errorText.toLowerCase();
        const promptCachingRejected = errorLower.includes("cache_control");
        const cacheBypassRejected =
            errorLower.includes("no-cache") ||
            errorLower.includes("no_cache") ||
            (errorLower.includes("cache") &&
                (errorLower.includes("unknown parameter") ||
                    errorLower.includes("unsupported parameter") ||
                    errorLower.includes("extra inputs are not permitted")));
        if (!promptCachingRejected && !cacheBypassRejected) {
            return undefined;
        }

        const retryBody = JSON.parse(JSON.stringify(body)) as OpenAIChatCompletionRequest | LiteLLMResponsesRequest;
        const retryBodyRecord = retryBody as unknown as Record<string, unknown>;
        const headers = this.getHeaders(modelId, modelInfo);
        let strippedSomething = false;

        if (promptCachingRejected && "cache_control" in retryBodyRecord) {
            Logger.info(`Stripping ${modelId} prompt-caching marker: cache_control rejected`);
            delete retryBodyRecord.cache_control;
            this.config.onUnsupportedParameter?.(modelId, "cache_control");
            strippedSomething = true;
        }

        if (cacheBypassRejected) {
            if (retryBody.extra_body && typeof retryBody.extra_body === "object") {
                const extraBody = retryBody.extra_body as Record<string, unknown>;
                const cache = extraBody.cache;
                if (cache && typeof cache === "object" && "no-cache" in (cache as Record<string, unknown>)) {
                    delete (cache as Record<string, unknown>)["no-cache"];
                    strippedSomething = true;
                    if (Object.keys(cache as Record<string, unknown>).length === 0) {
                        delete extraBody.cache;
                    }
                }
                if (Object.keys(extraBody).length === 0) {
                    delete retryBody.extra_body;
                }
            }
            if (headers["Cache-Control"] !== undefined) {
                delete headers["Cache-Control"];
                strippedSomething = true;
            }
        }

        // A body that did not change would be rejected identically, so do not
        // spend a second request on it.
        return strippedSomething ? { body: retryBody, headers } : undefined;
    }

    private getHeaders(modelId?: string, modelInfo?: LiteLLMModelInfo): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (this.config.key) {
            headers.Authorization = `Bearer ${this.config.key}`;
            headers["X-API-Key"] = this.config.key;
        }
        if (this.config.disableCaching) {
            const isAnthropic = modelId ? isAnthropicModel(modelId, modelInfo) : false;
            if (!isAnthropic) {
                headers["Cache-Control"] = "no-cache";
            }
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

    private withNoCacheExtraBody(
        body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest
    ): OpenAIChatCompletionRequest | LiteLLMResponsesRequest {
        const extraBody = body.extra_body ?? {};
        const cache = (extraBody.cache ?? {}) as Record<string, unknown>;
        cache["no-cache"] = true;
        return {
            ...body,
            extra_body: {
                ...extraBody,
                cache,
            },
        };
    }

    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        options?: { retries?: number; delayMs?: number; token?: vscode.CancellationToken }
    ): Promise<Response> {
        const maxRetries = options?.retries ?? 2;
        const delayMs = options?.delayMs ?? 1000;
        let attempt = 0;
        while (true) {
            if (options?.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const controller = new AbortController();
            const disposable = options?.token?.onCancellationRequested(() => controller.abort());

            try {
                const response = await fetch(url, { ...init, signal: controller.signal });
                if (!response) {
                    if (attempt >= maxRetries) {
                        throw new Error("No response returned from fetch");
                    }
                    attempt++;
                    await this.sleep(delayMs, options?.token);
                    continue;
                }
                if (response.ok || attempt >= maxRetries || response.status < 500 || response.status >= 600) {
                    return response;
                }
                attempt++;
                await this.sleep(delayMs, options?.token);
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") {
                    throw new Error("Operation cancelled by user", { cause: err });
                }
                // Cancellation raised by the inter-attempt sleep (or any nested
                // cancellable helper) should propagate as cancellation, not be
                // caught and re-fed into the retry loop.
                if (err instanceof Error && err.message === "Operation cancelled by user") {
                    throw err;
                }
                if (attempt >= maxRetries) {
                    throw err;
                }
                attempt++;
                await this.sleep(delayMs, options?.token);
            } finally {
                disposable?.dispose();
            }
        }
    }

    /**
     * Fetch with back-off for rate limiting (429), honoring the Retry-After
     * header when present. Retries until the cumulative delay reaches the
     * configured maximum (config `rateLimitMaxDelayMs`, default 120000 ms;
     * 0 disables retries). For other transient errors, it delegates to
     * {@link fetchWithRetry}.
     */
    async fetchWithRateLimit(
        url: string,
        init: RequestInit,
        options?: { maxTotalDelayMs?: number; initialDelayMs?: number; token?: vscode.CancellationToken }
    ): Promise<Response> {
        const maxTotalDelayMs =
            options?.maxTotalDelayMs ??
            this.config.rateLimitMaxDelayMs ??
            LiteLLMClient.DEFAULT_RATE_LIMIT_MAX_DELAY_MS;
        const initialDelayMs = options?.initialDelayMs ?? 500;
        let cumulativeDelayMs = 0;
        let attempt = 0;

        while (true) {
            if (options?.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const response = await this.fetchWithRetry(url, init, { token: options?.token });
            if (response.status !== 429) {
                return response;
            }

            const remaining = maxTotalDelayMs - cumulativeDelayMs;
            if (remaining <= 0) {
                return response;
            }

            const headerDelayMs = this.parseRetryAfterDelayMs(response);
            const exponentialDelayMs = initialDelayMs * Math.pow(2, attempt);
            const chosenDelay = headerDelayMs !== undefined ? headerDelayMs : exponentialDelayMs;
            const nextDelayMs = Math.min(Math.max(1, chosenDelay), remaining);

            attempt++;
            cumulativeDelayMs += nextDelayMs;
            await this.sleep(nextDelayMs, options?.token);
        }
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

    private parseRetryAfterDelayMs(response: Response): number | undefined {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
            const secs = Number(retryAfter);
            if (!Number.isNaN(secs) && secs >= 0) {
                return secs * 1000;
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
