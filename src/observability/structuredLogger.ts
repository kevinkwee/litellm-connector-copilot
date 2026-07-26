import * as vscode from "vscode";
import type { LogLevel, LogEvent, EventType } from "./types";

/**
 * Maps our string `LogLevel` to the numeric `vscode.LogLevel` enum so we can
 * compare against the channel's runtime `logLevel` property.
 *
 * `vscode.LogLevel`: Off=0, Trace=1, Debug=2, Info=3, Warning=4, Error=5.
 * A message at level L is logged only when `channel.logLevel <= L` (the
 * channel is configured to show that level or more verbose).
 */
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
    trace: vscode.LogLevel.Trace,
    debug: vscode.LogLevel.Debug,
    info: vscode.LogLevel.Info,
    warn: vscode.LogLevel.Warning,
    error: vscode.LogLevel.Error,
};

/**
 * Returns true if a message at the given `LogLevel` should be skipped
 * because the channel's configured log level is above it (less verbose).
 *
 * Only gates `trace` and `debug` — the streaming hot path fires dozens of
 * trace calls per SSE event, and building then discarding the LogEvent +
 * JSON.stringify on every event caused observable CPU spikes and GC
 * pressure during long chat responses. `info`/`warn`/`error` are NOT gated
 * here: they are infrequent and important for diagnostics, and VS Code's
 * own channel methods already silently drop them when the level is too
 * high, so the wasted work is negligible.
 *
 * When `channel.logLevel` is `undefined` (e.g. a test stub that didn't set
 * it, or a pre-initialize call), we return false — never silently drop
 * diagnostic output when we can't confirm it should be dropped.
 */
function shouldSkipForLevel(channel: vscode.LogOutputChannel, level: LogLevel): boolean {
    if (level !== "trace" && level !== "debug") {
        return false;
    }
    const channelLevel = channel.logLevel;
    if (typeof channelLevel !== "number") {
        return false;
    }
    // channelLevel === Off (0) means "log nothing" — skip everything we gate.
    if (channelLevel === vscode.LogLevel.Off) {
        return true;
    }
    return channelLevel > LOG_LEVEL_RANK[level];
}

/**
 * Structured JSONL logger for the v2 provider baseline.
 *
 * Outputs one JSON object per line for parseability by standard tools (jq, etc.).
 * Log level filtering is handled by VS Code's LogOutputChannel UI (the dropdown
 * in the output panel). All logs are sent to the channel; the channel decides
 * what to display based on the user-selected level.
 *
 * Log levels:
 * - trace: Full payloads, raw SSE frames, detailed parameter maps, hook context snapshots
 * - debug: Detailed flow information, endpoint selection decisions, parameter filtering outcomes
 * - info: High-level lifecycle events, request ingress, completion status, token totals
 * - warn: Recoverable issues, parameter suppression, endpoint fallback, trimming near limits
 * - error: Failures and exceptions, request failures, unhandled errors, quota exhaustion
 */
export class StructuredLogger {
    private static channel: vscode.LogOutputChannel | undefined;

    /**
     * Ensures the structured output channel exists.
     *
     * This allows logging from unit tests and helper modules that execute before
     * extension activation calls {@link initialize}. When context is available,
     * the channel is registered for disposal on deactivation.
     */
    private static ensureChannel(context?: vscode.ExtensionContext): vscode.LogOutputChannel {
        if (!this.channel) {
            this.channel = vscode.window.createOutputChannel("LiteLLM Structured", { log: true });
            context?.subscriptions.push(this.channel);
        }
        return this.channel;
    }

    /**
     * Initializes the structured logger with a VS Code output channel.
     *
     * @param context - VS Code extension context for subscription management
     */
    public static initialize(context: vscode.ExtensionContext): void {
        // Structured logger gets a dedicated channel to avoid mixing with
        // the legacy top-level Logger output at "LiteLLM".
        this.ensureChannel(context);
        this.info("logger.initialized", {
            note: "Use the log level dropdown in the output panel to change verbosity",
        });
    }

    /**
     * Sets the current log level.
     *
     * @deprecated Use the log level dropdown in the VS Code output panel instead.
     * This method is kept for backward compatibility but has no effect since
     * log filtering is now handled by the output channel UI.
     *
     * @param _level - New log level (ignored)
     */
    public static setLevel(_level: LogLevel): void {
        // No-op: log level is now controlled by the output channel UI
        this.info("logger.setLevel_called", {
            note: "Log level is now controlled by the output panel dropdown. This call has no effect.",
        });
    }

    /**
     * Checks if a given level would be logged.
     *
     * @deprecated Always returns true since filtering is handled by the output channel.
     * @param _level - Level to check (ignored)
     * @returns Always true
     */
    public static isEnabled(_level: LogLevel): boolean {
        // Always return true - let the output channel handle filtering
        return true;
    }

    /**
     * Logs a structured event at the specified level.
     *
     * All logs are sent to the output channel. The channel's UI dropdown
     * controls what is displayed.
     *
     * @param level - Log level
     * @param event - Event type
     * @param data - Event-specific payload
     * @param options - Optional metadata (requestId, model, endpoint, caller)
     */
    public static log(
        level: LogLevel,
        event: EventType | string,
        data: Record<string, unknown>,
        options?: {
            requestId?: string;
            model?: string;
            endpoint?: string;
            caller?: string;
        }
    ): void {
        const channel = this.ensureChannel();

        // Hot-path performance guard: skip all LogEvent construction and
        // JSON.stringify when the channel is configured above trace/debug.
        // The streaming pipeline fires dozens of trace calls per SSE event;
        // building then discarding the payload on every event caused CPU
        // spikes and GC pressure during long chat responses. See
        // `shouldSkipForLevel` for the rationale on why only trace/debug are
        // gated and why an undefined channel.logLevel is treated as "log".
        if (shouldSkipForLevel(channel, level)) {
            return;
        }

        const logEvent: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId: options?.requestId ?? "no-request",
            level,
            event: event as EventType,
            data,
            model: options?.model,
            endpoint: options?.endpoint,
            caller: options?.caller,
        };

        const jsonLine = JSON.stringify(logEvent);

        switch (level) {
            case "trace":
                channel.trace(jsonLine);
                break;
            case "debug":
                channel.debug(jsonLine);
                break;
            case "info":
                channel.info(jsonLine);
                break;
            case "warn":
                channel.warn(jsonLine);
                break;
            case "error":
                channel.error(jsonLine);
                break;
        }
    }

    /**
     * Logs at trace level. Outputs the most data.
     * Use for full payloads, raw SSE frames, detailed parameter maps, hook context snapshots.
     */
    public static trace(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("trace", event, data, options);
    }

    /**
     * Logs at debug level.
     * Use for detailed flow information, endpoint selection decisions, parameter filtering outcomes.
     */
    public static debug(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("debug", event, data, options);
    }

    /**
     * Logs at info level.
     * Use for high-level lifecycle events, request ingress, completion status, token totals.
     */
    public static info(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("info", event, data, options);
    }

    /**
     * Logs at warn level.
     * Use for recoverable issues, parameter suppression, endpoint fallback, trimming near limits.
     */
    public static warn(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("warn", event, data, options);
    }

    /**
     * Logs at error level.
     * Use for failures and exceptions, request failures, unhandled errors, quota exhaustion.
     */
    public static error(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("error", event, data, options);
    }

    /**
     * Shows the output channel.
     */
    public static show(preserveFocus?: boolean): void {
        this.channel?.show(preserveFocus);
    }
}
