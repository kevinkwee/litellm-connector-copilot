import * as vscode from "vscode";
import type { OpenAIChatCompletionRequest, OpenAIUsagePayload } from "../types";
import type { TokenSnapshot } from "../adapters/streaming/streamTokenCapture";

/**
 * # `.copilotmd` request-log renderer
 *
 * Produces markdown files byte-compatible with the ones VS Code Copilot's
 * Chat Debug View exports via `RequestLogger._renderRequestToMarkdown` in
 * `extensions/copilot/src/extension/prompt/vscode-node/requestLoggerImpl.ts`.
 *
 * ## Why mirror that format?
 * Users who already work with Copilot's `.copilotmd` exports (e.g. for
 * sharing, archiving, or diffing prompts) get identical-looking files for
 * LiteLLM-backed requests: same header banner, same `## Metadata`
 * `<pre><code>` block, same `tools` `<details>`, same `~~~md` fenced
 * `## Request Messages`, same `🛠️ {name} ({callId}) {args}` tool-call
 * lines, same `<style>` footer. The files render the same way in any
 * markdown preview and the in-file anchors (`#request-messages`,
 * `#system`, `#user`, `#response`) work identically.
 *
 * ## What's different from Copilot's renderer
 * - Source data shape: Copilot consumes `@vscode/prompt-tsx` `Raw.ChatMessage`
 *   where tool calls live on `message.toolCalls` and tool results on
 *   `message.tool_call_id` + `message.content`. We consume the
 *   `LanguageModelChatRequestMessage` shape VS Code hands to
 *   `LanguageModelChatProvider.provideLanguageModelChatResponse`, where
 *   tool calls and tool results are parts inside `message.content`
 *   (`LanguageModelToolCallPart` / `LanguageModelToolResultPart`). The
 *   semantics are identical; only the walk differs.
 * - `copilotUsage` line: Copilot emits a proprietary "nano-AIU" cost
 *   number from `usage.copilot_usage.total_nano_aiu`. LiteLLM usage
 *   envelopes do not carry it, so we emit an `estimatedCost` line from
 *   `TokenSnapshot.estimatedTotalCost` instead.
 * - `requestType` line: Copilot emits this when the endpoint metadata is
 *   an object (`urlOrRequestMetadata.type`). We always have a string
 *   `baseUrl` from the LiteLLM proxy config, so we always emit `url:`.
 * - Binary parts: Copilot serializes a `LanguageModelDataPart` with
 *   `JSON.stringify`, which writes the entire byte array into the file, both for
 *   request messages and for tool results. We write a `<mime, size>` placeholder
 *   instead, so an exported transcript stays readable and never carries raw
 *   binary bytes.
 *
 * Everything else is line-for-line compatible.
 */

/**
 * Input bundle for one request log entry.
 *
 * Every field is something the `LiteLLMChatProvider` already has in hand
 * at the point it calls `logFinalUsageEnvelope` / `LiteLLMTelemetry.reportMetric`
 * — no new instrumentation is required upstream.
 */
