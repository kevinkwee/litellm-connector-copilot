import * as vscode from "vscode";
import type { TelemetryService } from "../telemetry/telemetryService";

/**
 * Returns true if a trace/debug message should be skipped because the
 * channel's configured log level is above it (less verbose).
 *
 * Only gates `trace` and `debug` — the streaming hot path fires dozens of
 * Logger.trace calls per SSE event, and calling channel.trace (which
 * formats the message internally) on every event caused CPU spikes during
 * long chat responses. `info`/`warn`/`error` are NOT gated: they are
 * infrequent and important for diagnostics, and VS Code's own channel
 * methods already silently drop them when the level is too high.
 *
 * When `channel.logLevel` is `undefined` (e.g. a test stub, or a call before
 * `initialize`), returns false — never silently drop diagnostic output when
 * we can't confirm it should be dropped.
 */
function shouldSkipTraceOrDebug(channel: vscode.LogOutputChannel, level: "trace" | "debug"): boolean {
    const channelLevel = channel.logLevel;
    if (typeof channelLevel !== "number") {
        return false;
    }
    if (channelLevel === vscode.LogLevel.Off) {
        return true;
    }
    if (level === "trace") {
        return channelLevel > vscode.LogLevel.Trace;
    }
    return channelLevel > vscode.LogLevel.Debug;
}

export class Logger {
    private static channel: vscode.LogOutputChannel;
    private static telemetryService: TelemetryService | undefined;

    public static initialize(context: vscode.ExtensionContext, telemetryService?: TelemetryService): void {
        this.channel = vscode.window.createOutputChannel("LiteLLM", { log: true });
        context.subscriptions.push(this.channel);
        this.telemetryService = telemetryService;
    }

    public static info(message: string, ...args: unknown[]): void {
        this.channel?.info(message, ...args);
    }

    public static warn(message: string, ...args: unknown[]): void {
        this.channel?.warn(message, ...args);
    }

    public static error(error: string | Error, ...args: unknown[]): void {
        if (error instanceof Error) {
            this.channel?.error(error.message, ...args, error.stack);
            this.telemetryService?.captureException(error);
        } else {
            this.channel?.error(error, ...args);
            // Optional: capture string errors as well?
            // For now, only real Errors go to captureException
        }
    }

    public static debug(message: string, ...args: unknown[]): void {
        const channel = this.channel;
        if (channel && shouldSkipTraceOrDebug(channel, "debug")) {
            return;
        }
        channel?.debug(message, ...args);
    }

    public static trace(message: string, ...args: unknown[]): void {
        const channel = this.channel;
        if (channel && shouldSkipTraceOrDebug(channel, "trace")) {
            return;
        }
        channel?.trace(message, ...args);
    }

    public static show(): void {
        this.channel?.show();
    }
}
