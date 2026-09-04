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

import { tryParseJSONObject } from "../utils";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { StructuredLogger } from "../observability/structuredLogger";
import { ResponsePartCollector, exportCopilotMdEntry, computeSessionFingerprint } from "../observability";
import type { CopilotMdEntry } from "../observability";
import {
    countOpenAIChatMessagesTokens,
    countTokens,
    estimateToolTokens,
    getReservedOutputTokens,
    getTotalTokenLimit,
} from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import {
    createInitialStreamingState,
    interpretStreamEvent,
    flushPendingBuffers,
} from "../adapters/streaming/liteLLMStreamInterpreter";
import type { StreamingState } from "../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../adapters/streaming/vscodePartEmitter";
import type { EffortFallbackCache } from "../utils/reasoningEffortFallback";
import { StreamTokenCapture } from "../adapters/streaming/streamTokenCapture";
import type { OpenAIChatCompletionRequest } from "../types";
import {
    StreamedTextAccumulator,
    InactivityTimeoutError,
    ReasoningOnlyError,
    isTransportRetriableError,
    buildResumeMessages,
    sleepWithCancellation,
    backoffDelayMs,
    logTransportRetry,
} from "../utils/transportRetry";

/**
 * Chat provider implementation for VS Code's LanguageModelChatProvider.
 *
 * All shared orchestration (model discovery, request building, trimming, parameter filtering,
 * endpoint routing) is implemented in LiteLLMProviderBase.
 */
