import type * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { StructuredLogger } from "../../observability/structuredLogger";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import type { TransportDeps } from "./types";
import { describeFailureForLog, toErrorLogFields } from "./errorLogFields";
import type { RateLimitWaitLedger } from "../../utils/rateLimitRetryPolicy";

/**
 * Sends a LiteLLM request to the configured endpoint.
 *
 * The single-provider design means routing is direct: the
 * `LiteLLMClient` is constructed from the baseUrl/apiKey passed on the
 * originating VS Code call (via `options.configuration`). There is no
 * global state consulted for routing and no model-id parsing.
 */
export class Transport {
    private readonly configManager: TransportDeps["configManager"];
    private readonly userAgent: string;
    private readonly logger: TransportDeps["logger"];
    private readonly onUnsupportedParameter?: TransportDeps["onUnsupportedParameter"];
    private readonly liteLLMClientFactory: (backend: {
        url: string;
        key?: string;
        disableCaching?: boolean;
        rateLimitMaxDelayMs?: number;
        headersTimeoutMs?: number;
        onUnsupportedParameter?: (model: string, param: string) => void;
    }) => LiteLLMClient;

    constructor(deps: TransportDeps) {
        this.configManager = deps.configManager;
        this.userAgent = deps.userAgent;
        this.logger = deps.logger;
        this.onUnsupportedParameter = deps.onUnsupportedParameter;
        this.liteLLMClientFactory =
            deps.liteLLMClientFactory ??
            ((backend) =>
                new LiteLLMClient(
                    {
                        url: backend.url,
                        key: backend.key,
                        disableCaching: backend.disableCaching,
                        rateLimitMaxDelayMs: backend.rateLimitMaxDelayMs,
                        headersTimeoutMs: backend.headersTimeoutMs,
                        onUnsupportedParameter: backend.onUnsupportedParameter,
                    },
                    this.userAgent
                ));
    }

