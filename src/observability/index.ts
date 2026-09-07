/**
 * Observability layer for the provider request pipeline.
 *
 * Provides structured JSONL logging, lifecycle hooks, audit trails,
 * and telemetry for end-to-end request visibility.
 */

export { StructuredLogger } from "./structuredLogger";
export { HookSystem } from "./hookSystem";
export { AuditTrail } from "./auditTrail";
export type {
    LogLevel,
    EventType,
    LogEvent,
    HookPoint,
    HookContext,
    HookHandler,
    AuditSummary,
    TelemetryMetric,
} from "./types";

// `.copilotmd` request-log export — byte-compatible with VS Code Copilot's
// Chat Debug View export format. See `copilotMdRenderer.ts` for the format
// reference and `litellm-connector-copilot-chat-debug-view.md` repo memory
// for the upstream trace.
export { renderCopilotMd, buildCopilotMdFilename, computeSessionFingerprint } from "./copilotMdRenderer";
export type { CopilotMdEntry } from "./copilotMdRenderer";
export { selectFilesForDeletion } from "./copilotMdCaps";
export type { CapsConfig, FileMeta } from "./copilotMdCaps";
export { CopilotMdWriter } from "./copilotMdWriter";
export { CopilotMdManager, exportCopilotMdEntry } from "./copilotMdManager";
export type { CopilotMdDestination, CopilotMdSettings } from "./copilotMdManager";
export { ResponsePartCollector } from "./responsePartCollector";
