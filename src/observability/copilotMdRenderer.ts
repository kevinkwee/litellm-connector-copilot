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
    const role = roleToString(message.role);
    const capitalizedRole = role.charAt(0).toUpperCase() + role.slice(1);

    let str = `### ${capitalizedRole}\n${MARKDOWN_FENCE}md\n`;

    // Tool-role messages in Copilot's format prepend `🛠️ {toolCallId}` before
    // any content. In the LanguageModelChatRequestMessage shape, tool results
    // are parts inside content (LanguageModelToolResultPart) — we still want
    // the 🛠️ marker per result, so we emit it inside the content walk below
    // rather than as a header prefix.
    const parts = Array.isArray(message.content) ? message.content : [];

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
 * Mirrors Copilot's `_renderDeltasToMarkdown` → `processDeltasToMessage`: text
 * parts contribute their text, tool-call parts contribute
 * `🛠️ {name} ({callId}) {args}` lines, thinking parts contribute their text,
 * and data parts (usage) are dropped from the response body (they're already
 * surfaced in the `usage` metadata line).
 */
function responsePartsToMarkdown(role: string, parts: readonly vscode.LanguageModelResponsePart[]): string {
    const capitalizedRole = role.charAt(0).toUpperCase() + role.slice(1);
    const chunks: string[] = [];
    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            chunks.push((part as vscode.LanguageModelTextPart).value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            const callPart = part as vscode.LanguageModelToolCallPart;
            chunks.push(`🛠️ ${callPart.name} (${callPart.callId}) ${prettyToolArgs(callPart.input)}`);
        } else if (part instanceof vscode.LanguageModelDataPart) {
            // Usage / cache-control data parts don't belong in the rendered
            // response body — they're metadata. Skip silently.
            continue;
        }
        // LanguageModelToolResultPart is a request-side part; should not appear
        // in a response stream, but if it does, skip it rather than emitting
        // a confusing 🛠️ line.
    }
    return `### ${capitalizedRole}\n${MARKDOWN_FENCE}md\n${chunks.join("\n")}\n${MARKDOWN_FENCE}\n`;
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
 * `System` message and **before** the first `Assistant` message, using a
 * fast, dependency-free 32-bit FNV-1a. Returns a hex string like `a1b2c3d4`.
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
export function computeSessionFingerprint(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const seed = pickFingerprintSeed(messages);
    return fnv1a32Hex(seed);
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
 * 32-bit FNV-1a hash, returned as 8-char lowercase hex.
 *
 * Chosen for: zero dependencies, fast, good distribution for short strings,
 * stable across runs (no randomness). Not cryptographically secure — and
 * doesn't need to be; this is a grouping key, not a security primitive.
 */
function fnv1a32Hex(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        // FNV prime multiplication, kept in 32-bit range with Math.imul.
        hash = Math.imul(hash, 0x01000193);
    }
    // Unsigned 32-bit, then zero-padded 8-char hex.
    const unsigned = hash >>> 0;
    return unsigned.toString(16).padStart(8, "0");
}