export interface CopilotMdEntry {
    /** Short request label, e.g. "chat", "panel/editAgent". Becomes the H1 suffix and filename stem. */
    debugName: string;
    /** 8-char hex id (matches Copilot's `generateUuid().substring(0, 8)`). */
    id: string;
    /** The model id VS Code handed to `provideLanguageModelChatResponse` (post-override). */
    model: string;
    /** LiteLLM proxy base URL from `ConfigManager.getConfig().baseUrl`. */
    url: string;
    /** Max input tokens reported to VS Code for this model. */
    maxPromptTokens: number | undefined;
    /** `max_tokens` / `max_output_tokens` / `max_completion_tokens` from the request body, if any. */
    maxResponseTokens: number | undefined;
    /** Chat-location enum value VS Code passed in (`options.modelOptions.location`); undefined if not surfaced. */
    location: number | undefined;
    /** Request body as built by `buildOpenAIChatRequest` — feeds `tools`, `temperature`, `reasoning_effort`, etc. */
    body: OpenAIChatCompletionRequest;
    /** The `messages: readonly LanguageModelChatRequestMessage[]` arg, for the `## Request Messages` section. */
    requestMessages: readonly vscode.LanguageModelChatRequestMessage[];
    /** ISO timestamp captured at request start. */
    startTimeIso: string;
    /** ISO timestamp captured at request end. */
    endTimeIso: string;
    /** `endTime - startTime` in milliseconds. */
    durationMs: number;
    /** The per-request UUID already generated for `Logger.info("Chat request started | RequestID: ...")`. */
    ourRequestId: string;
    /** Time-to-first-token in ms (first text/tool part timestamp − startTime), if observed. */
    timeToFirstTokenMs: number | undefined;
    /** The model id actually used (post-override). Usually equals `model`; emitted as `resolved model`. */
    resolvedModel: string;
    /** Token snapshot from `StreamTokenCapture.getSnapshot()`. Drives the `usage` line. */
    usage: TokenSnapshot;
    /** Response parts emitted to VS Code via `progress.report(...)` — text, tool calls, thinking. */
    responseParts: readonly vscode.LanguageModelResponsePart[];
    /** Status: "success" | "failure" | "canceled". Affects the `## Response` heading. */
    status: "success" | "failure" | "canceled";
    /** When `status` is "failure" or "canceled", the human-readable reason. */
    statusReason?: string;
    /** Session id (canonical lowercase UUID); names the `.copilotmd` subfolder. */
    sessionId: string;
}

const MARKDOWN_FENCE = "~~~";

/**
 * Renders a single request entry to a `.copilotmd`-formatted markdown string.
 *
 * Pure function — no I/O, no logging, no telemetry. Safe to call from any
 * context. The caller is responsible for writing the returned string to disk.
 */
