import type * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { LanguageModelTextPart } from "vscode";

import { tryParseJSONObject } from "../utils";
import { describeStoppedEarly, formatConnectorNotice } from "../utils/connectorNotice";
import { Logger } from "../utils/logger";
import { appendRateLimitHint } from "../utils/rateLimitNotice";
import type { ToolNameMapping } from "../utils/toolNameUtils";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { describeFailureForLog, toErrorLogFields } from "./base/errorLogFields";
import { StructuredLogger } from "../observability/structuredLogger";
import { logFinalUsageEnvelope } from "../observability/finalUsageEnvelope";
import { ResponsePartCollector, exportCopilotMdEntry } from "../observability";
import type { CopilotMdEntry } from "../observability";
import { resolveChatSessionId } from "../utils/chatSessionId";
import {
    countOpenAIChatMessagesTokens,
    countTokens,
    estimateToolTokens,
    getReservedOutputTokens,
    getTotalTokenLimit,
} from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import {
    findRejectedParameter,
    isUnsupportedParameterError,
    LiteLLMApiError,
    LiteLLMRateLimitError,
} from "../adapters/litellmClient";
import {
    createInitialStreamingState,
    interpretStreamEvent,
    flushPendingBuffers,
    hasBufferedToolCalls,
} from "../adapters/streaming/liteLLMStreamInterpreter";
import type { EmittedPart } from "../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../adapters/streaming/vscodePartEmitter";
import type { EffortFallbackCache } from "../utils/reasoningEffortFallback";
import { StreamTokenCapture } from "../adapters/streaming/streamTokenCapture";
import type { OpenAIChatCompletionRequest } from "../types";
import { DEFAULT_RETRY_BUDGET_MS, RetryBudget, retryBudgetError } from "../utils/retryBudget";
import {
    StreamedTextAccumulator,
    InactivityTimeoutError,
    ReasoningOnlyError,
    UpstreamStreamError,
    isTransportRetriableError,
    buildResumeMessages,
    sleepWithCancellation,
    backoffDelayMs,
    logTransportRetry,
} from "../utils/transportRetry";

/**
 * Closes an upstream response body the stream loop may have stopped reading.
 * `decodeSSE` releases its reader lock before returning, so this is safe for an
 * open body (cancels the transfer), a closed one (no-op), or a locked or errored
 * one (the rejection is ignored, because there is nothing else to do about it).
 */
function cancelUpstreamBody(body: ReadableStream<Uint8Array>): void {
    void body.cancel().catch(() => undefined);
}

/**
 * Chat provider implementation for VS Code's LanguageModelChatProvider.
 *
 * All shared orchestration (model discovery, request building, parameter filtering,
 * endpoint routing) is implemented in LiteLLMProviderBase.
 *
 * One instance serves every concurrent request (chat sessions, subagents, and background
 * requests such as title generation), so request state never lives in instance fields: stream
 * buffers live for one upstream attempt, and the token capture lives for one request.
 */
export class LiteLLMChatProvider extends LiteLLMProviderBase implements LanguageModelChatProvider {
    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // VS Code 1.120 supplies the per-group `configuration` on the options.
        // We pass the full options through to the base discovery path, which
        // discovers from that per-group configuration.
        const opts = options as vscode.PrepareLanguageModelChatModelOptions & {
            silent?: boolean;
            configuration?: Record<string, unknown>;
        };
        return this.discoverModels(
            {
                silent: opts.silent ?? false,
                configuration: opts.configuration,
            },
            token
        );
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        const startTime = LiteLLMTelemetry.startTimer();
        const requestStartDate = new Date();
        const requestId = Math.random().toString(36).substring(7);

        // Hoisted to the outer scope so the failure/cancel paths in the catch
        // block can still emit a `.copilotmd` entry when the request got far
        // enough to have a body. `endpointUrl` and `requestBodyBuilt` stay
        // `undefined` until assigned in the try block, so a failure before
        // `buildOpenAIChatRequest` produces no export (there's nothing
        // meaningful to render yet). `requestBodyBuilt` and `activeMessages`
        // hold the body and message list of the current attempt. The
        // `activeMessages` initializer covers a failure before the first body
        // exists, so the (body-gated) failure export still has the original
        // message list to render; a mid-stream resume can diverge both from
        // the original request.
        let endpointUrl: string | undefined;
        let requestBodyBuilt: OpenAIChatCompletionRequest | undefined;
        let activeMessages: readonly LanguageModelChatRequestMessage[] = messages;

        const caller = this.getTelemetryOptions(options).caller;

        let tokensIn: number | undefined;

        Logger.info(`Chat request started | RequestID: ${requestId} | Model: ${model.id} | Caller: ${caller}`);
        Logger.trace(
            `Chat request: received model id="${model.id}" name="${model.name}" hasOptionsConfig=${(options as { configuration?: unknown }).configuration !== undefined}`
        );