    public async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>,
        requestId?: string,
        learnedLimitsKey?: string,
        rateLimitLedger?: RateLimitWaitLedger
    ): Promise<ReadableStream<Uint8Array>> {
        this.logger.debug(
            `[transport.sendRequestToLiteLLM] Preparing LiteLLM request for model: ${request.model} (caller: ${caller})`
        );
        StructuredLogger.debug("transport.send_request_start", {
            model: request.model,
            caller,
            mode: modelInfo?.mode,
            hasTools: !!request.tools && request.tools.length > 0,
            toolCount: request.tools?.length ?? 0,
            messageCount: request.messages?.length ?? 0,
        });

        const baseUrl = typeof configuration?.baseUrl === "string" ? configuration.baseUrl.trim() : "";
        const apiKey = typeof configuration?.apiKey === "string" ? configuration.apiKey.trim() : "";

        // The provider terminates a rejected configuration and logs it with the request
        // id, so the transport only throws.
        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            throw new Error(
                `No baseUrl provided in call-time configuration for model "${request.model}". Configure the LiteLLM provider group in VS Code's Language Models view.`
            );
        }
        if (!apiKey) {
            throw new Error(
                `No apiKey provided in call-time configuration for model "${request.model}". Configure the LiteLLM provider group in VS Code's Language Models view.`
            );
        }

        // Thread disableCaching from the per-call configuration through to the
        // LiteLLMClient, which then adds the proxy cache directive to the body.
        const disableCaching =
            typeof configuration?.disableCaching === "boolean" ? configuration.disableCaching : undefined;
        // The configuration merge does not guarantee clamped values, so the
        // guards below must stay self-contained.
        const rateLimitMaxDelayMs =
            typeof configuration?.rateLimitMaxDelayMs === "number" &&
            Number.isFinite(configuration.rateLimitMaxDelayMs) &&
            configuration.rateLimitMaxDelayMs >= 0
                ? configuration.rateLimitMaxDelayMs
                : undefined;
        const headersTimeoutMs =
            typeof configuration?.headersTimeoutMs === "number" &&
            Number.isFinite(configuration.headersTimeoutMs) &&
            configuration.headersTimeoutMs > 0
                ? configuration.headersTimeoutMs
                : undefined;
        this.logger.trace(
            `[transport.sendRequestToLiteLLM] Creating client: baseUrl=${baseUrl}, timeout=${modelInfo?.timeout ?? "default"}ms, disableCaching=${disableCaching}, headersTimeoutMs=${headersTimeoutMs ?? "default"}`
        );
        const client = this.liteLLMClientFactory({
            url: baseUrl,
            key: apiKey,
            disableCaching,
            rateLimitMaxDelayMs,
            headersTimeoutMs,
            // A learned rejection belongs to one proxy's model config, so it is
            // recorded under the namespaced picker id, not the wire model name.
            // The provider always supplies that id, so a missing one means a
            // caller bypassed it: the rejection is reported instead of stored
            // under a key nothing reads.
            onUnsupportedParameter: (wireModel: string, param: string) => {
                if (!learnedLimitsKey) {
                    StructuredLogger.warn("transport.learned_limit_without_key", { param, model: wireModel });
                    return;
                }
                this.onUnsupportedParameter?.(learnedLimitsKey, param);
            },
        });

        this.logger.info(
            `[transport.sendRequestToLiteLLM] Sending request to LiteLLM: model=${request.model} caller=${caller} streaming=true`
        );
        StructuredLogger.info("transport.http_request_start", {
            model: request.model,
            caller,
            endpoint: modelInfo?.mode,
            requestModel: request.model,
            reasoning_effort: (request as { reasoning_effort?: string }).reasoning_effort,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
        });

        // Read the per-call fallback flag from the per-group configuration.
        // VS Code 1.120 delivers workspace settings via options.configuration on
        // every call; the chat provider merges LiteLLMConfig into this object
        // before invoking the transport, so allowChatCompletionsFallback lives
        // here rather than on a globally-cached config.
        const allowFallback =
            typeof configuration?.allowChatCompletionsFallback === "boolean" &&
            configuration.allowChatCompletionsFallback === true;

        try {
            const stream = await client.chat(request, modelInfo?.mode, token, requestId, rateLimitLedger);
            this.logger.debug(`[transport.sendRequestToLiteLLM] HTTP stream established for model: ${request.model}`);
            StructuredLogger.debug("transport.http_response_stream_open", {
                model: request.model,
                caller,
            });
            return stream;
        } catch (err) {
            // Documented escape hatch: when forceResponsesEndpoint (or a
            // backend-advertised mode) routes a model to /responses and the
            // proxy returns a 5xx (e.g. Azure AI returning a chat-completions
            // schema that LiteLLM cannot parse into ResponsesAPIResponse),
            // retry exactly once on /chat/completions. Only a /responses 5xx
            // triggers the fallback. A 4xx and a chat-mode failure propagate as
            // hard failures. This is the behavior README.md advertises for
            // `litellm-connector.allowChatCompletionsFallback`.
            const isResponsesMode = modelInfo?.mode === "responses";
            const is500 = err instanceof Error && /LiteLLM API error: 5\d\d/.test(err.message);
            if (allowFallback && isResponsesMode && is500) {
                this.logger.warn(
                    `[transport.sendRequestToLiteLLM] /responses failed with 5xx for model ${request.model}; falling back to /chat/completions (allowChatCompletionsFallback=true)`,
                    describeFailureForLog(err)
                );
                StructuredLogger.warn("transport.responses_fallback_to_chat", {
                    model: request.model,
                    caller,
                    ...toErrorLogFields(err),
                });
                return client.chat(request, "chat", token, requestId, rateLimitLedger);
            }

            // The provider owns the single log for a request failure, so this
            // layer rethrows without logging.
            throw err;
        }
    }
}