export function renderCopilotMd(entry: CopilotMdEntry): string {
    const out: string[] = [];

    out.push(
        "> 🚨 Note: This log may contain personal information such as the contents of your files or terminal output. Please review the contents carefully before sharing."
    );
    out.push(`# ${entry.debugName} - ${entry.id}`);
    out.push("");

    // Table of contents — matches Copilot's `_renderRequestToMarkdown` ordering.
    const toc: string[] = [];
    toc.push("- [Request Messages](#request-messages)");
    toc.push("  - [System](#system)");
    toc.push("  - [User](#user)");
    toc.push("- [Response](#response)");
    for (const line of toc) {
        out.push(line);
    }
    out.push("");

    // Metadata
    out.push("## Metadata");
    out.push("<pre><code>");
    out.push(`url              : ${entry.url}`);
    out.push(`model            : ${entry.model}`);
    out.push(`maxPromptTokens  : ${fmtOptNum(entry.maxPromptTokens)}`);
    out.push(`maxResponseTokens: ${fmtOptNum(entry.maxResponseTokens)}`);
    out.push(`location         : ${fmtOpt(entry.location)}`);

    // otherOptions — the four known optional body knobs Copilot extracts.
    const otherOptions: Record<string, string | number | boolean> = {};
    if (entry.body.temperature !== undefined) {
        otherOptions.temperature = entry.body.temperature;
    }
    if (entry.body.stream !== undefined) {
        otherOptions.stream = entry.body.stream;
    }
    // `store` and `reasoning_effort` are not part of OpenAIChatCompletionRequest;
    // include reasoning_effort under its own line below to match Copilot's split.
    out.push(`otherOptions     : ${JSON.stringify(otherOptions)}`);

    if (entry.body.reasoning_effort !== undefined) {
        out.push(`reasoning        : ${JSON.stringify(entry.body.reasoning_effort)}`);
    }
    out.push(`intent           : undefined`);
    out.push(`startTime        : ${entry.startTimeIso}`);
    out.push(`endTime          : ${entry.endTimeIso}`);
    out.push(`duration         : ${entry.durationMs}ms`);
    out.push(`ourRequestId     : ${entry.ourRequestId}`);

    if (entry.status === "success") {
        out.push(`requestId        : ${entry.ourRequestId}`);
        out.push(`serverRequestId  : ${entry.ourRequestId}`);
        out.push(`timeToFirstToken : ${fmtOptNum(entry.timeToFirstTokenMs)}ms`);
        out.push(`resolved model   : ${entry.resolvedModel}`);
        out.push(`usage            : ${JSON.stringify(snapshotToUsagePayload(entry.usage))}`);
        if (typeof entry.usage.estimatedTotalCost === "number") {
            out.push(
                `estimatedCost    : $${entry.usage.estimatedTotalCost.toFixed(6)} (input $${fmtOptNum(
                    entry.usage.estimatedInputCost
                )} + output $${fmtOptNum(entry.usage.estimatedOutputCost)})`
            );
        }
    } else if (entry.status === "failure") {
        out.push(`requestId        : ${entry.ourRequestId}`);
        out.push(`serverRequestId  : ${entry.ourRequestId}`);
    }

    // Tools <details>
    if (entry.body.tools?.length) {
        const toolNames = entry.body.tools.map((t) => t.function.name);
        const numToolsString = `(${toolNames.length})`;
        // Copilot pads the count to a 9-char field for column alignment.
        const pad = " ".repeat(Math.max(0, 9 - numToolsString.length));
        out.push(
            `<details>`,
            `<summary>tools ${numToolsString}${pad}: ${toolNames.join(", ")}</summary>${JSON.stringify(
                entry.body.tools,
                undefined,
                4
            )}`,
            `</details>`
        );
    }

    out.push(`</code></pre>`);

    // Request Messages
    out.push(`## Request Messages`);
    for (const message of entry.requestMessages) {
        out.push(requestMessageToMarkdown(message));
    }

    // Response
    out.push(``);
    out.push(`<a id="response"></a>`);
    if (entry.status === "success") {
        out.push(`## Response`);
        out.push(responsePartsToMarkdown("assistant", entry.responseParts));
    } else if (entry.status === "failure") {
        out.push(`## FAILED: ${entry.statusReason ?? "unknown error"}`);
    } else {
        out.push(`## CANCELED`);
    }

    out.push(renderMarkdownStyles());

    return out.join("\n");
}

/**
 * Renders one `LanguageModelChatRequestMessage` as `### {Role}\n~~~md\n{content}\n~~~\n`,
 * matching Copilot's `messageToMarkdown` for `@vscode/prompt-tsx` `Raw.ChatMessage`.
 *
 * Differences from Copilot's helper, forced by the different input shape:
 * - Tool calls in an Assistant message arrive as `LanguageModelToolCallPart`
 *   inside `content`, not as a separate `message.toolCalls` array. We walk
 *   `content[]` and emit `🛠️ {name} ({callId}) {prettyArgs}` for each.
 * - Tool results in a User message arrive as `LanguageModelToolResultPart`
 *   inside `content`, not as `message.tool_call_id` + string content. We
 *   emit `🛠️ {callId}\n{resultText}` for each, joining multiple results
 *   with newlines.
 */