        // Capability lookups go directly to the BackendRegistry: the single
        // source of truth. There is no per-provider mirror cache, so a stale
        // entry from a previous backend cannot be served for a different
        // backend's request.
        const modelInfo = this._registry.getModelInfo(model.id);
        // `StreamTokenCapture` uses the model id for `countTokens` heuristics
        // (tokenizer family lookup). The namespaced id breaks those heuristics,
        // so we hand it the raw model name instead.
        const tokenCapture = new StreamTokenCapture(this.getRawModelName(model.id), progress, modelInfo);
        const responsePartCollector = new ResponsePartCollector(tokenCapture.progress);
        // Bind `trackingProgress` to the collector's wrapped progress so every
        // downstream streaming call both reports to VS Code (via tokenCapture)
        // AND records the part for the `.copilotmd` export. Single source of
        // truth for the response body.
        const trackingProgress = responsePartCollector.progress;

        // Resolved before the `try` so the success and failure exports share
        // the same id.
        const resolvedSession = await resolveChatSessionId(messages, options.modelOptions);
        const sessionId = resolvedSession.id;
        StructuredLogger.debug(
            "request.session_resolved",
            { sessionId, sessionIdSource: resolvedSession.source },
            { requestId, model: model.id, caller }
        );

        try {
            // Resolve the backend baseUrl for the `.copilotmd` metadata `url:` line.
            // The registry is the single source of truth for (namespaced id → backend);
            // `lookup` returns undefined when the id is not routable, in which case we
            // fall back to the vendor id string so the export still names the backend.
            // Assigned to the outer `let` so the catch block can reference it when
            // rendering a failure entry. Stays undefined if lookup fails before the
            // body is built, which correctly suppresses a meaningless failure export.
            const routingEntry = this._registry.lookup(model.id);
            endpointUrl = routingEntry?.baseUrl ?? "litellm-connector";

            const requestBuild = await this.buildOpenAIChatRequest(messages, model, options, modelInfo, caller);
            const requestBody = requestBuild.request;
            // Reassigned when a resume rebuilds the body, so the mapping always
            // describes the tool list the current attempt sends.
            let toolNames: ToolNameMapping = requestBuild.toolNames;
            // Sent even when the `.copilotmd` export is off: spend grouping is
            // independent of debug logging.
            requestBody.metadata = {
                ...(requestBody.metadata ?? {}),
                session_id: sessionId,
            };
            requestBodyBuilt = requestBody;
            // The model id in `model` is the namespaced `<routing>/<raw>`
            // form VS Code hands us. The tokenizer heuristics and the
            // `isParameterSupported` lookups key off the raw model family, not
            // the routing prefix. The request builder extracts the raw name
            // internally before populating `request.model`, while what a proxy
            // taught us about a model is stored under the namespaced id.
            const rawModelIdForTokenizers = this.getRawModelName(model.id);
            const estimatedTransportInputTokens =
                countOpenAIChatMessagesTokens(requestBody.messages, rawModelIdForTokenizers, modelInfo) +
                estimateToolTokens(requestBody.tools);
            const reservedOutputTokens = getReservedOutputTokens(model, requestBody.max_tokens, {
                estimatedInputTokens: estimatedTransportInputTokens,
                modelInfo,
            });
            const totalTokenMax = getTotalTokenLimit(model, modelInfo);
            tokenCapture.setEstimatedPromptTokens(estimatedTransportInputTokens);
            const systemPromptContent = requestBody.messages.find((m) => m.role === "system")?.content;
            if (typeof systemPromptContent === "string") {
                tokenCapture.setEstimatedSystemPromptTokens(
                    countTokens(systemPromptContent, rawModelIdForTokenizers, modelInfo)
                );
            }
            tokenCapture.setReservedOutputTokens(reservedOutputTokens);
            tokenCapture.setTotalTokenMax(totalTokenMax);

            // Input estimate for the telemetry report. A resume replaces it with the
            // resumed estimate.
            tokensIn = estimatedTransportInputTokens;

            // A socket death (`terminated` / `fetch failed`) or inactivity abort
            // kills the upstream request but does NOT undo parts already emitted
            // to VS Code. Instead of surfacing the transport error (which shows
            // the bare model chip and kills the turn), retry the request and let
            // the model continue from the already-streamed text. Text parts
            // append seamlessly in the chat UI; nothing is duplicated.
            //
            // Reasoning-only completions get a SEPARATE, smaller budget
            // (emptyResponseRetries): they are not transport failures but
            // upstream content truncations, and they cluster in bursts, so a
            // bigger budget just delays the same failure.
            const retryCfg = await this._configManager.getConfig();
            const maxTransportRetries = retryCfg.networkRetries ?? 3;
            const retryBaseDelayMs = retryCfg.networkRetryDelayMs ?? 2000;
            const maxEmptyRetries = retryCfg.emptyResponseRetries ?? 2;
            const emptyBaseDelayMs = retryCfg.emptyResponseRetryDelayMs ?? 1000;
            // Wall-clock bound on the retry phase. The Agents window harness never
            // cancels a request, so without this bound a retrying turn would keep
            // starting attempts until a counter ran out.
            const retryBudget = new RetryBudget(retryCfg.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS);
            const accumulator = new StreamedTextAccumulator();
            const trackedProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
                report: (part) => {
                    accumulator.add(part);
                    trackingProgress.report(part);
                },
            };

