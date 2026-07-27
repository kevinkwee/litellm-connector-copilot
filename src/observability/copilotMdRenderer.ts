import * as vscode from "vscode";
import type { OpenAIChatCompletionRequest, OpenAIUsagePayload } from "../types";
import type { TokenSnapshot } from "../adapters/streaming/streamTokenCapture";
import { sha1BytesAsync } from "../utils/discoveryHash";

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
    /**
     * Pre-computed session fingerprint (UUID v5 string). When provided,
     * the writer uses it directly as the session subfolder name instead
     * of recomputing from `requestMessages`. The chat provider computes
     * this once at the top of `provideLanguageModelChatResponse` so it
     * can:
     *   1. Inject it into `requestBody.metadata.session_id` for LiteLLM
     *      per-session spend tracking / cache grouping (LiteLLM expects a
     *      UUID-format string for `litellm_session_id`).
     *   2. Pass the same value here so the `.copilotmd` file lands in the
     *      same session folder as the LiteLLM spend-log row.
     * The UUID is derived as UUID v5 (RFC 4122, name-based with SHA-1) from
     * the message seed and a fixed namespace UUID, so Python's
     * `uuid.uuid5(NAMESPACE, name)` produces the same UUID from the same
     * seed — enabling cross-language session-id reproduction.
     * When omitted (e.g. in unit tests that don't care about the folder),
     * the writer falls back to {@link computeSessionFingerprint}.
     */
    sessionFingerprint?: string;
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
    const isToolResultMessage =
        parts.length > 0 && parts.every((p) => p instanceof vscode.LanguageModelToolResultPart);

    const roleLabel = isToolResultMessage ? "Tool" : roleToString(message.role);
    const capitalizedRole = roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1);

    let str = `### ${capitalizedRole}\n${MARKDOWN_FENCE}md\n`;

    const renderedParts: string[] = [];
    for (const part of parts) {
        renderedParts.push(requestPartToMarkdown(part));
    }
    str += renderedParts.join("\n");

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
        | (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown)
        | undefined;
    if (ThinkingPart && part instanceof ThinkingPart) {
        const thinkingPart = part as { value: string | string[]; id?: string };
        const text = Array.isArray(thinkingPart.value) ? thinkingPart.value.join("\n") : thinkingPart.value;
        return `reasoning: ${text}`;
    }
    // LanguageModelDataPart — opaque binary data; serialize as JSON like Copilot
    // does for non-text image content.
    if (part instanceof vscode.LanguageModelDataPart) {
        return JSON.stringify(part);
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

    /** Flushes both buffers in the correct order (reasoning before text). */
    const flushAll = (): void => {
        flushReasoning();
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
            const ThinkingPart = (vscode as unknown as Record<string, unknown>)
                .LanguageModelThinkingPart as
                | (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown)
                | undefined;
            if (ThinkingPart && part instanceof ThinkingPart) {
                // Accumulate reasoning fragments into one continuous string,
                // same as text. Each SSE delta.reasoning_content chunk is a
                // fragment of the same reasoning stream — concatenating
                // restores the original prose instead of splitting it across
                // dozens of `reasoning: {one word}` lines.
                const thinkingPart = part as unknown as { value: string | string[]; id?: string };
                const text = Array.isArray(thinkingPart.value)
                    ? thinkingPart.value.join("\n")
                    : thinkingPart.value;
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
 * Mirrors Copilot's tool-result rendering: text parts become their `.value`,
 * data parts become `JSON.stringify`, anything else falls back to stringify.
 */
function renderToolResultContent(content: (vscode.LanguageModelTextPart | unknown)[]): string {
    const chunks: string[] = [];
    for (const item of content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            chunks.push((item as vscode.LanguageModelTextPart).value);
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
        ...(snapshot.acceptedPredictionTokens
            ? { accepted_prediction_tokens: snapshot.acceptedPredictionTokens }
            : {}),
        ...(snapshot.rejectedPredictionTokens
            ? { rejected_prediction_tokens: snapshot.rejectedPredictionTokens }
            : {}),
    };
    return {
        prompt_tokens: snapshot.promptTokens,
        completion_tokens: snapshot.completionTokens,
        total_tokens: snapshot.promptTokens + snapshot.completionTokens,
        ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
        ...(Object.keys(completionDetails).length > 0
            ? { completion_tokens_details: completionDetails }
            : {}),
        ...(snapshot.systemPromptTokens ? { system_prompt_tokens: snapshot.systemPromptTokens } : {}),
        ...(snapshot.estimatedInputCost
            ? { estimated_input_cost: snapshot.estimatedInputCost }
            : {}),
        ...(snapshot.estimatedOutputCost
            ? { estimated_output_cost: snapshot.estimatedOutputCost }
            : {}),
        ...(snapshot.estimatedTotalCost
            ? { estimated_total_cost: snapshot.estimatedTotalCost }
            : {}),
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

/**
 * Computes a stable session fingerprint for grouping requests into session
 * subfolders. See `litellm-connector-copilot-chat-debug-view.md` memory for
 * the rationale.
 *
 * Strategy: hash every `User`-role message that appears **after** the last
 * `System` message and **before** the first `Assistant` message, then derive
 * a deterministic **UUID v5** (RFC 4122, name-based UUID with SHA-1) from the
 * result using a fixed namespace UUID. Returns a real UUID like
 * `e7074038-e624-585e-bf91-fc179549e3ca` — note the `5` in the version
 * nibble (position 14) which marks it as a v5 UUID. This is the same format
 * LiteLLM expects for `litellm_session_id`, and Python's
 * `uuid.uuid5(uuid.UUID("a4c0a0d3-7d8e-4f6b-b5e1-2c1f9a8b7d6e"), name)`
 * produces the byte-identical UUID from the same seed.
 *
 * ## Why this window
 *
 * A typical Copilot Chat request's `messages` array looks like:
 *
 * ```
 * [0] System   ← agent instructions (same across every session in the same mode)
 * [1] User     ← environment_info, workspace_info, userMemory (same across every session in the same workspace)
 * [2] User     ← the ACTUAL user request (this is what differentiates sessions)
 * [3] Assistant ← first response (with tool call)
 * [4] Tool     ← tool result
 * [5] User     ← follow-up
 * ...
 * ```
 *
 * Hashing only the first user message (`[1]`) — the env/workspace context —
 * collapses every session in the same workspace into one folder, which is
 * wrong. The user's actual request lives in `[2]`, and two sessions with the
 * same workspace but different requests must get different fingerprints.
 *
 * The "user messages after system, before first assistant" window captures
 * `[1]` and `[2]` (in this example), so the fingerprint includes both the
 * workspace context AND the first real request. Two sessions collide only
 * when they share the same workspace context AND the same first request —
 * which is arguably the same session anyway.
 *
 * ## Stability across turns
 *
 * Within a session, each turn's `messages` array is a superset of the
 * previous turn's — the conversation only grows. Turn 1's request messages
 * are `[system, user-env, user-request]` (no assistant yet). Turn 2's are
 * `[system, user-env, user-request, assistant, tool, user-followup]`. In
 * both cases, "user messages after system, before first assistant" = the
 * same `[user-env, user-request]` set → same fingerprint. ✓
 *
 * The window is **exclusive** of the first assistant message: including it
 * would make turn 1 (no assistant) and turn 2 (assistant present) hash
 * differently, splitting one session across two folders.
 *
 * ## Degenerate cases
 *
 * - No user message in the window (e.g. a tool-calling sub-turn seeded only
 *   with system + assistant + tool messages): falls back to hashing the first
 *   message's role + text content so the request still gets a deterministic
 *   home. Two such sub-turns with identical first messages will collide, but
 *   that's the best we can do without a real session id.
 * - Empty message array: returns a fixed fingerprint (`empty:` → hash) so
 *   the writer always has a folder to write to.
 */
export async function computeSessionFingerprint(messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<string> {
    const seed = pickFingerprintSeed(messages);
    return uuidFromSeed(seed);
}

/**
 * Picks the string to hash for the session fingerprint. Exposed via the
 * public {@link computeSessionFingerprint} wrapper; pure for testability.
 *
 * The window is: every `User`-role message after the last `System` message
 * and before the first `Assistant` message. Text content of each qualifying
 * message is concatenated with a role-tag prefix per message so two
 * messages with identical text but different roles don't collide.
 */
function pickFingerprintSeed(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    // Walk the message array in two phases:
    //   1. Collect every `User`-role message until we hit the first `Assistant`
    //      message. System messages before the first user are skipped — they're
    //      the agent instructions, identical across every session in the same
    //      mode, so including them would add no discriminating power.
    //   2. Stop at the first `Assistant` message (exclusive — see JSDoc above).
    const userChunks: string[] = [];
    for (const msg of messages) {
        if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
            // First assistant message ends the window. Everything after it
            // (assistant responses, tool results, follow-up user messages)
            // belongs to later turns and would destabilize the fingerprint
            // if included — turn 1 has no assistant, turn 2 does.
            break;
        }
        if (msg.role === vscode.LanguageModelChatMessageRole.User) {
            userChunks.push(`user:${extractTextContent(msg.content)}`);
        }
    }

    if (userChunks.length > 0) {
        return userChunks.join("\n");
    }

    // Degenerate case: no user message before the first assistant (or no
    // user message at all). Fall back to the first message's role + text so
    // the request still gets a deterministic, content-aware home.
    const first = messages[0];
    if (!first) {
        return "empty:";
    }
    return `${roleToString(first.role)}:${extractTextContent(first.content)}`;
}

/**
 * Concatenates all `LanguageModelTextPart` text from a message's content array.
 * Non-text parts (tool calls, tool results, data) are skipped — they vary
 * across turns and would destabilize the fingerprint.
 */
function extractTextContent(content: readonly (vscode.LanguageModelInputPart | unknown)[]): string {
    if (!Array.isArray(content)) {
        return "";
    }
    const chunks: string[] = [];
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            chunks.push((part as vscode.LanguageModelTextPart).value);
        }
    }
    return chunks.join("\n");
}

/**
 * Fixed namespace UUID for the LiteLLM connector's session fingerprints.
 *
 * UUID v5 (RFC 4122 / RFC 9562) derives a deterministic UUID from
 * (namespace UUID, name) via SHA-1. The namespace acts as a salt so our
 * session ids don't collide with anyone else's v5 UUIDs derived from the
 * same name strings. This is a generated UUID v4, hardcoded once as the
 * connector's permanent namespace — it never changes for the life of the
 * extension. Reproduce in Python with:
 *   `uuid.uuid5(uuid.UUID("a4c0a0d3-7d8e-4f6b-b5e1-2c1f9a8b7d6e"), name)`
 */
const LITELLM_CONNECTOR_NAMESPACE_UUID = "a4c0a0d3-7d8e-4f6b-b5e1-2c1f9a8b7d6e";

/**
 * Derives a deterministic **UUID v5** (RFC 4122) from a seed string.
 *
 * UUID v5 is the standards-compliant "name-based UUID with SHA-1":
 * given the same namespace UUID and the same name, every implementation
 * produces the byte-identical UUID. This is exactly the contract we need
 * for a session fingerprint that must (a) be a real UUID (LiteLLM's
 * `litellm_session_id` field), (b) be reproducible across turns of the
 * same session, and (c) be reproducible across languages — Python's
 * `uuid.uuid5(NAMESPACE, name)` produces the same UUID we produce here,
 * so a Python spend-log query can derive the session id from the same
 * message seed without any TS-specific logic.
 *
 * ## Algorithm (RFC 4122 §4.3)
 * 1. Concatenate the 16-byte namespace UUID + the UTF-8 name bytes.
 * 2. SHA-1 the concatenation → 20-byte digest.
 * 3. Take the first 16 bytes.
 * 4. Set the version bits: byte[6] high nibble = 5 → `(b6 & 0x0f) | 0x50`.
 * 5. Set the variant bits: byte[8] high bits = 10xx → `(b8 & 0x3f) | 0x80`.
 * 6. Format as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (lowercase hex).
 *
 * ## Why SHA-1 is fine here
 * SHA-1's known collision breaks (SHAttered, 2017) are chosen-prefix
 * collision attacks costing ~$110k of compute. They do NOT enable an
 * attacker to (a) predict a UUID from a name, (b) invert a UUID to recover
 * the name, or (c) find a second name matching a target UUID. RFC 9562
 * (2022, the update to 4122) still recommends v5 over v3 for new code
 * precisely because the collision break doesn't matter for
 * content-addressing use cases like this one.
 */
async function uuidFromSeed(seed: string): Promise<string> {
    // Parse the namespace UUID string into 16 bytes.
    const namespaceBytes = uuidStringToBytes(LITELLM_CONNECTOR_NAMESPACE_UUID);
    const nameBytes = new TextEncoder().encode(seed);
    // Step 1: namespace (16 bytes) + name (UTF-8 bytes).
    const concat = new Uint8Array(namespaceBytes.length + nameBytes.length);
    concat.set(namespaceBytes, 0);
    concat.set(nameBytes, namespaceBytes.length);
    // Step 2: SHA-1 the concatenation.
    const digest = await sha1BytesAsync(
        // sha1BytesAsync takes a string; reconstruct from the concatenated
        // bytes via a Latin1 round-trip so each byte maps 1:1 to a char code.
        // (TextEncoder would re-encode UTF-8 multibyte sequences; we already
        // have raw bytes, so we go through String.fromCharCode per chunk to
        // avoid stack overflow on long names.)
        bytesToLatin1(concat)
    );
    // Step 3: take the first 16 bytes.
    const uuidBytes = digest.slice(0, 16);
    // Step 4: set version to 5 (high nibble of byte 6).
    uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
    // Step 5: set variant to 10xx (high bits of byte 8).
    uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
    // Step 6: format as 8-4-4-4-12 lowercase hex.
    return bytesToUuidString(uuidBytes);
}

/**
 * Parses a UUID string (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) into 16 bytes.
 * Throws on malformed input — the namespace is a hardcoded constant, so a
 * malformed UUID would be a compile-time bug caught by the first call.
 */
function uuidStringToBytes(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, "");
    if (hex.length !== 32) {
        throw new Error(`Invalid UUID string: ${uuid}`);
    }
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Formats 16 raw bytes as a UUID string (`8-4-4-4-12` lowercase hex).
 */
function bytesToUuidString(bytes: Uint8Array): string {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Converts a byte array to a Latin1 string (1 byte → 1 char code) in chunks
 * to avoid stack overflow on `String.fromCharCode(...)` for long inputs.
 * Used to feed raw bytes through `sha1BytesAsync` (which takes a string)
 * without UTF-8 re-encoding.
 */
function bytesToLatin1(bytes: Uint8Array): string {
    const CHUNK_SIZE = 0x8000; // 32 KiB
    let result = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        result += String.fromCharCode(...chunk);
    }
    return result;
}
