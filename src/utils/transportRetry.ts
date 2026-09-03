import * as vscode from "vscode";
import { Logger } from "./logger";

/**
 * Transport-level retry for agent-mode chat requests.
 *
 * A `terminated` / `fetch failed` socket death (or a stream-inactivity abort)
 * destroys the upstream connection but does NOT undo parts already emitted to
 * VS Code: they were forwarded synchronously through `progress.report` before
 * the read failed. The retry therefore resumes from the already-streamed text
 * so the model continues where it left off instead of duplicating output in
 * the chat UI.
 */

/** Sentinel thrown to the retry loop when a transport error is retryable. */
export class TransportErrorBeforeRetry extends Error {
    public constructor(
        message: string,
        public readonly cause: unknown
    ) {
        super(message);
        this.name = "TransportErrorBeforeRetry";
    }
}

/** Sentinel for a stream-inactivity watchdog abort (retryable via resume). */
export class InactivityTimeoutError extends Error {
    public constructor(
        public readonly timeoutMs: number,
        public readonly eventCount: number
    ) {
        super(`Stream inactivity timeout after ${timeoutMs}ms (${eventCount} events)`);
        this.name = "InactivityTimeoutError";
    }
}

/**
 * True when the error represents a transport-level failure that a new HTTP
 * request can plausibly recover from. Deliberately narrow: HTTP status errors
 * (LiteLLM API error), cancellations, and upstream API errors are NOT retried
 * because a fresh request would either be rejected identically or produce
 * duplicated content.
 */
export function isTransportRetriableError(err: unknown): boolean {
    if (err instanceof InactivityTimeoutError) {
        return true;
    }
    if (!(err instanceof Error)) {
        return false;
    }
    const msg = err.message.toLowerCase();
    if (msg.includes("operation cancelled by user") || err.name === "AbortError" || err.name === "CancellationError") {
        return false;
    }
    if (msg.includes("litellm api error") || msg.includes("litellm error")) {
        return false;
    }
    return (
        msg.includes("terminated") ||
        msg.includes("fetch failed") ||
        msg.includes("socket hang up") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("etimedout") ||
        msg.includes("epipe") ||
        msg.includes("other side closed") ||
        msg.includes("stream ended before [done]")
    );
}

export function sleepWithCancellation(ms: number, token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const registration = token?.onCancellationRequested(() => {
            clearTimeout(timer);
            registration?.dispose();
            resolve();
        });
        const timer = setTimeout(() => {
            registration?.dispose();
            resolve();
        }, ms);
    });
}

export interface TransportRetryConfig {
    /** Maximum number of retry attempts for a single request. */
    networkRetries: number;
    /** Base delay in ms; doubles per attempt, capped at 30s. */
    networkRetryDelayMs: number;
}

const MAX_BACKOFF_MS = 30_000;