export class LiteLLMChatProvider extends LiteLLMProviderBase implements LanguageModelChatProvider {
    // Streaming state
    private _streamingState: StreamingState = createInitialStreamingState();
    private _tokenCapture?: StreamTokenCapture;

    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }

    /************************************************
     * TODO: REMOVE IF UNUSED IN VERSION 2.3
     * REASON: Saving in the event this code is
     *       actually necessary.
     *  REMOVE BY: V2.3
     *  CONDITION: IF UNUSED/COMMENTED
     */
    /*
    private mergeUsagePayloadWithLastKnown(current: OpenAIUsagePayload): OpenAIUsagePayload {
        const previous = this._tokenCapture?.getSnapshot();
        if (!previous) {
            return current;
        }

        const pickMonotonicTokenCount = (currentValue?: number, previousValue?: number): number | undefined => {
            if (typeof currentValue === "number" && typeof previousValue === "number") {
                return Math.max(currentValue, previousValue);
            }
            if (typeof currentValue === "number") {
                return currentValue;
            }
            return previousValue;
        };

        const normalizedCurrentPromptDetails: OpenAIUsagePromptTokenDetails = {
            ...(current.prompt_tokens_details ?? {}),
        };
        const normalizedCurrentCompletionDetails: OpenAIUsageCompletionTokenDetails = {
            ...(current.completion_tokens_details ?? {}),
        };

        const mergedPromptTokens = Math.max(current.prompt_tokens, previous.promptTokens ?? 0);
        const mergedCompletionTokens = Math.max(current.completion_tokens, previous.completionTokens ?? 0);

        const mergedPromptDetails: OpenAIUsagePromptTokenDetails = {
            cached_tokens: pickMonotonicTokenCount(
                normalizedCurrentPromptDetails.cached_tokens ?? (current.prompt_tokens_details ? 0 : undefined),
                previous.cachedTokens
            ),
            cache_creation_input_tokens: pickMonotonicTokenCount(
                normalizedCurrentPromptDetails.cache_creation_input_tokens,
                previous.cacheCreationInputTokens
            ),
        };

        const mergedCompletionDetails: OpenAIUsageCompletionTokenDetails = {
            reasoning_tokens: pickMonotonicTokenCount(
                normalizedCurrentCompletionDetails.reasoning_tokens ??
                    (current.completion_tokens_details ? 0 : undefined),
                previous.reasoningTokens
            ),
            tool_tokens: pickMonotonicTokenCount(normalizedCurrentCompletionDetails.tool_tokens, previous.toolTokens),
            accepted_prediction_tokens: pickMonotonicTokenCount(
                normalizedCurrentCompletionDetails.accepted_prediction_tokens,
                previous.acceptedPredictionTokens
            ),
            rejected_prediction_tokens: pickMonotonicTokenCount(
                normalizedCurrentCompletionDetails.rejected_prediction_tokens,
                previous.rejectedPredictionTokens
            ),
        };

        const merged: OpenAIUsagePayload = {
            ...current,
            prompt_tokens: mergedPromptTokens,
            completion_tokens: mergedCompletionTokens,
            total_tokens: mergedPromptTokens + mergedCompletionTokens,
            system_prompt_tokens: pickMonotonicTokenCount(current.system_prompt_tokens, previous.systemPromptTokens),
            prompt_tokens_details: Object.values(mergedPromptDetails).some((value) => typeof value === "number")
                ? mergedPromptDetails
                : undefined,
            completion_tokens_details: Object.values(mergedCompletionDetails).some((value) => typeof value === "number")
                ? mergedCompletionDetails
                : undefined,
            reserved_output_tokens: current.reserved_output_tokens,
            total_token_max: current.total_token_max,
        };

        return merged;
    }
*/
    /************************************************
     * End of code block
     ***********************************************/

    private logFinalUsageEnvelope(
        requestId: string,
        modelId: string,
        caller: string,
        usage: {
            tokensIn?: number;
            tokensOut?: number;
            cachedTokens?: number;
            cacheCreationInputTokens?: number;
            reasoningTokens?: number;
            toolTokens?: number;
            acceptedPredictionTokens?: number;
            rejectedPredictionTokens?: number;
            systemPromptTokens?: number;
            reservedOutputTokens?: number;
            totalTokenMax?: number;
            sawUsageDataPart: boolean;
            estimatedInputCost?: number;
            estimatedOutputCost?: number;
            estimatedTotalCost?: number;
        }
    ): void {
        Logger.debug(
            `[TokenUsage][Final] request_id=${requestId} model=${modelId} caller=${caller} ` +
                `tokens_in=${usage.tokensIn ?? "n/a"} tokens_out=${usage.tokensOut ?? "n/a"} ` +
                `cached_tokens=${usage.cachedTokens ?? "n/a"} cache_creation_input_tokens=${
                    usage.cacheCreationInputTokens ?? "n/a"
                } ` +
                `reasoning_tokens=${usage.reasoningTokens ?? "n/a"} tool_tokens=${usage.toolTokens ?? "n/a"} ` +
                `accepted_prediction_tokens=${usage.acceptedPredictionTokens ?? "n/a"} rejected_prediction_tokens=${
                    usage.rejectedPredictionTokens ?? "n/a"
                } ` +
                `system_prompt_tokens=${usage.systemPromptTokens ?? "n/a"} reserved_output_tokens=${
                    usage.reservedOutputTokens ?? "n/a"
                } ` +
                `total_token_max=${usage.totalTokenMax ?? "n/a"} streamed_usage=${usage.sawUsageDataPart} ` +
                `estimated_input_cost=${usage.estimatedInputCost ?? "n/a"} estimated_output_cost=${
                    usage.estimatedOutputCost ?? "n/a"
                } estimated_total_cost=${usage.estimatedTotalCost ?? "n/a"}`
        );
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // VS Code 1.120 expands the options shape to include `configuration` (per-group BYOK
        // values configured by the user). We pass the full options through to the base discovery
        // path so it can choose between configuration-based discovery (1.120 group system) and
        // legacy workspace-settings discovery transparently.
        const opts = options as vscode.PrepareLanguageModelChatModelOptions & {
            silent?: boolean;
            configuration?: Record<string, unknown>;
            groupName?: string;
        };
        return this.discoverModels(
            {
                silent: opts.silent ?? false,
                configuration: opts.configuration,
                groupName: opts.groupName,
            },
            token
        );
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        token: CancellationToken,
        configuration?: Record<string, unknown>
    ): Promise<number> {
        return super.provideTokenCount(model, text, token, configuration);
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        this.resetStreamingState();
        const startTime = LiteLLMTelemetry.startTimer();
        const requestStartDate = new Date();
        const requestId = Math.random().toString(36).substring(7);

        // Hoisted to the outer scope so the failure/cancel paths in the catch
        // block can still emit a `.copilotmd` entry when the request got far
        // enough to have a body. Both stay `undefined` until assigned in the
        // try block, so a failure before `buildOpenAIChatRequest` correctly
        // produces no export (there's nothing meaningful to render yet).
        let endpointUrl: string | undefined;
        let requestBodyBuilt: OpenAIChatCompletionRequest | undefined;
        // Session fingerprint — computed once from `messages` (the request
        // input) at the top of the try block, then reused for two purposes:
        //   1. Injected into `requestBody.metadata.session_id` so LiteLLM
        //      promotes it to `litellm_session_id` for per-session spend
        //      tracking and cache grouping.
        //   2. Passed to `exportCopilotMdEntry` so the `.copilotmd` file
        //      lands in the same session folder as the LiteLLM spend-log row.
        // Hoisted so the catch-block export can reuse the same value.
        let sessionFingerprint: string | undefined;

        // Check if vscode has thinking part API available.
        // Even if we are not the V2 provider, we can safely report thinking parts if the type exists.
        /************************************************
         * TODO: REMOVE IF UNUSED IN VERSION 2.3
         * REASON: Saving in the event this code is
         *       actually necessary.
         *  REMOVE BY: V2.3
         *  CONDITION: IF UNUSED/COMMENTED
         */
        /*
        const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
            | (new (
                  value: string | string[],
                  id?: string,
                  metadata?: Record<string, unknown>
              ) => vscode.LanguageModelResponsePart)
            | undefined;
*/
        /************************************************
         * End of code block
         ***********************************************/
        // Extract caller/justification from options or model tags
        const telemetry = this.getTelemetryOptions(options);
        const modelWithTags = model as vscode.LanguageModelChatInformation & { tags?: string[] };
        const caller = telemetry.caller || modelWithTags.tags?.[0] || "chat";
        const justification = telemetry.justification;

        if (this._telemetryService) {
            // We do not need the excess noise here.  But this block is useful...
            // this._telemetryService.captureFeatureUsed("chat", "chat");
            this._telemetryService.captureModelUsed(model.id, caller);
        }

        let tokensIn: number | undefined;

        Logger.info(
            `Chat request started | RequestID: ${requestId} | Model: ${model.id} | Caller: ${caller} | Justification: ${
                justification || "none"
            }`
        );
        Logger.trace(
            `Chat request: received model id="${model.id}" name="${model.name}" hasOptionsConfig=${(options as { configuration?: unknown }).configuration !== undefined}`
        );

        // <Line of Code>; // TODO: Remove by v2.3 if still commented
        // let reservedOutputTokensForRequest: number | undefined;
        // let totalTokenMaxForRequest: number | undefined;

        // Capability lookups go directly to the BackendRegistry — the single
        // source of truth. There is no per-provider mirror cache, so a stale
        // entry from a previous backend cannot be served for a different
        // backend's request.
        const modelInfo = this._registry.getModelInfo(model.id);
        // `StreamTokenCapture` uses the model id for `countTokens` heuristics
        // (tokenizer family lookup). The namespaced id breaks those heuristics,
        // so we hand it the raw model name instead.
        this._tokenCapture = new StreamTokenCapture(this.getRawModelName(model.id), progress, modelInfo);
        const tokenCapture = this._tokenCapture;
        const responsePartCollector = new ResponsePartCollector(tokenCapture.progress);
        // Re-bind `trackingProgress` to the collector's wrapped progress so every
        // downstream `sendRequestWithRetry` / `processStreamingResponse` call
        // both reports to VS Code (via tokenCapture) AND records the part for
        // the `.copilotmd` export. Single source of truth for the response body.
        const trackingProgress = responsePartCollector.progress;

        try {
            const config = await this._configManager.getConfig();

            // Optional model override (primarily for completions). If set, we try to use it.
            // If the override isn't registered yet, attempt a best-effort refresh.
            //
            // The override is a RAW model name (e.g. `azure_ai/gpt-5.4-mini`),
            // not the namespaced id. The registry is keyed by namespaced id, so
            // we use `findBackendForRawName` to resolve the override back to a
            // backend before adopting it.
            let modelToUse = model;
            if (config.modelIdOverride) {
                const overrideId = config.modelIdOverride;
                if (this._registry.findBackendForRawName(overrideId)) {
                    Logger.trace(
                        `Chat request: applying modelIdOverride overrideId="${overrideId}" originalModelId="${model.id}"`
                    );
                    // The override is reachable; we know its baseUrl/apiKey from
                    // the registry. Synthesize a minimal LanguageModelChatInformation
                    // that VS Code will accept (it only needs the id and family
                    // for downstream request building).
                    modelToUse = {
                        ...model,
                        id: overrideId,
                    };
                } else {
                    try {
                        Logger.info(`modelIdOverride set to '${overrideId}' but not registered; refreshing model list`);
                        await this.discoverModels({ silent: true }, token);
                        if (this._registry.findBackendForRawName(overrideId)) {
                            Logger.trace(
                                `Chat request: applying modelIdOverride after refresh overrideId="${overrideId}" originalModelId="${model.id}"`
                            );
                            modelToUse = { ...model, id: overrideId };
                        } else {
                            Logger.warn(
                                `modelIdOverride '${overrideId}' not found after refresh; using selected model '${model.id}'`
                            );
                        }
                    } catch (refreshErr) {
                        Logger.warn("Failed to refresh model list for override; using selected model", refreshErr);
                    }
                }
            }
            Logger.trace(
                `Chat request: modelToUse.id="${modelToUse.id}" rawModelName="${this.getRawModelName(modelToUse.id)}"`
            );

            // Resolve the backend baseUrl for the `.copilotmd` metadata `url:` line.
            // The registry is the single source of truth for (namespaced id → backend);
            // `lookup` returns undefined for raw-name overrides (modelIdOverride rewrote
            // the id), so we fall back to the vendor id string in that degenerate case.
            // Assigned to the outer `let` so the catch block can reference it when
            // rendering a failure entry. Stays undefined if lookup fails before the
            // body is built, which correctly suppresses a meaningless failure export.
            const routingEntry = this._registry.lookup(modelToUse.id);
            endpointUrl = routingEntry?.baseUrl ?? "litellm-connector";

            // Capability lookup goes directly to the BackendRegistry. The
            // `modelToUse.id` is either the namespaced id VS Code handed us
            // or, when `modelIdOverride` rewrote it, the raw model name; the
            // registry's `lookup` will return `undefined` for the raw-name
            // case and `getModelInfo` will also return `undefined` for it
            // (capabilities are stored under the namespaced key), so the
            // request builder will use the override path's defaults. This
            // is the same single-source-of-truth read as above.
            const modelInfo = this._registry.getModelInfo(modelToUse.id);
            // Compute the session fingerprint once from `messages` (the request
            // input). This is the same value used for `.copilotmd` folder
            // grouping AND for LiteLLM's `metadata.session_id` (which LiteLLM
            // promotes to `litellm_session_id` for per-session spend tracking
            // and cache grouping). Computing it here — before the body is
            // built — lets us inject it into the body in the same pass.
            // Async because the fingerprint uses SHA-256 via Web Crypto.
            sessionFingerprint = await computeSessionFingerprint(messages);
            const requestBody = await this.buildOpenAIChatRequest(messages, modelToUse, options, modelInfo, caller);
            // Inject the session fingerprint into the request body's metadata
            // so LiteLLM's proxy can group spend logs and cache entries by
            // session. LiteLLM reads `metadata.session_id` and promotes it to
            // `litellm_session_id` (see `litellm/litellm_core_utils/get_litellm_params.py`).
            // We always set this — even when `.copilotmd` export is disabled —
            // because per-session spend tracking is useful independent of the
            // debug-log export. The fingerprint is deterministic per session,
            // so all turns of one chat session share one `litellm_session_id`.
            requestBody.metadata = {
                ...(requestBody.metadata ?? {}),
                session_id: sessionFingerprint,
            };
            // Expose the built body to the outer scope so the failure/cancel
            // paths can still render a `.copilotmd` entry if the stream fails
            // after the request was shaped. Read-only alias to avoid accidental
            // mutation downstream.
            requestBodyBuilt = requestBody;
            // The model id in `modelToUse` is the namespaced `<routing>/<raw>`
            // form VS Code hands us. The tokenizer heuristics (and the
            // `isParameterSupported` / `usageOptOutModels` lookups inside the
            // request builder) key off the raw model family, not the routing
            // prefix. The request builder extracts the raw name internally
            // before populating `request.model`.
            const rawModelIdForTokenizers = this.getRawModelName(modelToUse.id);
            const estimatedTransportInputTokens =
                countOpenAIChatMessagesTokens(requestBody.messages, rawModelIdForTokenizers, modelInfo) +
                estimateToolTokens(requestBody.tools);
            const reservedOutputTokens = getReservedOutputTokens(modelToUse, requestBody.max_tokens, {
                estimatedInputTokens: estimatedTransportInputTokens,
                modelInfo,
            });
            const totalTokenMax = getTotalTokenLimit(modelToUse, modelInfo);
            // <Line of Code>; // TODO: Remove by v2.3 if still commented
            // reservedOutputTokensForRequest = reservedOutputTokens;
            // totalTokenMaxForRequest = totalTokenMax;
            tokenCapture.setEstimatedPromptTokens(estimatedTransportInputTokens);
            const systemPromptContent = requestBody.messages.find((m) => m.role === "system")?.content;
            if (typeof systemPromptContent === "string") {
                tokenCapture.setEstimatedSystemPromptTokens(
                    countTokens(systemPromptContent, rawModelIdForTokenizers, modelInfo)
                );
            }
            tokenCapture.setReservedOutputTokens(reservedOutputTokens);
            tokenCapture.setTotalTokenMax(totalTokenMax);

            // Count the actual transport request after trimming/conversion.
            tokensIn = estimatedTransportInputTokens;

            // ── Transport retry (resume-on-error) ──
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
            const accumulator = new StreamedTextAccumulator();
            const contentCounters = { sawTextPart: false, sawToolCallPart: false, sawUsagePart: false };
            const trackedProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
                report: (part) => {
                    accumulator.add(part);
                    trackingProgress.report(part);
                },
            };

            let activeMessages = messages;
            let stream: ReadableStream<Uint8Array>;
            let attempt = 0;
            let emptyAttempt = 0;
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
                    if (attempt > 0) {
                        // Resume mid-response: append the already-streamed
                        // reasoning + text as the trailing assistant message so
                        // the model continues where the socket died.
                        activeMessages = buildResumeMessages(messages, accumulator.text, accumulator.thinking);
                    }
                    // Note: sendRequestWithRetry may fully handle /responses by emitting directly to progress.
                    // In that case it returns an already-closed stream.
                    // Pass a shallow clone per attempt: the inner reasoning-effort
                    // fallback mutates request.reasoning_effort on failures, and
                    // reusing the mutated body across attempts would silently
                    // start a resumed attempt from a lowered effort.
                    stream = await this.sendRequestWithRetry(
                        attempt === 0 ? requestBody : { ...requestBody },
                        activeMessages,
                        modelToUse,
                        options,
                        trackedProgress,
                        token,
                        caller,
                        modelInfo
                    );
                    await this.processStreamingResponse(stream, trackedProgress, token, contentCounters);

                    // Flush usage data if no upstream usage was seen during streaming
                    // This ensures usage is always reported to VS Code
                    const capture = this._tokenCapture;
                    if (capture) {
                        capture.flushUsage();
                    }
                    break;
                } catch (err: unknown) {
                    // ── Reasoning-only budget (separate from transport) ──
                    if (err instanceof ReasoningOnlyError) {
                        if (emptyAttempt < maxEmptyRetries && !token.isCancellationRequested) {
                            emptyAttempt += 1;
                            const delay = backoffDelayMs(emptyAttempt, emptyBaseDelayMs);
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
                            this._tokenCapture?.resetAccumulation();
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

                    // ── Transport budget ──
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
                                err
                            );
                            StructuredLogger.error("request.transport_retry_blocked_tool_call", {
                                requestId,
                                attempt,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                        // Preserve legacy handling for non-transport errors by
                        // rethrowing into the original catch structure below.
                        if (attempt === 0) {
                            this.logRequestPayloadOnFailure(requestBody, err, {
                                stage: "provideLanguageModelChatResponse",
                                modelId: modelToUse.id,
                                caller,
                                modelInfoMode: modelInfo?.mode,
                            });
                        }
                        throw err;
                    }

                    attempt += 1;
                    const delay = backoffDelayMs(attempt, retryBaseDelayMs);
                    logTransportRetry(
                        requestId,
                        attempt,
                        maxTransportRetries,
                        err instanceof Error ? err.message : String(err),
                        accumulator.text.length
                    );
                    StructuredLogger.warn("request.transport_retry", {
                        requestId,
                        attempt,
                        maxRetries: maxTransportRetries,
                        delayMs: delay,
                        resumedTextChars: accumulator.text.length,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    // Fresh attempt: drop partial-response token accounting so
                    // the next usage snapshot reflects only the resumed stream.
                    this._tokenCapture?.resetAccumulation();
                    await sleepWithCancellation(delay, token);
                }
            }

            const snapshot = this._tokenCapture?.getSnapshot() ?? {
                promptTokens: tokensIn ?? 0,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                systemPromptTokens: 0,
                completionTokens: 0,
                reasoningTokens: 0,
                toolTokens: 0,
                acceptedPredictionTokens: 0,
                rejectedPredictionTokens: 0,
                sawUpstreamUsage: false,
            };

            // Orphaned legacy param-strip 400 retry and duplicated bottom
            // stream processing removed; the transport retry loop above now
            // owns the full send + stream lifecycle.

            const tokensOut = Math.max(snapshot.completionTokens, snapshot.toolTokens);
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
                model: modelToUse.id,
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
            this.logFinalUsageEnvelope(requestId, modelToUse.id, caller, {
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
            // config read + early return — negligible on the request hot path.
            // Never awaited: a failed/slow export must not delay the user's
            // already-streamed response.
            void exportCopilotMdEntry({
                debugName: caller,
                id: requestId.slice(0, 8),
                model: modelToUse.id,
                url: endpointUrl ?? "litellm-connector",
                maxPromptTokens: modelToUse.maxInputTokens,
                maxResponseTokens: requestBody.max_tokens,
                location: undefined,
                body: requestBody,
                requestMessages: messages,
                startTimeIso: requestStartDate.toISOString(),
                endTimeIso: new Date().toISOString(),
                durationMs: metric.durationMs,
                ourRequestId: requestId,
                timeToFirstTokenMs: undefined,
                resolvedModel: modelToUse.id,
                usage: snapshot,
                responseParts: responsePartCollector.parts,
                status: "success",
                sessionFingerprint,
            } satisfies CopilotMdEntry);

            // Usage data is now handled exclusively by StreamTokenCapture
            // which intercepts usage DataParts during streaming and enriches them
            // No need for separate emitExperimentalUsageData call

            // Disabling this to reduce noise / unecessary logging
            // TODO: look into potentially removing this in the future if don't need it.
            /*
            if (this._telemetryService) {
                this._telemetryService.captureChatRequest({
                    request_id: requestId,
                    caller,
                    model: modelToUse.id,
                    endpoint: modelInfo?.mode ?? "chat",
                    durationMs: metric.durationMs,
                    tokensIn: tokensIn ?? 0,
                    tokensOut,
                    status: "success",
                });
            }
            */
        } catch (err: unknown) {
            let errorMessage = err instanceof Error ? err.message : String(err);
            const errorStack = err instanceof Error ? err.stack : undefined;
            const errorName = err instanceof Error ? err.constructor.name : typeof err;

            if (errorMessage.includes("LiteLLM API error")) {
                const statusMatch = errorMessage.match(/error: (\d+)/);
                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                const errorParts = errorMessage.split("\n");
                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
                const parsedMessage = this.parseApiError(statusCode, errorText);
                errorMessage = `LiteLLM Error (${model.id}): ${parsedMessage}`;
                if (
                    parsedMessage.toLowerCase().includes("temperature") ||
                    parsedMessage.toLowerCase().includes("unsupported value")
                ) {
                    errorMessage +=
                        ". This model may not support certain parameters like temperature. Please check your model settings.";
                }
            }
            // Node.js wraps network failures (ECONNREFUSED, DNS errors) as
            // "TypeError: fetch failed" without surfacing the root cause in
            // the error message. Extract the chained `.cause` so operators
            // see the real reason (e.g. ECONNREFUSED) rather than a generic label.
            const rootCause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;

            // Log full error details to both Logger and StructuredLogger
            Logger.error("Chat request failed", err);
            StructuredLogger.error("request.failed", {
                requestId,
                model: model.id,
                caller,
                errorName,
                errorMessage,
                errorStack,
                rootCause,
                stage: "provideLanguageModelChatResponse",
            });

            const metric = {
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                status: "failure" as const,
                error: errorMessage,
                caller,
            };
            LiteLLMTelemetry.reportMetric(metric);

            if (this._telemetryService) {
                this._telemetryService.captureChatRequest({
                    request_id: requestId,
                    caller,
                    model: model.id,
                    endpoint: "unknown",
                    durationMs: metric.durationMs,
                    tokensIn: tokensIn ?? 0,
                    tokensOut: 0,
                    status: "failure",
                    error: errorMessage,
                    stack: err instanceof Error ? err.stack : undefined,
                });
            }

            // Fire-and-forget `.copilotmd` export for the failure case. Only
            // emits when the request got far enough to have a built body — a
            // failure before `buildOpenAIChatRequest` (e.g. config error) has
            // nothing meaningful to render and is skipped.
            if (requestBodyBuilt && endpointUrl) {
                void exportCopilotMdEntry({
                    debugName: caller,
                    id: requestId.slice(0, 8),
                    model: model.id,
                    url: endpointUrl ?? "litellm-connector",
                    maxPromptTokens: model.maxInputTokens,
                    maxResponseTokens: requestBodyBuilt.max_tokens,
                    location: undefined,
                    body: requestBodyBuilt,
                    requestMessages: messages,
                    startTimeIso: requestStartDate.toISOString(),
                    endTimeIso: new Date().toISOString(),
                    durationMs: metric.durationMs,
                    ourRequestId: requestId,
                    timeToFirstTokenMs: undefined,
                    resolvedModel: model.id,
                    usage: this._tokenCapture?.getSnapshot() ?? {
                        promptTokens: tokensIn ?? 0,
                        cachedTokens: 0,
                        cacheCreationInputTokens: 0,
                        systemPromptTokens: 0,
                        completionTokens: 0,
                        reasoningTokens: 0,
                        toolTokens: 0,
                        acceptedPredictionTokens: 0,
                        rejectedPredictionTokens: 0,
                        sawUpstreamUsage: false,
                    },
                    responseParts: responsePartCollector.parts,
                    status: "failure",
                    statusReason: errorMessage,
                    sessionFingerprint,
                } satisfies CopilotMdEntry);
            }

            throw new Error(errorMessage, { cause: err });
        }
    }

    protected resetStreamingState(): void {
        // Reset the streaming buffers (tool call state)
        // but NOT _tokenCapture, which is needed for usage reporting after the stream ends
        this._streamingState = createInitialStreamingState();
    }

    protected clearAllStreamingState(): void {
        // Complete reset including token capture (used only when aborting/cancelling)
        this._streamingState = createInitialStreamingState();
        this._tokenCapture = undefined;
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
        contentCounters?: { sawTextPart: boolean; sawToolCallPart: boolean; sawUsagePart: boolean }
    ): Promise<void> {
        Logger.info(`[processStreamingResponse] Starting stream processing`);
        StructuredLogger.info("stream.processing_start", {
            timestamp: new Date().toISOString(),
        });

        const config = await this._configManager.getConfig();
        const timeoutMs = (config.inactivityTimeout ?? 60) * 1000;
        let watchdog: NodeJS.Timeout | undefined;
        let eventCount = 0;
        let wasWatchdogAbort = false;
        // Content tracking for the reasoning-only detection: a cleanly-completed
        // stream whose ONLY emissions were thinking parts is not a success for
        // the agent loop (VS Code renders "no response was returned").
        let sawTextPart = false;
        let sawToolCallPart = false;
        let sawUsagePart = false;

        // Create an AbortController to actually cancel the stream on timeout
        const controller = new AbortController();

        const resetWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                Logger.warn(
                    `[processStreamingResponse] Inactivity timeout after ${timeoutMs}ms (after ${eventCount} events)`
                );
                StructuredLogger.warn("stream.inactivity_timeout", {
                    timeoutMs,
                    eventCount,
                });
                wasWatchdogAbort = true;
                controller.abort();
            }, timeoutMs);
        };

        token.onCancellationRequested(() => {
            Logger.debug(`[processStreamingResponse] Cancellation requested from VS Code`);
            StructuredLogger.debug("stream.cancellation_requested", {
                eventCount,
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

                Logger.trace(`[processStreamingResponse] Event #${eventCount} payload: ${payload.slice(0, 150)}`);

                const jsonResult = tryParseJSONObject(payload);
                if (!jsonResult.ok) {
                    Logger.trace(`[processStreamingResponse] Event #${eventCount}: Skipped (JSON parse failed)`);
                    StructuredLogger.trace("stream.event_parse_skipped", {
                        eventNumber: eventCount,
                        payloadPreview: payload.slice(0, 150),
                    });
                    continue;
                }
                const json = jsonResult.value;

                // Ensure streaming state is initialized (e.g. if processStreamingResponse is called directly in tests)
                if (!this._streamingState) {
                    Logger.trace(`[processStreamingResponse] Initializing streaming state on first event`);
                    this.resetStreamingState();
                }

                Logger.trace(`[processStreamingResponse] Event #${eventCount}: Interpreting event`);
                const parts = interpretStreamEvent(json, this._streamingState);
                Logger.trace(
                    `[processStreamingResponse] Event #${eventCount}: Got ${parts.length} parts, emitting to VS Code`
                );
                StructuredLogger.trace("stream.event_processed", {
                    eventNumber: eventCount,
                    partCount: parts.length,
                });
                for (const part of parts) {
                    if (part.type === "text") {
                        sawTextPart = true;
                        if (contentCounters) {
                            contentCounters.sawTextPart = true;
                        }
                    } else if (part.type === "tool_call") {
                        sawToolCallPart = true;
                        if (contentCounters) {
                            contentCounters.sawToolCallPart = true;
                        }
                    } else if (part.type === "data" && part.mimeType === "usage") {
                        sawUsagePart = true;
                        if (contentCounters) {
                            contentCounters.sawUsagePart = true;
                        }
                    }
                }
                emitPartsToVSCode(parts, progress);
            }

            Logger.info(`[processStreamingResponse] Stream loop completed after ${eventCount} events`);
            StructuredLogger.info("stream.processing_complete", {
                eventCount,
                reason: "stream_ended",
            });

            // Reasoning-only detection: a cleanly-completed stream that emitted
            // ONLY thinking parts (plus perhaps a usage data part) contains
            // nothing the agent loop can act on. VS Code renders it as
            // "no response was returned" and kills the turn. Surface it to the
            // retry loop as resumable: the partial reasoning is appended to the
            // request so the model continues its thought.
            if (eventCount > 0 && !sawTextPart && !sawToolCallPart) {
                Logger.warn(
                    `[processStreamingResponse] Reasoning-only stream detected (${eventCount} events, ` +
                        `no text/tool parts); surfacing as resumable empty-content error`
                );
                StructuredLogger.warn("stream.reasoning_only_response", {
                    eventCount,
                    sawUsagePart,
                });
                throw new ReasoningOnlyError(eventCount, 0);
            }
        } catch (error: unknown) {
            Logger.error(`[processStreamingResponse] Stream processing failed after ${eventCount} events`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            StructuredLogger.error("stream.process_failed", {
                error: error instanceof Error ? error.message : String(error),
                eventCount,
                stack: error instanceof Error ? error.stack : undefined,
            });

            // Tier 2: Attempt recovery by flushing pending tool calls on stream error
            const isStreamEndError =
                error instanceof Error &&
                (error.message.includes("Stream ended before [DONE] marker") ||
                    error.message.includes("stream ended") ||
                    error.message.includes("unexpected end"));

            if (isStreamEndError && this._streamingState && eventCount > 0) {
                Logger.info(
                    `[processStreamingResponse] Attempting recovery: flushing ${eventCount} buffered tool calls`
                );
                StructuredLogger.info("stream.recovery_attempt", {
                    reason: "stream_incomplete",
                    eventCount,
                    hasBufferedCalls:
                        this._streamingState.responseToolCallBuffers.size > 0 ||
                        this._streamingState.toolCallBuffers.size > 0,
                });

                try {
                    // Flush all pending buffers and emit them
                    const recoveredParts = flushPendingBuffers(this._streamingState);
                    // recoveredParts includes at least the finish part, so check length > 1
                    if (recoveredParts.length > 1) {
                        // -1 because last part is finish
                        Logger.debug(
                            `[processStreamingResponse] Recovery emitted ${recoveredParts.length - 1} buffered tool calls`
                        );
                        emitPartsToVSCode(recoveredParts, progress);
                        StructuredLogger.info("stream.recovery_success", {
                            toolCallsFlushed: recoveredParts.filter((p) => p.type === "tool_call").length,
                        });
                        // Don't re-throw after successful recovery - partial response is better than hard failure
                        return;
                    } else {
                        // No recoverable parts (empty stream), let error through
                        Logger.debug(
                            `[processStreamingResponse] No buffered tool calls to recover (${eventCount} events but empty buffers)`
                        );
                    }
                } catch (recoveryErr) {
                    Logger.warn(
                        `[processStreamingResponse] Recovery failed: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`
                    );
                    StructuredLogger.warn("stream.recovery_failed", {
                        originalError: error instanceof Error ? error.message : String(error),
                        recoveryError: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
                    });
                }
            }

            // A watchdog abort ends the stream without a transport exception.
            // Re-throw it as the retryable sentinel so the transport-retry loop
            // in provideLanguageModelChatResponse can resume the response.
            if (wasWatchdogAbort) {
                throw new InactivityTimeoutError(timeoutMs, eventCount);
            }

            throw error;
        } finally {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            Logger.debug(`[processStreamingResponse] Clearing streaming state (eventCount=${eventCount})`);
            StructuredLogger.debug("stream.state_cleared", {
                eventCount,
            });
            // Always reset streaming state on stream completion (success or error)
            // to prevent stale buffers from corrupting subsequent requests
            this.resetStreamingState();
        }
    }

    private stripControlTokens(text: string): string {
        return text
            .replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
            .replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
    }
}
