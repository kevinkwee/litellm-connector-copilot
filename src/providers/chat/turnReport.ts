import type { LanguageModelResponsePart, Progress } from "vscode";
import { LanguageModelTextPart } from "vscode";

import { formatConnectorNotice } from "../../utils/connectorNotice";
import { Logger } from "../../utils/logger";
import { appendRateLimitHint } from "../../utils/rateLimitNotice";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { StructuredLogger } from "../../observability/structuredLogger";
import { logFinalUsageEnvelope } from "../../observability/finalUsageEnvelope";
import {
    findRejectedParameter,
    isUnsupportedParameterError,
    LiteLLMApiError,
    LiteLLMRateLimitError,
} from "../../adapters/litellmClient";
import type { TokenSnapshot } from "../../adapters/streaming/streamTokenCapture";
import { describeFailureForLog, toErrorLogFields } from "../base/errorLogFields";
import { parseApiError } from "../base/apiErrorMessage";
import { exportRequestOutcome, recordCancelledTurn, type RequestOutcomeContext } from "../base/requestOutcome";

/** What every outcome of one chat turn reports. */
interface TurnReportBase {
    readonly requestId: string;
    readonly modelId: string;
    readonly caller: string;
    readonly durationMs: number;
    readonly tokensIn: number | undefined;
    readonly outcomeContext: () => RequestOutcomeContext;
}

/** A turn the model finished. */
export interface SuccessfulTurnReport extends TurnReportBase {
    readonly snapshot: TokenSnapshot;
    readonly reservedOutputTokens: number;
    readonly totalTokenMax: number;
}

/** A turn the user cancelled from the connector's cancel command. */
export interface ConnectorCancelledTurnReport extends TurnReportBase {
    readonly responsePartCount: number;
}

/** A turn the host cancelled, which the caller reports by throwing. */
export type HostCancelledTurnReport = TurnReportBase;

/** A turn that ended in failure. */
export interface FailedTurnReport extends TurnReportBase {
    readonly error: unknown;
    readonly progress: Progress<LanguageModelResponsePart>;
}

/**
 * Reports a finished turn: the metric the output channel prints, the final usage
 * line, and the transcript entry.
 */
export function reportTurnSuccess(report: SuccessfulTurnReport): void {
    const { snapshot } = report;
    const tokensOut = snapshot.outputTokens;
    const tokensIn = snapshot.promptTokens ?? report.tokensIn;
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

    LiteLLMTelemetry.reportMetric({
        requestId: report.requestId,
        model: report.modelId,
        durationMs: report.durationMs,
        tokensIn,
        tokensOut,
        promptCacheTokens: cachedTokens,
        cacheCreationInputTokens,
        reasoningTokens,
        toolTokens,
        acceptedPredictionTokens,
        rejectedPredictionTokens,
        reservedOutputTokens: report.reservedOutputTokens,
        totalTokenMax: report.totalTokenMax,
        estimatedInputCost,
        estimatedOutputCost,
        estimatedTotalCost,
        status: "success",
        caller: report.caller,
        cacheReadRatio: cachedTokens !== undefined && tokensIn ? cachedTokens / tokensIn : undefined,
    });
    logFinalUsageEnvelope(report.requestId, report.modelId, report.caller, {
        tokensIn,
        tokensOut,
        cachedTokens,
        cacheCreationInputTokens,
        reasoningTokens,
        toolTokens,
        acceptedPredictionTokens,
        rejectedPredictionTokens,
        systemPromptTokens,
        reservedOutputTokens: report.reservedOutputTokens,
        totalTokenMax: report.totalTokenMax,
        sawUsageDataPart: snapshot.sawUpstreamUsage,
        estimatedInputCost,
        estimatedOutputCost,
        estimatedTotalCost,
    });

    exportRequestOutcome(report.outcomeContext(), { status: "success", durationMs: report.durationMs });
}

/**
 * Records a turn the user cancelled from the connector's cancel command.
 *
 * Cancellation is not a failure: the turn closes with a notice, so the metric and
 * the transcript record a cancelled turn rather than a failed one.
 */
export function reportConnectorCancellation(report: ConnectorCancelledTurnReport): void {
    StructuredLogger.info("request.cancelled_by_connector", {
        requestId: report.requestId,
        model: report.modelId,
        caller: report.caller,
        stage: "provideLanguageModelChatResponse",
        responseParts: report.responsePartCount,
    });
    Logger.info(
        `Chat request cancelled from the connector | RequestID: ${report.requestId} | Model: ${report.modelId} | Caller: ${report.caller}`
    );
    recordCancelledTurn(report.outcomeContext(), {
        tokensIn: report.tokensIn,
        durationMs: report.durationMs,
        statusReason: "Cancelled from the LiteLLM connector",
    });
}