            let stream: ReadableStream<Uint8Array>;
            let attempt = 0;
            let emptyAttempt = 0;
            let resumed = false;
            while (true) {
                try {
                    // VS Code may cancel (Stop/steer) during the backoff sleep.
                    // A post-cancel request is pointless: the ext-host progress
                    // wrapper drops all subsequently reported parts anyway.
                    if (token.isCancellationRequested) {
                        Logger.debug(
                            `[transportRetry] request=${requestId} cancelled before attempt ${attempt}; aborting`
                        );
                        throw Object.assign(new Error("Operation cancelled by user"), { name: "CancellationError" });
                    }
                    if (resumed) {
                        // A resume appends the already-streamed reasoning and text
                        // as trailing assistant content so the model continues where
                        // the previous attempt stopped. With nothing to continue, a
                        // "Continue" nudge would ask the model to carry on with output
                        // no attempt produced, so the request is resent unchanged.
                        if (!accumulator.hasResumableOutput) {
                            Logger.debug(
                                `[transportRetry] request=${requestId} resending the unchanged request (no attempt produced output)`
                            );
                        } else {
                            const resumedMessages = buildResumeMessages(
                                messages,
                                accumulator.text,
                                accumulator.thinking
                            );
                            const resumedRequestBody = await this.buildOpenAIChatRequest(
                                resumedMessages,
                                model,
                                options,
                                modelInfo,
                                caller
                            );
                            activeMessages = resumedMessages;
                            requestBodyBuilt = resumedRequestBody.request;
                            toolNames = resumedRequestBody.toolNames;
                            // Carry over the request metadata (which holds the
                            // session id) so resumed attempts keep per-session
                            // spend grouping in LiteLLM.
                            requestBodyBuilt.metadata = { ...(requestBody.metadata ?? {}) };
                            const resumedInputTokens =
                                countOpenAIChatMessagesTokens(
                                    requestBodyBuilt.messages,
                                    rawModelIdForTokenizers,
                                    modelInfo
                                ) + estimateToolTokens(requestBodyBuilt.tools);
                            tokenCapture.setEstimatedPromptTokens(resumedInputTokens);
                            tokenCapture.setReservedOutputTokens(
                                getReservedOutputTokens(model, requestBodyBuilt.max_tokens, {
                                    estimatedInputTokens: resumedInputTokens,
                                    modelInfo,
                                })
                            );
                            tokensIn = resumedInputTokens;
                        }
                    }
                    stream = await this.sendRequestWithRetry(
                        requestBodyBuilt,
                        model,
                        options,
                        trackedProgress,
                        token,
                        caller,
                        modelInfo,
                        requestId
                    );
                    await this.processStreamingResponse(
                        stream,
                        trackedProgress,
                        token,
                        requestId,
                        toolNames.wireToDeclared
                    );

                    // A cancelled stream ends without an error, so without this
                    // check the request would be reported and billed as a success.
                    if (token.isCancellationRequested) {
                        Logger.debug(`[chatRequest] request=${requestId} cancelled after a clean stream end`);
                        throw Object.assign(new Error("Operation cancelled by user"), { name: "CancellationError" });
                    }

                    // Upstream may stream no usage frame; VS Code still needs one usage report.
                    tokenCapture.flushUsage();
                    break;
                } catch (err: unknown) {
                    if (token.isCancellationRequested) {
                        // VS Code cancels mid-stream for its own reasons (user
                        // Stop, agent-loop retries). The resulting abort ends
                        // decodeSSE cleanly, which the reasoning-only detector
                        // then misreads as empty content. Surfacing that would
                        // falsely blame the upstream provider.
                        throw Object.assign(new Error("Operation cancelled by user"), {
                            name: "CancellationError",
                            cause: err,
                        });
                    }
                    if (err instanceof ReasoningOnlyError) {
                        // The previous attempt already delivered the answer, so an
                        // attempt that streams nothing but its finish frame completed the
                        // turn. New reasoning means the model was still thinking, so that
                        // spends the retry budget, and only a `stop` finish proves the
                        // model chose to end its turn.
                        if (
                            resumed &&
                            accumulator.text.trim().length > 0 &&
                            err.reasoningChars === 0 &&
                            err.normalFinish
                        ) {
                            StructuredLogger.info("request.resume_completed_empty", {
                                requestId,
                                resumedTextChars: accumulator.text.length,
                            });
                            tokenCapture.flushUsage();
                            break;
                        }
                        if (emptyAttempt < maxEmptyRetries && !token.isCancellationRequested) {
                            if (!retryBudget.markFailure()) {
                                // The budget, not the reasoning-only count, ends the
                                // turn, so the user must be told which setting bounded it.
                                throw retryBudgetError(retryBudget.budgetMs, err);
                            }
                            emptyAttempt += 1;
                            resumed = true;
                            const delay = retryBudget.clipDelay(backoffDelayMs(emptyAttempt, emptyBaseDelayMs));
                            Logger.warn(
                                `[transportRetry] request=${requestId} reasoning-only response, retry ${emptyAttempt}/${maxEmptyRetries} ` +
                                    `(resuming with ${accumulator.thinking.length} reasoning chars)`
                            );
                            StructuredLogger.warn("request.reasoning_only_retry", {
                                requestId,
                                attempt: emptyAttempt,
                                maxRetries: maxEmptyRetries,
                                delayMs: delay,
                                resumedReasoningChars: accumulator.thinking.length,
                            });
                            tokenCapture.resetAccumulation();
                            await sleepWithCancellation(delay, token);
                            // Do NOT count this against the transport attempt
                            // budget; treat the next iteration as a fresh resume.
                            continue;
                        }
                        // Exhausted: throw a distinct error so the chip explains
                        // the failure instead of "no response was returned".
                        Logger.error(
                            `[transportRetry] request=${requestId} reasoning-only response persisted after ${emptyAttempt} resume attempt(s); failing request`
                        );
                        StructuredLogger.error("request.reasoning_only_exhausted", {
                            requestId,
                            attempts: emptyAttempt,
                            config: maxEmptyRetries,
                        });
                        throw new Error(
                            `LiteLLM: model returned reasoning-only response (no text or tool calls) ` +
                                `after ${emptyAttempt} resume attempt(s). The upstream provider is ` +
                                `truncating generation mid-reasoning; try resending.`,
                            { cause: err }
                        );
                    }

                    const isLastAttempt = attempt >= maxTransportRetries;
                    if (
                        token.isCancellationRequested ||
                        accumulator.sawToolCall ||
                        !isTransportRetriableError(err) ||
                        isLastAttempt
                    ) {
                        // A tool call already reached VS Code before the stream
                        // died: the agent loop may have executed it, so resending
                        // this request could double-execute the tool. Not
                        // recoverable here; log it loudly and rethrow.
                        if (accumulator.sawToolCall && isTransportRetriableError(err) && !isLastAttempt) {
                            Logger.error(
                                `[transportRetry] request=${requestId} unrecoverable: tool call was already emitted before the transport error; not retrying to avoid double tool execution`,
                                toErrorLogFields(err)
                            );
                            StructuredLogger.error("request.transport_retry_blocked_tool_call", {
                                requestId,
                                attempt,
                                ...toErrorLogFields(err),
                            });
                        }
                        // Rethrow so non-transport errors flow through the
                        // shared catch handling below.
                        if (attempt === 0) {
                            this.logRequestPayloadOnFailure(requestBodyBuilt, err, {
                                stage: "provideLanguageModelChatResponse",
                                modelId: model.id,
                                caller,
                                modelInfoMode: modelInfo?.mode,
                            });
                        }
                        throw err;
                    }

                    if (!retryBudget.markFailure()) {
                        // The budget, not the attempt count, ends the turn here. The
                        // boundary handler logs the failure, so this throw does not.
                        throw retryBudgetError(retryBudget.budgetMs, err);
                    }

                    attempt += 1;
                    resumed = true;
                    const delay = retryBudget.clipDelay(backoffDelayMs(attempt, retryBaseDelayMs));
                    logTransportRetry(
                        requestId,
                        attempt,
                        maxTransportRetries,
                        describeFailureForLog(err),
                        accumulator.text.length
                    );
                    StructuredLogger.warn("request.transport_retry", {
                        requestId,
                        attempt,
                        maxRetries: maxTransportRetries,
                        delayMs: delay,
                        resumedTextChars: accumulator.text.length,
                        ...toErrorLogFields(err),
                    });
                    // Fresh attempt: drop partial-response token accounting so
                    // the next usage snapshot reflects only the resumed stream.
                    tokenCapture.resetAccumulation();
                    await sleepWithCancellation(delay, token);
                }
            }