function requestMessageToMarkdown(message: vscode.LanguageModelChatRequestMessage): string {
    const parts = Array.isArray(message.content) ? message.content : [];

    // Detect tool-result-only messages: when every part is a
    // LanguageModelToolResultPart, render as `### Tool` (matching Copilot's
    // Raw.ChatRole.Tool rendering) instead of `### User`. VS Code sends tool
    // results as User-role messages with tool-result parts; the role is
    // technically User but the semantic role is Tool.
    const isToolResultMessage = parts.length > 0 && parts.every((p) => p instanceof vscode.LanguageModelToolResultPart);

    const roleLabel = isToolResultMessage ? "Tool" : roleToString(message.role);
    const capitalizedRole = roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1);

    let str = `### ${capitalizedRole}\n${MARKDOWN_FENCE}md\n`;

    // Separate reasoning from non-reasoning parts so we can insert a visible
    // separator between them. Each SSE delta creates a separate
    // LanguageModelThinkingPart, so we buffer and concatenate them into one
    // `reasoning: {text}` line (same as the response renderer).
    const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
        (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown) | undefined;

    const reasoningChunks: string[] = [];
    const otherParts: string[] = [];

    for (const part of parts) {
        if (ThinkingPart && part instanceof ThinkingPart) {
            const thinkingPart = part as unknown as { value: string | string[] };
            const text = Array.isArray(thinkingPart.value) ? thinkingPart.value.join("\n") : thinkingPart.value;
            reasoningChunks.push(text);
        } else {
            otherParts.push(requestPartToMarkdown(part));
        }
    }

    if (reasoningChunks.length > 0) {
        str += `reasoning: ${reasoningChunks.join("")}\n`;
        if (otherParts.length > 0) {
            str += `\n---\n\n`;
        }
    }
    str += otherParts.join("\n");

    str += `\n${MARKDOWN_FENCE}\n`;
    return str;
}

/**
 * Renders a single content part from a `LanguageModelChatRequestMessage` to
 * its `.copilotmd` text representation.
 */
function requestPartToMarkdown(part: vscode.LanguageModelInputPart | unknown): string {
    // LanguageModelToolCallPart — assistant's request to call a tool.
    if (part instanceof vscode.LanguageModelToolCallPart) {
        const callPart = part as vscode.LanguageModelToolCallPart;
        const argsStr = prettyToolArgs(callPart.input);
        return `🛠️ ${callPart.name} (${callPart.callId}) ${argsStr}`;
    }
    // LanguageModelToolResultPart — user-side tool result back to the assistant.
    if (part instanceof vscode.LanguageModelToolResultPart) {
        const resultPart = part as vscode.LanguageModelToolResultPart;
        const resultText = renderToolResultContent(resultPart.content);
        return `🛠️ ${resultPart.callId}\n${resultText}`;
    }
    // LanguageModelTextPart — plain text content.
    if (part instanceof vscode.LanguageModelTextPart) {
        return (part as vscode.LanguageModelTextPart).value;
    }
    // LanguageModelThinkingPart — model's internal reasoning/thinking content.
    // Rendered as `reasoning: {text}` to match Copilot's opaque-content branch
    // for thinking data (see messageStringify.ts → rawPartAsThinkingData). The
    // `{"$mid":22,"value":"..."}` garbage in the first export was this part
    // falling through to the JSON.stringify fallback — the $mid is VS Code's
    // internal marshalling ID, not meaningful content.
    const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
        (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown) | undefined;
    if (ThinkingPart && part instanceof ThinkingPart) {
        const thinkingPart = part as { value: string | string[]; id?: string };
        const text = Array.isArray(thinkingPart.value) ? thinkingPart.value.join("\n") : thinkingPart.value;
        return `reasoning: ${text}`;
    }
    // LanguageModelDataPart: opaque binary content, rendered as a size placeholder
    // so the transcript stays readable and carries no raw bytes.
    if (part instanceof vscode.LanguageModelDataPart) {
        return formatBinaryPartPlaceholder(part.mimeType, part.data.byteLength);
    }
    // Fallback: unknown part shape (e.g. a proposed-API part we don't model).
    // Match Copilot's `JSON.stringify(item)` behavior for non-text content.
    try {
        return JSON.stringify(part);
    } catch {
        return String(part);
    }
}

