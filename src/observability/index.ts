/**
 * Observability layer for the provider request pipeline.
 *
 * Provides structured JSONL logging, audit trails, and the `.copilotmd`
 * request-log export for end-to-end request visibility.
 */

export { StructuredLogger } from "./structuredLogger";
export { AuditTrail } from "./auditTrail";
export type { LogLevel, EventType, LogEvent, AuditSummary } from "./types";

// `.copilotmd` request-log export, byte-compatible with VS Code Copilot's
// Chat Debug View export format. See `copilotMdRenderer.ts` for the format
// reference.
export { renderCopilotMd, buildCopilotMdFilename, computeSessionFingerprint } from "./copilotMdRenderer";
export type { CopilotMdEntry } from "./copilotMdRenderer";
export { selectFilesForDeletion } from "./copilotMdCaps";
export type { CapsConfig, FileMeta } from "./copilotMdCaps";
export { CopilotMdWriter } from "./copilotMdWriter";
export { CopilotMdManager, exportCopilotMdEntry } from "./copilotMdManager";
export type { CopilotMdDestination, CopilotMdSettings } from "./copilotMdManager";
export { ResponsePartCollector } from "./responsePartCollector";
