import type { LanguageModelResponsePart, Progress } from "vscode";
import { LanguageModelTextPart } from "vscode";

import { formatConnectorNotice } from "../../utils/connectorNotice";
import { Logger } from "../../utils/logger";
import { appendRateLimitHint } from "../../utils/rateLimitNotice";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { StructuredLogger } from "../../observability/structuredLogger";
import {
    findRejectedParameter,
    isUnsupportedParameterError,
    LiteLLMApiError,
    LiteLLMRateLimitError,
} from "../../adapters/litellmClient";
import { describeFailureForLog, toErrorLogFields } from "../base/errorLogFields";
import { parseApiError } from "../base/apiErrorMessage";
import { exportRequestOutcome, recordCancelledTurn, type RequestOutcomeContext } from "../base/requestOutcome";
import { isReasoningEffortRejection, rejectsReasoningEffortParameter } from "../base/proxyParameterRejection";
import { buildUsageReportFields, logUsageTotals, toUsageMetricFields } from "../base/usageReport";

/** What every outcome of one chat turn reports. */
interface TurnReportBase {
    readonly requestId: string;
    readonly modelId: string;
    readonly caller: string;
    readonly durationMs: number;
    readonly outcomeContext: () => RequestOutcomeContext;
}

/** A turn the model finished. */
export interface SuccessfulTurnReport extends TurnReportBase {
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
    // One read of the request totals backs the metric, the final usage line and the transcript.
    const outcomeContext = report.outcomeContext();
    const fields = buildUsageReportFields(outcomeContext.usage);

    LiteLLMTelemetry.reportMetric({
        requestId: report.requestId,
        model: report.modelId,
        durationMs: report.durationMs,
        ...toUsageMetricFields(fields),
        reservedOutputTokens: report.reservedOutputTokens,
        totalTokenMax: report.totalTokenMax,
        status: "success",
        caller: report.caller,
    });
    logUsageTotals(report.requestId, report.modelId, report.caller, fields, outcomeContext.usage.sawUpstreamUsage, {
        reservedOutputTokens: report.reservedOutputTokens,
        totalTokenMax: report.totalTokenMax,
    });

    exportRequestOutcome(outcomeContext, { status: "success", durationMs: report.durationMs });
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
        durationMs: report.durationMs,
        statusReason: "Cancelled by the user",
    });
}

/**
 * True when the body names a rejected parameter that is not the reasoning effort.
 *
 * `isReasoningEffortRejection` matches its two halves independently, so a body that
 * echoes the effort name beside a genuine rejection of another parameter satisfies
 * it. The specific parameter is the better explanation, so it wins.
 */
function namesAnotherParameter(rejectionBody: string): boolean {
    return findRejectedParameter(rejectionBody) !== undefined && !rejectsReasoningEffortParameter(rejectionBody);
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
    if (isReasoningEffortRejection(rejectionBody) && !namesAnotherParameter(rejectionBody)) {
        // Dropping the effort at the proxy would leave the picker offering levels that
        // are silently discarded, so the notice points at the configuration the picker
        // reads. A proxy-written refusal names a parameter it never forwarded and already
        // recommends its own fix; an upstream refusal means LiteLLM did forward it, so the
        // parameter has to stop being sent at all.
        const refusedByProxy = /UnsupportedParamsError|does not support parameters/i.test(rejectionBody);
        message += rejectsReasoningEffortParameter(rejectionBody)
            ? refusedByProxy
                ? `. The proxy does not list reasoning_effort for this deployment, so no level reaches the ` +
                  `model. Add allowed_openai_params: ["reasoning_effort"] to its litellm_params and run Reload ` +
                  `Models; if the upstream itself refuses the parameter, set supports_reasoning: false and its ` +
                  `supports_<level>_reasoning_effort entries to false instead.`
                : `. The upstream refused the reasoning_effort parameter, so no level will be accepted. Set ` +
                  `supports_reasoning: false and its supports_<level>_reasoning_effort entries to false in the ` +
                  `LiteLLM model config, then run Reload Models.`
            : `. This model rejected its reasoning effort. Declare exactly the levels it accepts with ` +
              `supports_<level>_reasoning_effort: true in the LiteLLM model config (a reasoning model ` +
              `with no level flags and no override is offered every level, none to max), or list them ` +
              `in a modelOverrides forceMandatory entry, then run Reload Models.`;
    } else if (isUnsupportedParameterError(rejectionBody)) {
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

    const outcomeContext = report.outcomeContext();
    const fields = buildUsageReportFields(outcomeContext.usage);
    LiteLLMTelemetry.reportMetric({
        requestId: report.requestId,
        model: report.modelId,
        durationMs: report.durationMs,
        ...toUsageMetricFields(fields),
        status: "failure",
        error: describeFailureForLog(report.error),
        caller: report.caller,
    });
    logUsageTotals(report.requestId, report.modelId, report.caller, fields, outcomeContext.usage.sawUpstreamUsage);

    const message = describeTurnFailure(report.error, report.modelId);
    // A failure before the body exists has nothing to render, which the context
    // reports by leaving the body undefined.
    exportRequestOutcome(outcomeContext, {
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
