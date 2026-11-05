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

import { formatConnectorNotice } from "../utils/connectorNotice";
import { Logger } from "../utils/logger";
import type { ToolNameMapping } from "../utils/toolNameUtils";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { processResponseStream } from "./chat/responseStream";
import {
    reportConnectorCancellation,
    reportHostCancellation,
    reportTurnFailure,
    reportTurnSuccess,
} from "./chat/turnReport";
import { describeFailureForLog, toErrorLogFields } from "./base/errorLogFields";
import { StructuredLogger } from "../observability/structuredLogger";
import { ResponsePartCollector } from "../observability";
import { resolveChatSessionId } from "../utils/chatSessionId";
import {
    countOpenAIChatMessagesTokens,
    countTokens,
    estimateToolTokens,
    getReservedOutputTokens,
    getTotalTokenLimit,
} from "../adapters/tokenUtils";

import { StreamTokenCapture } from "../adapters/streaming/streamTokenCapture";
import type { OpenAIChatCompletionRequest } from "../types";
import { RequestCancellation } from "../utils/requestCancellation";
import type { RequestOutcomeContext } from "./base/requestOutcome";
import { DEFAULT_RETRY_BUDGET_MS, RetryBudget, retryBudgetError } from "../utils/retryBudget";
import {
    StreamedTextAccumulator,
    HeadersTimeoutError,
    ReasoningOnlyError,
    isTransportRetriableError,
    buildResumeMessages,
    sleepWithCancellation,
    backoffDelayMs,
    logTransportRetry,
    formatDuration,
} from "../utils/transportRetry";