export function backoffDelayMs(attempt: number, baseMs: number): number {
    return Math.min(MAX_BACKOFF_MS, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
}

/**
 * Accumulates the text that has already been delivered to VS Code during the
 * current response. On a mid-stream retry the value is appended to the request
 * as the leading assistant content so the model continues from where the
 * socket died without duplicating anything in the chat UI.
 */
export class StreamedTextAccumulator {
    private _text = "";
    private _thinking = "";
    private _sawToolCall = false;

    /** Records a part on its way to VS Code. */
    public add(part: vscode.LanguageModelResponsePart): void {
        if (part instanceof vscode.LanguageModelTextPart) {
            this._text += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            // A delivered tool call must NOT be retried; the tool may already
            // be executing in VS Code's agent loop.
            this._sawToolCall = true;
        } else if (isThinkingPartInstance(part) || isThinkingPartDuckTyped(part)) {
            // Reasoning deltas accumulate so the resumed assistant message can
            // carry the partial reasoning forward as reasoning_content.
            this._thinking += extractThinkingValue(part);
        }
    }

    public get text(): string {
        return this._text;
    }

    public get thinking(): string {
        return this._thinking;
    }

    public get sawToolCall(): boolean {
        return this._sawToolCall;
    }

    public get isEmpty(): boolean {
        return this._text.length === 0 && !this._sawToolCall;
    }

    public reset(): void {
        this._text = "";
        this._thinking = "";
        this._sawToolCall = false;
    }
}

function isThinkingPartInstance(part: vscode.LanguageModelResponsePart): boolean {
    const ctorName =
        (Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)?.constructor?.name ??
        "";
    return ctorName === "LanguageModelThinkingPart";
}

/**
 * Duck-typed fallback for thinking parts: the class exists only behind a
 * proposed API flag, and instanceof can fail across vscode module instances
 * (the same reason the emitters avoid it).
 */
function isThinkingPartDuckTyped(part: unknown): boolean {
    if (!part || typeof part !== "object") {
        return false;
    }
    return (
        "value" in part &&
        (typeof (part as { value?: unknown }).value === "string" ||
            Array.isArray((part as { value?: unknown }).value)) &&
        !("role" in part)
    );
}

function extractThinkingValue(part: unknown): string {
    const v = (part as { value?: string | string[] }).value;
    if (Array.isArray(v)) {
        return v.join("");
    }
    return typeof v === "string" ? v : "";
}

/**
 * Builds the request-body message additions for a resumed request: the
 * already-streamed reasoning and text as trailing assistant content so the
 * model continues the same response instead of starting a new one. Reasoning
 * is carried as a thinking part, which convertMessages() maps to the
 * reasoning_content field on the OpenAI payload (LiteLLM's convention for
 * reasoning-native providers like GLM).
 */
export function buildResumeMessages(
    originalMessages: readonly vscode.LanguageModelChatRequestMessage[],
    streamedText: string,
    streamedThinking: string
): vscode.LanguageModelChatRequestMessage[] {
    if (!streamedText.trim() && !streamedThinking.trim()) {
        return [...originalMessages];
    }

    const messages = [...originalMessages];
    let last: vscode.LanguageModelChatRequestMessage | undefined;
    if (messages.length > 0) {
        last = messages[messages.length - 1];
    }

    const resumeParts: vscode.LanguageModelResponsePart[] = [];
    if (streamedThinking.trim()) {
        const thinkingPart = createThinkingPart(streamedThinking);
        if (thinkingPart) {
            resumeParts.push(thinkingPart);
        }
    }
    if (streamedText.trim()) {
        resumeParts.push(new vscode.LanguageModelTextPart(streamedText));
    }

    // Merge into a trailing assistant message so the wire carries one coherent
    // assistant turn (thinking part + text part) rather than two.
    const lastIsAssistant =
        last !== undefined &&
        last.role !== undefined &&
        (last.role as unknown as number) === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number);

    if (lastIsAssistant && last) {
        messages[messages.length - 1] = {
            ...last,
            content: [...(last.content ?? []), ...resumeParts],
        } as vscode.LanguageModelChatRequestMessage;
        return messages;
    }

    messages.push({
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: resumeParts,
        name: undefined,
    } as unknown as vscode.LanguageModelChatRequestMessage);
    return messages;
}

/** Constructs a LanguageModelThinkingPart when the proposed API is available. */
function createThinkingPart(value: string): vscode.LanguageModelResponsePart | undefined {
    const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
        (new (v: string, id?: string) => unknown) | undefined;
    if (!ThinkingPart) {
        return undefined;
    }
    return new ThinkingPart(value) as vscode.LanguageModelResponsePart;
}

export function logTransportRetry(
    requestId: string,
    attempt: number,
    maxAttempts: number,
    rootMessage: string,
    resumedTextLength: number
): void {
    Logger.warn(
        `[transportRetry] request=${requestId} transport error, retry ${attempt}/${maxAttempts} ` +
            `(resuming with ${resumedTextLength} streamed chars): ${rootMessage}`
    );
}
