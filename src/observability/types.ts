/**
 * Type definitions for the observability layer.
 *
 * These types define the structured logging, telemetry, and auditing contracts
 * used throughout the provider request pipeline.
 */

/**
 * Log levels in order of verbosity.
 * - trace: Full payloads, raw SSE frames, detailed parameter maps, hook context snapshots
 * - debug: Detailed flow information, endpoint selection decisions, parameter filtering outcomes
 * - info: High-level lifecycle events, request ingress, completion status, token totals
 * - warn: Recoverable issues, parameter suppression, endpoint fallback, trimming near limits
 * - error: Failures and exceptions, request failures, unhandled errors, quota exhaustion
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * Event types for structured JSONL logging.
 */
export type EventType =
    | "request.ingress"
    | "request.complete"
    | "request.error"
    | "endpoint.selected"
    | "endpoint.fallback"
    | "param.suppressed"
    | "param.added"
    | "trim.executed"
    | "trim.skipped"
    | "tool.called"
    | "tool.redacted"
    | "hook.invoked"
    | "stream.chunk"
    | "stream.complete"
    | "token.count"
    | "config.loaded"
    | "model.discovered"
    | "cache.hit"
    | "cache.miss";

/**
 * Structured JSONL event entry.
 */
export interface LogEvent {
    /** ISO 8601 timestamp */
    timestamp: string;
    /** Stable request ID for correlation */
    requestId: string;
    /** Log level */
    level: LogLevel;
    /** Event type */
    event: EventType;
    /** Event-specific payload */
    data: Record<string, unknown>;
    /** Model ID (if applicable) */
    model?: string;
    /** Endpoint path (if applicable) */
    endpoint?: string;
    /** Caller context (e.g., "inline-completions", "terminal-chat", "chat") */
    caller?: string;
}

/**
 * Audit summary for a completed request.
 */
export interface AuditSummary {
    /** Stable request ID */
    requestId: string;
    /** Model ID */
    modelId: string;
    /** Endpoint used */
    endpoint: string;
    /** Caller context */
    caller: string;
    /** Total duration in milliseconds */
    durationMs: number;
    /** Input token count */
    tokensIn?: number;
    /** Output token count */
    tokensOut?: number;
    /** Total message count */
    messageCount: number;
    /** Tool calls made */
    toolCalls: string[];
    /** Errors encountered */
    errors: string[];
    /** Warnings encountered */
    warnings: string[];
    /** All events for this request */
    events: LogEvent[];
}