/**
 * Records a turn the host cancelled.
 *
 * The caller throws afterwards, because VS Code renders its own cancelled state
 * from that error rather than from anything reported here.
 */
export function reportHostCancellation(report: HostCancelledTurnReport): void {
    Logger.info(
        `Chat request cancelled | RequestID: ${report.requestId} | Model: ${report.modelId} | Caller: ${report.caller}`
    );
    StructuredLogger.info("request.cancelled", {
        requestId: report.requestId,
        model: report.modelId,
        caller: report.caller,
        stage: "provideLanguageModelChatResponse",
    });
    recordCancelledTurn(report.outcomeContext(), {
        tokensIn: report.tokensIn,
        durationMs: report.durationMs,
        statusReason: "Cancelled by the user",
    });
}

/**
 * Turns a failure into the text the user reads in the turn.
 *
 * An upstream rejection is parsed and, where the rejection names a fix the user can
 * apply in the proxy's model config, the fix is appended. Anything else is reported
 * as it came.
 */
export function describeTurnFailure(error: unknown, modelId: string): string {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (!rawMessage.includes("LiteLLM API error")) {
        return rawMessage;
    }

    const statusMatch = rawMessage.match(/error: (\d+)/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
    const errorParts = rawMessage.split("\n");
    const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
    const parsedMessage = parseApiError(statusCode, errorText);
    let message = `LiteLLM Error (${modelId}): ${parsedMessage}`;

    const rejectionBody = error instanceof LiteLLMApiError ? error.bodyText : errorText;
    if (error instanceof LiteLLMRateLimitError) {
        return appendRateLimitHint(message, error.failure);
    }
    if (isUnsupportedParameterError(rejectionBody)) {
        // Resending the identical body would fail the same way, so the rejection is
        // reported once with the proxy-side fix. Only parameters the connector adds
        // itself are ever stripped.
        const rejectedParameter = findRejectedParameter(rejectionBody);
        const subject = rejectedParameter ? `"${rejectedParameter}"` : "a model parameter";
        message +=
            `. The proxy rejected ${subject}: drop it there with additional_drop_params ` +
            `or drop_params in the LiteLLM model config, then reload the models.`;
    } else if (
        parsedMessage.toLowerCase().includes("temperature") ||
        parsedMessage.toLowerCase().includes("unsupported value")
    ) {
        message +=
            ". This model may not support certain parameters like temperature. Please check your model settings.";
    }
    return message;
}

/**
 * Reports a failed turn and closes it with a connector notice instead of throwing.
 *
 * The Agents window handler answers a thrown error with a 502 and discards the parts
 * already reported, which would lose everything the model said this turn. Reporting
 * the notice as an assistant text part keeps the partial answer in the conversation,
 * and the turn reaches the SDK as an ordinary reply.
 */
export function reportTurnFailure(report: FailedTurnReport): void {
    // Log identifiers only: the message stays in the user-facing notice and the
    // opt-in transcript, where an echoed prompt is acceptable.
    const errorLogFields = toErrorLogFields(report.error);
    Logger.error(`Chat request failed | RequestID: ${report.requestId} | Model: ${report.modelId}`, errorLogFields);
    StructuredLogger.error("request.failed", {
        requestId: report.requestId,
        model: report.modelId,
        caller: report.caller,
        stage: "provideLanguageModelChatResponse",
        ...errorLogFields,
    });

    LiteLLMTelemetry.reportMetric({
        requestId: report.requestId,
        model: report.modelId,
        durationMs: report.durationMs,
        tokensIn: report.tokensIn,
        status: "failure",
        error: describeFailureForLog(report.error),
        caller: report.caller,
    });

    const message = describeTurnFailure(report.error, report.modelId);
    // A failure before the body exists has nothing to render, which the context
    // reports by leaving the body undefined.
    exportRequestOutcome(report.outcomeContext(), {
        status: "failure",
        durationMs: report.durationMs,
        statusReason: message,
    });

    report.progress.report(new LanguageModelTextPart(`\n\n${formatConnectorNotice(message)}`));
    // The reply now looks like model output, so record that it was a failure notice
    // and which initiator triggered it.
    Logger.warn(`Chat request surfaced as assistant error text instead of throwing | RequestID: ${report.requestId}`);
    StructuredLogger.warn("request.error_surfaced_as_text", {
        requestId: report.requestId,
        model: report.modelId,
        caller: report.caller,
        stage: "provideLanguageModelChatResponse",
        ...errorLogFields,
    });
}