/**
 * Renders the `## Response` section's `### Assistant\n~~~md\n{...}\n~~~\n` block
 * from the response parts the provider emitted to VS Code's `progress.report()`.
 *
 * Mirrors Copilot's `_renderDeltasToMarkdown` → `processDeltasToMessage`:
 * - **Text parts are concatenated** (not newline-joined), because each SSE
 *   text chunk is a fragment of one continuous text stream. Joining with
 *   `\n` would split a single sentence across multiple lines (e.g.
 *   `"OK"` / `", just"` / `" let me know"` → "OK\n, just\n let me know"
 *   instead of "OK, just let me know"). The upstream `LanguageModelTextPart`
 *   instances are emitted one per SSE `delta` event; their `.value` fields
 *   are already the raw text fragments, so concatenating restores the
 *   original streamed text.
 * - **Tool-call parts** render as `🛠️ {name} ({callId}) {args}` lines, each
 *   on its own line so multiple parallel tool calls stay readable.
 * - **Thinking parts** would contribute their text (currently dropped —
 *   the renderer doesn't model `LanguageModelThinkingPart` yet; if the
 *   proposed API is available, the part falls through to the default
 *   `JSON.stringify` branch below).
 * - **Data parts** (usage, cache-control) are dropped from the response
 *   body — they're metadata, already surfaced in the `usage` metadata line.
 *
 * Boundaries between part types get a newline so a text stream followed
 * by a tool call doesn't run together (`...text🛠️ tool...`).
 */
function responsePartsToMarkdown(role: string, parts: readonly vscode.LanguageModelResponsePart[]): string {
    const capitalizedRole = role.charAt(0).toUpperCase() + role.slice(1);
    const lines: string[] = [];
    let textBuffer = "";
    let reasoningBuffer = "";

    /**
     * Flushes any accumulated text as a single line, then resets the buffer.
     * Called when we hit a non-text part or at the end of the loop so the
     * full concatenated text stream becomes one line in the rendered output.
     */
    const flushText = (): void => {
        if (textBuffer) {
            lines.push(textBuffer);
            textBuffer = "";
        }
    };

    /**
     * Flushes any accumulated reasoning as a single `reasoning: {text}` line,
     * then resets the buffer. Same concatenation logic as `flushText` — each
     * SSE `delta.reasoning_content` chunk creates a separate
     * `LanguageModelThinkingPart`, and concatenating them (not newline-joining)
     * restores the original reasoning prose. Without this, the reasoning
     * would be split across dozens of `reasoning: {one word}` lines.
     */
    const flushReasoning = (): void => {
        if (reasoningBuffer) {
            lines.push(`reasoning: ${reasoningBuffer}`);
            reasoningBuffer = "";
        }
    };

    /**
     * Flushes both buffers in the correct order (reasoning before text).
     * Inserts a visible `---` separator between reasoning and text/tool-calls
     * so the boundary between "what the model thought" and "what the model
     * said/did" is immediately obvious when scanning the rendered markdown.
     */
    const flushAll = (): void => {
        const hadReasoning = reasoningBuffer.length > 0;
        const hadText = textBuffer.length > 0;
        flushReasoning();
        // Insert a visible separator between reasoning and the content that
        // follows (text or tool calls) so they don't run together visually.
        if (hadReasoning && hadText) {
            lines.push("");
            lines.push("---");
            lines.push("");
        }
        flushText();
    };

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            // Accumulate text fragments into one continuous string. Each SSE
            // delta is a fragment of the same text stream, so we concatenate
            // rather than newline-join to preserve the original prose.
            textBuffer += (part as vscode.LanguageModelTextPart).value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            // Tool calls go on their own lines. Flush any pending
            // reasoning and text first so boundaries get newlines.
            flushAll();
            const callPart = part as vscode.LanguageModelToolCallPart;
            lines.push(`🛠️ ${callPart.name} (${callPart.callId}) ${prettyToolArgs(callPart.input)}`);
        } else if (part instanceof vscode.LanguageModelDataPart) {
            // Usage / cache-control data parts don't belong in the rendered
            // response body — they're metadata. Skip silently.
            continue;
        } else {
            // Check for LanguageModelThinkingPart (proposed API). The class
            // may not be available in all VS Code builds, so we resolve it
            // lazily via the vscode namespace rather than a static import.
            const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
                | (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown)
                | undefined;
            if (ThinkingPart && part instanceof ThinkingPart) {
                // Accumulate reasoning fragments into one continuous string,
                // same as text. Each SSE delta.reasoning_content chunk is a
                // fragment of the same reasoning stream — concatenating
                // restores the original prose instead of splitting it across
                // dozens of `reasoning: {one word}` lines.
                const thinkingPart = part as unknown as { value: string | string[]; id?: string };
                const text = Array.isArray(thinkingPart.value) ? thinkingPart.value.join("\n") : thinkingPart.value;
                reasoningBuffer += text;
            } else {
                // Unknown part type — skip rather than emitting a confusing
                // JSON.stringify line (which produced the `{"$mid":22,...}`
                // garbage in the first export).
                continue;
            }
        }
    }
    // Flush any trailing reasoning and text so the response doesn't end
    // mid-buffer.
    flushAll();

    const body = lines.length > 0 ? lines.join("\n") : "";
    return `### ${capitalizedRole}\n${MARKDOWN_FENCE}md\n${body}\n${MARKDOWN_FENCE}\n`;
}