            const snapshot = tokenCapture.getSnapshot();

            const tokensOut = snapshot.outputTokens;
            const tokensInForTelemetry = snapshot.promptTokens ?? tokensIn;
            const reasoningTokens = snapshot.reasoningTokens || undefined;
            const cachedTokens = snapshot.cachedTokens || undefined;
            const systemPromptTokens = snapshot.systemPromptTokens || undefined;
            const toolTokens = snapshot.toolTokens || undefined;
            const acceptedPredictionTokens = snapshot.acceptedPredictionTokens || undefined;
            const rejectedPredictionTokens = snapshot.rejectedPredictionTokens || undefined;
            const cacheCreationInputTokens = snapshot.cacheCreationInputTokens || undefined;
            const estimatedInputCost = snapshot.estimatedInputCost;
            const estimatedOutputCost = snapshot.estimatedOutputCost;
            const estimatedTotalCost = snapshot.estimatedTotalCost;

            const metric = {
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn: tokensInForTelemetry,
                tokensOut,
                promptCacheTokens: cachedTokens,
                cacheCreationInputTokens,
                reasoningTokens,
                toolTokens,
                acceptedPredictionTokens,
                rejectedPredictionTokens,
                reservedOutputTokens,
                totalTokenMax,
                estimatedInputCost,
                estimatedOutputCost,
                estimatedTotalCost,
                status: "success" as const,
                caller,
                cacheReadRatio:
                    cachedTokens !== undefined && tokensInForTelemetry
                        ? cachedTokens / tokensInForTelemetry
                        : undefined,
            };
            LiteLLMTelemetry.reportMetric(metric);
            logFinalUsageEnvelope(requestId, model.id, caller, {
                tokensIn: tokensInForTelemetry,
                tokensOut,
                cachedTokens,
                cacheCreationInputTokens,
                reasoningTokens,
                toolTokens,
                acceptedPredictionTokens,
                rejectedPredictionTokens,
                systemPromptTokens,
                reservedOutputTokens,
                totalTokenMax,
                sawUsageDataPart: snapshot.sawUpstreamUsage,
                estimatedInputCost,
                estimatedOutputCost,
                estimatedTotalCost,
            });

