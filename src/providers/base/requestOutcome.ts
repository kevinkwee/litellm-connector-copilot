import type * as vscode from "vscode";
import type { TokenSnapshot } from "../../adapters/streaming/streamTokenCapture";
import type { OpenAIChatCompletionRequest } from "../../types";
import type { ChatSessionIdSource } from "../../utils/chatSessionId";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { buildUsageReportFields, logUsageTotals, toUsageMetricFields } from "./usageReport";
import { exportCopilotMdEntry, type CopilotMdEntry } from "../../observability";

/** The request facts shared by every outcome report. */
export interface RequestOutcomeContext {
    readonly requestId: string;
    readonly model: { readonly id: string; readonly maxInputTokens: number };
    readonly caller: string;
    /** `undefined` before routing resolves, which suppresses the export. */
    readonly endpointUrl: string | undefined;
    /** `undefined` before the body exists, which suppresses the export. */
    readonly requestBodyBuilt: OpenAIChatCompletionRequest | undefined;
    readonly activeMessages: readonly vscode.LanguageModelChatRequestMessage[];
    readonly requestStartDate: Date;
    /** The request totals, summing every attempt a retry replaced. */
    readonly usage: TokenSnapshot;
    readonly responseParts: readonly vscode.LanguageModelResponsePart[];
    readonly sessionId: string;
    readonly sessionIdSource: ChatSessionIdSource;
}

/** Outcome-specific fields of one `.copilotmd` entry. */
export interface RequestOutcome {
    readonly status: CopilotMdEntry["status"];
    readonly durationMs: number;
    readonly statusReason?: string;
}

/**
 * Writes the `.copilotmd` entry for a finished request, fire and forget.
 *
 * Nothing is written before the request has a body: there would be no request to
 * render. The export is never awaited, so a slow or failing write cannot delay a
 * response the user has already received.
 */
export function exportRequestOutcome(context: RequestOutcomeContext, outcome: RequestOutcome): void {
    if (!context.requestBodyBuilt || !context.endpointUrl) {
        return;
    }
    void exportCopilotMdEntry({
        debugName: context.caller,
        id: context.requestId.slice(0, 8),
        model: context.model.id,
        url: context.endpointUrl,
        maxPromptTokens: context.model.maxInputTokens,
        maxResponseTokens: context.requestBodyBuilt.max_tokens,
        location: undefined,
        body: context.requestBodyBuilt,
        requestMessages: context.activeMessages,
        startTimeIso: context.requestStartDate.toISOString(),
        endTimeIso: new Date().toISOString(),
        durationMs: outcome.durationMs,
        ourRequestId: context.requestId,
        timeToFirstTokenMs: undefined,
        resolvedModel: context.model.id,
        usage: context.usage,
        responseParts: context.responseParts,
        status: outcome.status,
        ...(outcome.statusReason === undefined ? {} : { statusReason: outcome.statusReason }),
        sessionId: context.sessionId,
        sessionIdSource: context.sessionIdSource,
    } satisfies CopilotMdEntry);
}

/**
 * Records a cancelled turn in telemetry and in the transcript.
 *
 * Every cancellation origin records through here, so the metric and the
 * transcript always agree. The origins differ only in the reason they pass.
 */
export function recordCancelledTurn(
    context: RequestOutcomeContext,
    options: { durationMs: number; statusReason: string }
): void {
    const fields = buildUsageReportFields(context.usage);
    LiteLLMTelemetry.reportMetric({
        requestId: context.requestId,
        model: context.model.id,
        durationMs: options.durationMs,
        ...toUsageMetricFields(fields),
        status: "cancelled",
        caller: context.caller,
    });
    logUsageTotals(context.requestId, context.model.id, context.caller, fields, context.usage.sawUpstreamUsage);
    exportRequestOutcome(context, {
        status: "canceled",
        durationMs: options.durationMs,
        statusReason: options.statusReason,
    });
}