/**
 * Renders the content array of a `LanguageModelToolResultPart` as text.
 * Text parts become their `.value`, binary parts become a size placeholder so
 * raw bytes never reach the transcript, and anything else falls back to
 * `JSON.stringify`.
 */
function renderToolResultContent(content: (vscode.LanguageModelTextPart | unknown)[]): string {
    const chunks: string[] = [];
    for (const item of content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            chunks.push((item as vscode.LanguageModelTextPart).value);
        } else if (item instanceof vscode.LanguageModelDataPart) {
            chunks.push(formatBinaryPartPlaceholder(item.mimeType, item.data.byteLength));
        } else {
            try {
                chunks.push(JSON.stringify(item));
            } catch {
                chunks.push(String(item));
            }
        }
    }
    return chunks.join("\n");
}

/**
 * Summarizes a binary part as `<mime, size>` for the transcript.
 * @param mimeType MIME type of the part.
 * @param byteLength Size of the part payload in bytes.
 */
function formatBinaryPartPlaceholder(mimeType: string, byteLength: number): string {
    let size: string;
    if (byteLength < 1024) {
        size = `${byteLength} B`;
    } else if (byteLength < 1024 * 1024) {
        size = `${(byteLength / 1024).toFixed(1)} KB`;
    } else {
        size = `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `<${mimeType}, ${size}>`;
}

/**
 * Pretty-prints tool-call arguments the way Copilot does in
 * `processDeltasToMessage` / `messageToMarkdown`: parse the JSON, re-stringify
 * with 2-space indent, then un-escape `\n` and `\t` so multi-line args render
 * readably inside the `~~~md` fence.
 */
function prettyToolArgs(input: object): string {
    let argsStr: string;
    try {
        argsStr = JSON.stringify(input, undefined, 2);
    } catch {
        try {
            argsStr = JSON.stringify(String(input));
        } catch {
            return String(input);
        }
    }
    // Match Copilot's un-escape pass. The lookbehind avoids touching already-
    // escaped backslashes; safe in Node 14+ (our minimum).
    argsStr = argsStr.replace(/(?<!\\)\\n/g, "\n").replace(/(?<!\\)\\t/g, "\t");
    return argsStr;
}

function roleToString(role: vscode.LanguageModelChatMessageRole): string {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User:
            return "User";
        case vscode.LanguageModelChatMessageRole.Assistant:
            return "Assistant";
        // System role is part of the proposed API surface (`LanguageModelChatMessageRole.System = 3`)
        // and is used by some upstream callers. Handle it defensively even though
        // the stable 1.120 enum only declares User/Assistant.
        default:
            return "System";
    }
}

/**
 * Converts a `TokenSnapshot` to the `OpenAIUsagePayload` shape Copilot emits
 * on the `usage:` metadata line. Mirrors the enrichment `StreamTokenCapture`
 * already does when building the upstream usage DataPart.
 */
function snapshotToUsagePayload(snapshot: TokenSnapshot): OpenAIUsagePayload {
    const promptDetails = {
        ...(snapshot.cachedTokens ? { cached_tokens: snapshot.cachedTokens } : {}),
        ...(snapshot.cacheCreationInputTokens
            ? { cache_creation_input_tokens: snapshot.cacheCreationInputTokens }
            : {}),
    };
    const completionDetails = {
        ...(snapshot.reasoningTokens ? { reasoning_tokens: snapshot.reasoningTokens } : {}),
        ...(snapshot.toolTokens ? { tool_tokens: snapshot.toolTokens } : {}),
        ...(snapshot.acceptedPredictionTokens ? { accepted_prediction_tokens: snapshot.acceptedPredictionTokens } : {}),
        ...(snapshot.rejectedPredictionTokens ? { rejected_prediction_tokens: snapshot.rejectedPredictionTokens } : {}),
    };
    return {
        prompt_tokens: snapshot.promptTokens,
        completion_tokens: snapshot.completionTokens,
        total_tokens: snapshot.promptTokens + snapshot.completionTokens,
        ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
        ...(Object.keys(completionDetails).length > 0 ? { completion_tokens_details: completionDetails } : {}),
        ...(snapshot.systemPromptTokens ? { system_prompt_tokens: snapshot.systemPromptTokens } : {}),
        ...(snapshot.estimatedInputCost ? { estimated_input_cost: snapshot.estimatedInputCost } : {}),
        ...(snapshot.estimatedOutputCost ? { estimated_output_cost: snapshot.estimatedOutputCost } : {}),
        ...(snapshot.estimatedTotalCost ? { estimated_total_cost: snapshot.estimatedTotalCost } : {}),
    };
}

/**
 * The exact `<style>` block Copilot appends to every `.copilotmd` file.
 * Kept verbatim (including the leading blank line) for byte-compatibility.
 */
function renderMarkdownStyles(): string {
    return `
<style>
[id^="system"], [id^="user"], [id^="assistant"] {
		margin: 4px 0 4px 0;
}

.markdown-body > pre {
		padding: 4px 16px;
}
</style>
`;
}

function fmtOpt<T>(value: T | undefined): string {
    return value === undefined ? "undefined" : String(value);
}

function fmtOptNum(value: number | undefined): string {
    return value === undefined ? "undefined" : String(value);
}

/**
 * Builds the on-disk filename for an entry.
 *
 * Pattern: `{debugName}_{ISOtimestamp}_{id}.copilotmd`
 * - `debugName` is sanitized to filename-safe characters (matches Copilot's
 *   `debugName.replace(/\W/g, '_')`).
 * - `ISOtimestamp` is the start time with `:` removed (Windows-safe) and
 *   milliseconds dropped — sortable in a file explorer at a glance, and
 *   conflicts only on >1 request with the same id in the same second,
 *   which the 8-char `id` already disambiguates.
 * - `id` is the 8-char hex already used in the H1.
 */
export function buildCopilotMdFilename(entry: CopilotMdEntry): string {
    const safeDebugName = entry.debugName.replace(/\W/g, "_");
    // ISO 8601 start time → sortable, filename-safe, no separators.
    // `2026-07-11T09:25:59.651Z` → `20260711_092559` (date_time, no ms, no zone).
    // Matches the Copilot export filename pattern at a glance and sorts
    // chronologically in any file explorer. The 8-char `id` already
    // disambiguates two requests in the same second.
    const sortableTimestamp = entry.startTimeIso
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z?$/, "")
        .replace("T", "_");
    return `${safeDebugName}_${sortableTimestamp}_${entry.id}.copilotmd`;
}