/** Headers-timeout retries one request may spend. */
const MAX_HEADERS_TIMEOUT_RETRIES = 1;

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
        // Twelve hex characters from a UUID, enough to correlate the log, the transcript and
        // the live-request registry without carrying a full UUID everywhere.
        const requestId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

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

        // Created here, immediately before the `try`, so nothing between their
        // creation and the `finally` can leave a registry entry or a host listener
        // behind. The composite token is what every inner layer sees, so the
        // connector's cancel command reaches all of them and a host cancellation
        // propagates.
        const requestCancellation = new RequestCancellation(token);
        const activeRequest = this.activeRequests.register({
            requestId,
            model: model.id,
            caller,
            startedAt: requestStartDate.getTime(),
            phase: "sending",
            cancel: () => requestCancellation.cancelByConnector(),
        });

        // The fields every outcome of this request shares. Built on demand so the
        // usage snapshot and the response parts are read when the turn ends, not
        // when it starts.
        const outcomeContext = (): RequestOutcomeContext => ({
            requestId,
            model,
            caller,
            endpointUrl,
            requestBodyBuilt,
            activeMessages,
            requestStartDate,
            usage: tokenCapture.getSnapshot(),
            responseParts: responsePartCollector.parts,
            sessionId,
            sessionIdSource: resolvedSession.source,
        });

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

            const restartBudgetAfterProgress = (): void => {
                if (accumulator.text.length + accumulator.thinking.length > outputAtAttemptStart) {
                    retryBudget.restart();
                }
            };

            let stream: ReadableStream<Uint8Array>;
            let attempt = 0;
            let emptyAttempt = 0;
            // A headers timeout means the proxy never started answering, so one retry
            // covers a transient stall. A second means the wait itself is the problem,
            // and repeating it only multiplies a guaranteed failure.
            let headersTimeoutAttempts = 0;
            let resumed = false;
            // Output already streamed when an attempt starts. An attempt that adds to
            // it proved the upstream is working, so the retry clock starts over.
            let outputAtAttemptStart = 0;
            while (true) {
                try {
                    // A cancel that landed before this attempt stops here, so a
                    // cancelled turn sends no further request.
                    if (requestCancellation.isCancellationRequested) {
                        Logger.debug(
                            `[transportRetry] request=${requestId} cancelled before attempt ${attempt}; aborting`
                        );
                        throw Object.assign(new Error("Operation cancelled by user"), { name: "CancellationError" });
                    }
                    outputAtAttemptStart = accumulator.text.length + accumulator.thinking.length;
                    // A retry starts a fresh header wait, so the request is back in the
                    // phase the picker labels "waiting for headers".
                    activeRequest.setPhase("sending");
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
                    // Read before the body exists: a config failure here cannot strand
                    // an open upstream response. A setting changed mid-turn still
                    // applies to the next attempt.
                    const streamCfg = await this._configManager.getConfig();
                    stream = await this.sendRequestWithRetry(
                        requestBodyBuilt,
                        model,
                        options,
                        trackedProgress,
                        requestCancellation,
                        caller,
                        modelInfo,
                        requestId
                    );
                    // Headers have arrived, so the request is now reading a body.
                    activeRequest.setPhase("streaming");
                    await processResponseStream({
                        responseBody: stream,
                        progress: trackedProgress,
                        token: requestCancellation,
                        requestId,
                        wireToDeclaredNames: toolNames.wireToDeclared,
                        inactivityTimeoutMs: (streamCfg.inactivityTimeout ?? 60) * 1000,
                    });

                    // A cancelled stream ends without an error, so without this
                    // check the request would be reported and billed as a success.
                    if (requestCancellation.isCancellationRequested) {
                        Logger.debug(`[chatRequest] request=${requestId} cancelled after a clean stream end`);
                        throw Object.assign(new Error("Operation cancelled by user"), { name: "CancellationError" });
                    }

                    // Upstream may stream no usage frame; VS Code still needs one usage report.
                    tokenCapture.flushUsage();
                    break;
                } catch (err: unknown) {
                    if (requestCancellation.isCancellationRequested) {
                        // A cancellation mid-stream ends the body without an error,
                        // whether the host asked for it (user Stop, agent-loop
                        // retries) or the user cancelled from the connector's cancel
                        // command. decodeSSE returns cleanly, which the
                        // reasoning-only detector would otherwise misread as empty
                        // content and blame on the upstream provider.
                        throw Object.assign(new Error("Operation cancelled by user"), {
                            name: "CancellationError",
                            cause: err,
                        });
                    }
                    if (err instanceof ReasoningOnlyError) {
                        // The previous attempt already delivered the answer, so an
                        // attempt that streams nothing but its finish frame completed the
                        // turn. New reasoning means the model was still working, so that
                        // attempt restarts the retry clock, and only a `stop` finish proves
                        // the model chose to end its turn.
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
                        if (emptyAttempt < maxEmptyRetries && !requestCancellation.isCancellationRequested) {
                            restartBudgetAfterProgress();
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
                            await sleepWithCancellation(delay, requestCancellation);
                            // Do NOT count this against the transport attempt
                            // budget; treat the next iteration as a fresh resume.
                            continue;
                        }
                        // Exhausted: throw a distinct error so the chip explains the
                        // failure instead of "no response was returned". The boundary
                        // handler records this turn's failure once, so nothing is logged
                        // here.
                        // An empty reply is one that ended on a proven stop having produced
                        // nothing at all. A length cut, or a resend that adds nothing to
                        // reasoning the user already saw, was cut short instead, and calling
                        // that empty would misdescribe it.
                        const isEmptyReply =
                            err.reasoningChars === 0 && err.normalFinish && accumulator.thinking.length === 0;
                        const reason = isEmptyReply
                            ? `LiteLLM: model returned an empty reply (no text, reasoning or tool call) ` +
                              `after ${emptyAttempt} resend(s); try resending.`
                            : `LiteLLM: model returned reasoning-only response (no text or tool calls) ` +
                              `after ${emptyAttempt} resume attempt(s). The upstream provider is ` +
                              `truncating generation mid-reasoning; try resending.`;
                        throw new Error(reason, { cause: err });
                    }

                    if (err instanceof HeadersTimeoutError) {
                        headersTimeoutAttempts += 1;
                        if (headersTimeoutAttempts > MAX_HEADERS_TIMEOUT_RETRIES) {
                            // The connector's timer uses the setting's value. The runtime's
                            // limit fires at 300 s whatever the setting says.
                            const detail =
                                err.source === "runtime"
                                    ? `The HTTP runtime's own header limit fired, which litellm-connector.headersTimeout cannot move.`
                                    : `The last attempt waited ${formatDuration(err.timeoutMs)} (litellm-connector.headersTimeout).`;
                            throw new Error(
                                `LiteLLM: the proxy sent no response headers on ${headersTimeoutAttempts} attempts, ` +
                                    `so the request is no longer retried. ${detail}`,
                                { cause: err }
                            );
                        }
                    }

                    const isLastAttempt = attempt >= maxTransportRetries;
                    if (
                        requestCancellation.isCancellationRequested ||
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

                    restartBudgetAfterProgress();
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
                    await sleepWithCancellation(delay, requestCancellation);
                }
            }

            // Usage data flows through StreamTokenCapture, which intercepts
            // usage DataParts during streaming and enriches them. The transcript
            // export it drives is fire-and-forget: it reads the opt-in setting
            // itself and is never awaited, so a slow write cannot delay a response
            // the user already has.
            reportTurnSuccess({
                requestId,
                modelId: model.id,
                caller,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                snapshot: tokenCapture.getSnapshot(),
                reservedOutputTokens,
                totalTokenMax,
                outcomeContext,
            });
        } catch (err: unknown) {
            const durationMs = LiteLLMTelemetry.endTimer(startTime);

            if (requestCancellation.cancelledByConnector) {
                // The connector ended this turn, not the host: VS Code is still
                // waiting on the promise, so returning with a notice closes the turn
                // and keeps whatever streamed. Throwing here would make the Agents
                // window handler answer with a 502 and discard that output.
                reportConnectorCancellation({
                    requestId,
                    modelId: model.id,
                    caller,
                    durationMs,
                    tokensIn,
                    responsePartCount: responsePartCollector.parts.length,
                    outcomeContext,
                });
                trackingProgress.report(
                    new LanguageModelTextPart(
                        `\n\n${formatConnectorNotice("Request cancelled from the LiteLLM connector.")}`
                    )
                );
                return;
            }

            if (token.isCancellationRequested) {
                reportHostCancellation({
                    requestId,
                    modelId: model.id,
                    caller,
                    durationMs,
                    tokensIn,
                    outcomeContext,
                });
                throw Object.assign(new Error("Operation cancelled by user"), {
                    name: "CancellationError",
                    cause: err,
                });
            }

            reportTurnFailure({
                requestId,
                modelId: model.id,
                caller,
                durationMs,
                tokensIn,
                error: err,
                progress: trackingProgress,
                outcomeContext,
            });
        } finally {
            // Nothing outlives the turn: neither a listed request nor a host listener.
            activeRequest.dispose();
            requestCancellation.dispose();
        }
    }
}