            // Fire-and-forget `.copilotmd` export. Reads the opt-in setting
            // inside `exportCopilotMdEntry`; when disabled this is a single
            // config read + early return, negligible on the request hot path.
            // Never awaited: a failed/slow export must not delay the user's
            // already-streamed response.
            void exportCopilotMdEntry({
                debugName: caller,
                id: requestId.slice(0, 8),
                model: model.id,
                url: endpointUrl ?? "litellm-connector",
                maxPromptTokens: model.maxInputTokens,
                maxResponseTokens: requestBodyBuilt.max_tokens,
                location: undefined,
                body: requestBodyBuilt,
                requestMessages: activeMessages,
                startTimeIso: requestStartDate.toISOString(),
                endTimeIso: new Date().toISOString(),
                durationMs: metric.durationMs,
                ourRequestId: requestId,
                timeToFirstTokenMs: undefined,
                resolvedModel: model.id,
                usage: snapshot,
                responseParts: responsePartCollector.parts,
                status: "success",
                sessionId,
                sessionIdSource: resolvedSession.source,
            } satisfies CopilotMdEntry);

            // Usage data flows through StreamTokenCapture, which intercepts
            // usage DataParts during streaming and enriches them.
        } catch (err: unknown) {
            let errorMessage = err instanceof Error ? err.message : String(err);

            if (errorMessage.includes("LiteLLM API error")) {
                const statusMatch = errorMessage.match(/error: (\d+)/);
                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                const errorParts = errorMessage.split("\n");
                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
                const parsedMessage = this.parseApiError(statusCode, errorText);
                errorMessage = `LiteLLM Error (${model.id}): ${parsedMessage}`;

                const rejectionBody = err instanceof LiteLLMApiError ? err.bodyText : errorText;
                if (err instanceof LiteLLMRateLimitError) {
                    errorMessage = appendRateLimitHint(errorMessage, err.failure);
                } else if (isUnsupportedParameterError(rejectionBody)) {
                    // Resending the identical body would fail the same way, so the
                    // rejection is reported once with the proxy-side fix. Only
                    // parameters the connector adds itself are ever stripped.
                    const rejectedParameter = findRejectedParameter(rejectionBody);
                    const subject = rejectedParameter ? `"${rejectedParameter}"` : "a model parameter";
                    errorMessage +=
                        `. The proxy rejected ${subject}: drop it there with additional_drop_params ` +
                        `or drop_params in the LiteLLM model config, then reload the models.`;
                } else if (
                    parsedMessage.toLowerCase().includes("temperature") ||
                    parsedMessage.toLowerCase().includes("unsupported value")
                ) {
                    errorMessage +=
                        ". This model may not support certain parameters like temperature. Please check your model settings.";
                }
            }
            if (token.isCancellationRequested) {
                Logger.info(
                    `Chat request cancelled | RequestID: ${requestId} | Model: ${model.id} | Caller: ${caller}`
                );
                StructuredLogger.info("request.cancelled", {
                    requestId,
                    model: model.id,
                    caller,
                    stage: "provideLanguageModelChatResponse",
                });
                // Cancellation is not a failure. The host renders the cancelled state
                // itself, so the metric and the transcript record that, not a failure.
                const cancelledDurationMs = LiteLLMTelemetry.endTimer(startTime);
                LiteLLMTelemetry.reportMetric({
                    requestId,
                    model: model.id,
                    durationMs: cancelledDurationMs,
                    tokensIn,
                    status: "cancelled",
                    caller,
                });
                if (requestBodyBuilt && endpointUrl) {
                    void exportCopilotMdEntry({
                        debugName: caller,
                        id: requestId.slice(0, 8),
                        model: model.id,
                        url: endpointUrl,
                        maxPromptTokens: model.maxInputTokens,
                        maxResponseTokens: requestBodyBuilt.max_tokens,
                        location: undefined,
                        body: requestBodyBuilt,
                        requestMessages: activeMessages,
                        startTimeIso: requestStartDate.toISOString(),
                        endTimeIso: new Date().toISOString(),
                        durationMs: cancelledDurationMs,
                        ourRequestId: requestId,
                        timeToFirstTokenMs: undefined,
                        resolvedModel: model.id,
                        usage: tokenCapture.getSnapshot(),
                        responseParts: responsePartCollector.parts,
                        status: "canceled",
                        statusReason: "Cancelled by the user",
                        sessionId,
                        sessionIdSource: resolvedSession.source,
                    } satisfies CopilotMdEntry);
                }
                throw Object.assign(new Error("Operation cancelled by user"), {
                    name: "CancellationError",
                    cause: err,
                });
            }

            // Log identifiers only: the message stays in the user-facing notice
            // and the opt-in transcript, where an echoed prompt is acceptable.
            const errorLogFields = toErrorLogFields(err);
            Logger.error(`Chat request failed | RequestID: ${requestId} | Model: ${model.id}`, errorLogFields);
            StructuredLogger.error("request.failed", {
                requestId,
                model: model.id,
                caller,
                stage: "provideLanguageModelChatResponse",
                ...errorLogFields,
            });

            const metric = {
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                status: "failure" as const,
                error: describeFailureForLog(err),
                caller,
            };
            LiteLLMTelemetry.reportMetric(metric);

            // Fire-and-forget `.copilotmd` export for the failure case. Only
            // emits when the request got far enough to have a built body; a
            // failure before `buildOpenAIChatRequest` (e.g. a config error) has
            // nothing meaningful to render and is skipped.
            if (requestBodyBuilt && endpointUrl) {
                void exportCopilotMdEntry({
                    debugName: caller,
                    id: requestId.slice(0, 8),
                    model: model.id,
                    url: endpointUrl,
                    maxPromptTokens: model.maxInputTokens,
                    maxResponseTokens: requestBodyBuilt.max_tokens,
                    location: undefined,
                    body: requestBodyBuilt,
                    requestMessages: activeMessages,
                    startTimeIso: requestStartDate.toISOString(),
                    endTimeIso: new Date().toISOString(),
                    durationMs: metric.durationMs,
                    ourRequestId: requestId,
                    timeToFirstTokenMs: undefined,
                    resolvedModel: model.id,
                    usage: tokenCapture.getSnapshot(),
                    responseParts: responsePartCollector.parts,
                    status: "failure",
                    statusReason: errorMessage,
                    sessionId,
                    sessionIdSource: resolvedSession.source,
                } satisfies CopilotMdEntry);
            }

            // The Agents window handler answers a thrown error with a 502 and
            // discards the parts already reported, which would lose everything
            // the model said this turn. Completing with the notice as an
            // assistant text part keeps the partial answer in the conversation;
            // cancellation stays a throw because the host renders that state.
            trackingProgress.report(new LanguageModelTextPart(`\n\n${formatConnectorNotice(errorMessage)}`));
            // The reply now looks like model output, so record that it was a
            // failure notice and which initiator triggered it.
            Logger.warn(`Chat request surfaced as assistant error text instead of throwing | RequestID: ${requestId}`);
            StructuredLogger.warn("request.error_surfaced_as_text", {
                requestId,
                model: model.id,
                caller,
                stage: "provideLanguageModelChatResponse",
                ...toErrorLogFields(err),
            });
        }
    }

    /**
     * Processes an SSE streaming response from LiteLLM and emits VS Code response parts.
     *
     * Kept as `protected` to allow unit tests (and potential subclasses) to exercise the
     * streaming pipeline deterministically without stubbing network layers.
     */
    protected async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        requestId: string,
        wireToDeclaredNames?: ReadonlyMap<string, string>
    ): Promise<void> {
        Logger.info(`[processStreamingResponse] request=${requestId} Starting stream processing`);
        StructuredLogger.info("stream.processing_start", {
            requestId,
            timestamp: new Date().toISOString(),
        });

        const config = await this._configManager.getConfig();
        const timeoutMs = (config.inactivityTimeout ?? 60) * 1000;
        // Scoped to one upstream attempt: a resumed retry is a new upstream
        // response, so nothing buffered by the failed attempt belongs to it.
        const streamingState = createInitialStreamingState(requestId, wireToDeclaredNames);
        let watchdog: NodeJS.Timeout | undefined;
        let eventCount = 0;
        let wasWatchdogAbort = false;
        // Content tracking for the reasoning-only detection: a cleanly-completed
        // stream whose ONLY emissions were thinking parts is not a success for
        // the agent loop (VS Code renders "no response was returned").
        let sawTextPart = false;
        let sawToolCallPart = false;
        let sawUsagePart = false;
        let reasoningChars = 0;
        // Set by a `finish` part that ends the turn without completing it.
        let stoppedEarly: { reason: string; notice: string } | undefined;
        // Proof that the model chose to end its turn, not merely that bytes stopped.
        let sawNormalFinish = false;
        // Create an AbortController to actually cancel the stream on timeout
        const controller = new AbortController();

        const emitParts = (parts: EmittedPart[]): void => {
            for (const part of parts) {
                if (part.type === "text") {
                    sawTextPart = true;
                } else if (part.type === "tool_call") {
                    sawToolCallPart = true;
                } else if (part.type === "data" && part.mimeType === "usage") {
                    sawUsagePart = true;
                } else if (part.type === "thinking") {
                    reasoningChars += typeof part.value === "string" ? part.value.length : part.value.join("").length;
                } else if (part.type === "finish") {
                    stoppedEarly = describeStoppedEarly(part.reason) ?? stoppedEarly;
                    if (part.reason === "stop") {
                        sawNormalFinish = true;
                    }
                }
            }
            emitPartsToVSCode(parts, progress);
        };

        // A stream that stops without a finish frame, whether it closes cleanly
        // or is truncated, still holds tool calls the model fully streamed.
        // Delivering them keeps the agent loop going instead of stalling it.
        const recoverBufferedToolCalls = (reason: "stream_completed_without_finish" | "stream_incomplete"): number => {
            const recoveredToolCalls = flushPendingBuffers(streamingState).filter((part) => part.type === "tool_call");
            emitParts(recoveredToolCalls);
            Logger.info(
                `[processStreamingResponse] request=${requestId} Recovered ${recoveredToolCalls.length} buffered tool calls (${reason})`
            );
            StructuredLogger.info("stream.tool_calls_recovered", {
                requestId,
                reason,
                eventCount,
                toolCallsRecovered: recoveredToolCalls.length,
            });
            return recoveredToolCalls.length;
        };

        const resetWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                Logger.warn(
                    `[processStreamingResponse] request=${requestId} Inactivity timeout after ${timeoutMs}ms (after ${eventCount} events)`
                );
                StructuredLogger.warn("stream.inactivity_timeout", {
                    requestId,
                    timeoutMs,
                    eventCount,
                });
                wasWatchdogAbort = true;
                controller.abort();
            }, timeoutMs);
        };

        const cancellationListener = token.onCancellationRequested(() => {
            // The listener runs synchronously inside whoever called cancel(),
            // so this stack is the only fingerprint of the canceller, e.g.
            // user action, Copilot agent-loop retry, or session teardown,
            // which the CancellationToken API itself does not expose.
            const cancellationStack = new Error().stack;
            Logger.warn(
                `[processStreamingResponse] request=${requestId} Cancellation requested from VS Code after ${eventCount} events (text=${sawTextPart}, toolCall=${sawToolCallPart}, usage=${sawUsagePart})`
            );
            StructuredLogger.warn("stream.cancellation_requested", {
                requestId,
                eventCount,
                sawTextPart,
                sawToolCallPart,
                sawUsagePart,
                stack: cancellationStack,
            });
            if (watchdog) {
                clearTimeout(watchdog);
            }
            controller.abort();
        });

        try {
            resetWatchdog();
            Logger.debug(`[processStreamingResponse] Starting SSE decoder loop`);

            for await (const payload of decodeSSE(responseBody, token, controller.signal)) {
                resetWatchdog();
                eventCount++;

                Logger.trace(`[processStreamingResponse] Event #${eventCount} received, length=${payload.length}`);

                const jsonResult = tryParseJSONObject(payload);
                if (!jsonResult.ok) {
                    Logger.trace(`[processStreamingResponse] Event #${eventCount}: Skipped (JSON parse failed)`);
                    StructuredLogger.trace("stream.event_parse_skipped", {
                        eventNumber: eventCount,
                        payloadLength: payload.length,
                    });
                    continue;
                }
                const json = jsonResult.value;

                Logger.trace(`[processStreamingResponse] Event #${eventCount}: Interpreting event`);
                const parts = interpretStreamEvent(json, streamingState);
                Logger.trace(
                    `[processStreamingResponse] Event #${eventCount}: Got ${parts.length} parts, emitting to VS Code`
                );
                StructuredLogger.trace("stream.event_processed", {
                    eventNumber: eventCount,
                    partCount: parts.length,
                });
                emitParts(parts);
            }

            Logger.info(`[processStreamingResponse] Stream loop completed after ${eventCount} events`);
            StructuredLogger.info("stream.processing_complete", {
                eventCount,
                reason: "stream_ended",
            });

            // A watchdog abort causes decodeSSE to END CLEANLY (the aborted flag
            // there suppresses its endError), so the abort lands HERE on the
            // normal path, not in the catch block. Surface it as the retryable
            // sentinel BEFORE reasoning-only detection: a watchdog abort kills
            // the stream regardless of whether reasoning was emitted.
            if (wasWatchdogAbort) {
                throw new InactivityTimeoutError(timeoutMs, eventCount);
            }

            // A cancelled stream's output is discarded by VS Code, so only a
            // stream that ended on its own delivers its buffered tool calls.
            if (!token.isCancellationRequested && hasBufferedToolCalls(streamingState)) {
                recoverBufferedToolCalls("stream_completed_without_finish");
            }

            // Reasoning-only detection: a cleanly-completed stream that emitted
            // ONLY thinking parts (plus perhaps a usage data part) contains
            // nothing the agent loop can act on. VS Code renders it as
            // "no response was returned" and kills the turn. Surface it to the
            // retry loop as resumable: the partial reasoning is appended to the
            // request so the model continues its thought.
            if (eventCount > 0 && !sawTextPart && !sawToolCallPart) {
                Logger.warn(
                    `[processStreamingResponse] request=${requestId} Reasoning-only stream detected (${eventCount} events, ` +
                        `no text/tool parts); surfacing as resumable empty-content error`
                );
                StructuredLogger.warn("stream.reasoning_only_response", {
                    requestId,
                    eventCount,
                    sawUsagePart,
                });
                throw new ReasoningOnlyError(eventCount, reasoningChars, sawNormalFinish);
            }

            // Deliberately after the reasoning-only check: if the model only
            // reasoned before hitting its limit, the retry path is the better
            // answer than a notice about a response that never appeared.
            if (stoppedEarly) {
                Logger.warn(
                    `[processStreamingResponse] request=${requestId} Stream stopped by finish reason "${stoppedEarly.reason}"`
                );
                StructuredLogger.warn("stream.stopped_early", {
                    requestId,
                    reason: stoppedEarly.reason,
                    eventCount,
                });
                progress.report(new LanguageModelTextPart(stoppedEarly.notice));
            }
        } catch (error: unknown) {
            // Every error leaving this method is handled by the caller, which
            // retries the recoverable sentinels and logs the final outcome. Log
            // the attempt at warn so a recovered retry does not read as a
            // failure in the channel.
            Logger.warn(
                `[processStreamingResponse] request=${requestId} Stream attempt failed after ${eventCount} events`,
                toErrorLogFields(error)
            );
            StructuredLogger.warn("stream.attempt_failed", {
                requestId,
                eventCount,
                ...toErrorLogFields(error),
            });

            const isStreamEndError =
                !(error instanceof UpstreamStreamError) &&
                error instanceof Error &&
                (error.message.includes("Stream ended before [DONE] marker") ||
                    error.message.includes("stream ended") ||
                    error.message.includes("unexpected end"));

            // A partial response with its tool calls beats a hard failure, so a
            // truncated stream that recovers any call completes normally.
            if (isStreamEndError && hasBufferedToolCalls(streamingState)) {
                const recoveredCount = recoverBufferedToolCalls("stream_incomplete");
                if (recoveredCount > 0) {
                    return;
                }
            }

            // Belt-and-suspenders: if a watchdog abort coincided with an actual
            // stream error, classify it as the retryable inactivity sentinel.
            if (wasWatchdogAbort) {
                throw new InactivityTimeoutError(timeoutMs, eventCount);
            }

            throw error;
        } finally {
            // The retry loop in provideLanguageModelChatResponse re-enters
            // this method per attempt on the same token, so the listener must
            // not outlive this call, or earlier attempts would log duplicate
            // cancellation events.
            cancellationListener.dispose();
            if (watchdog) {
                clearTimeout(watchdog);
            }
            // Every exit path releases the reader, but an early exit (error
            // frame, reasoning-only retry, recovered tool calls) would otherwise
            // leave the upstream generating and billing until it finishes.
            cancelUpstreamBody(responseBody);
        }
    }
}
