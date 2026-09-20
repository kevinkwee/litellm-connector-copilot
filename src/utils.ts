import * as vscode from "vscode";
import { lmcr_toString } from "./utils/mapChatRoles";
import type {
    OpenAIChatMessage,
    OpenAIChatRole,
    OpenAIFunctionToolDef,
    OpenAIToolCall,
    OpenAIChatMessageContentItem,
} from "./types";
import { Logger } from "./utils/logger";

/**
 * Normalize tool call IDs to be compatible with OpenAI-compatible providers
 * and strict models like z.AI GLM that enforce shorter length limits.
 *
 * Constraints:
 * - OpenAI-compatible tool_call_id requires minimum ~42 characters
 * - z.AI GLM models enforce maximum ~63 characters
 * - Strict models (e.g. gpt-5.3-codex) require IDs start with 'fc_'
 *
 * Strategy:
 * - Always ensure IDs start with 'fc_' to satisfy strict models
 * - Generate IDs in the safe range of 42-63 characters
 * - Use deterministic hashing for stability (same input → same output)
 * - Preserve a readable middle fragment for debugging
 *
 * @param id - The input tool call ID (may be empty, too short, too long, or non-compliant)
 * @param maxLen - Preferred length cap for rebuilt IDs (default 56), clamped to [42, 63]
 * @returns Normalized ID starting with 'fc_', with length in [42, 63]
 */
export function normalizeToolCallId(id: string, maxLen = 56): string {
    const MIN_LENGTH = 42;
    const MAX_SAFE_LENGTH = 63;
    // Shift by 3 chars to account for "fc_"
    const MIN_LENGTH_NO_PREFIX = 39;
    const MAX_LENGTH_NO_PREFIX = 60;
    const effectiveMaxLen = Math.max(MIN_LENGTH, Math.min(maxLen, MAX_SAFE_LENGTH));
    const effectiveMaxLen_NoPrefix = Math.max(MIN_LENGTH_NO_PREFIX, Math.min(maxLen, MAX_LENGTH_NO_PREFIX));

    const raw = (id || "").trim();
    const prefix = "fc_";
    if (!raw) {
        const hashPart = hashOfLength("empty", effectiveMaxLen - prefix.length);
        const generated = `${prefix}${hashPart}`;
        Logger.trace(`[normalizeToolCallId] Empty ID provided, generated: ${generated} (len: ${generated.length})`);
        return generated;
    }

    // Only a leading fc_ is the provider prefix; an fc_ embedded mid-ID is
    // ordinary payload and must not let the raw ID pass through as prefixed.
    let tcId: string;
    let tcHasPrefix = false;
    if (raw.startsWith(prefix)) {
        tcId = raw.slice(prefix.length);
        tcHasPrefix = true;
    } else {
        tcId = raw;
    }
    const tcNoPrefixLength = tcId.length;

    if (tcHasPrefix) {
        if (tcNoPrefixLength >= MIN_LENGTH_NO_PREFIX && tcNoPrefixLength <= effectiveMaxLen_NoPrefix) {
            Logger.trace(`[normalizeToolCallId] Valid ID kept as-is: ${raw} (len: ${raw.length})`);
            return raw;
        }

        if (tcNoPrefixLength < MIN_LENGTH_NO_PREFIX) {
            const padding = hashOfLength(tcId, MIN_LENGTH_NO_PREFIX - tcNoPrefixLength);
            const padded = `${prefix}${tcId}${padding}`;
            Logger.trace(`[normalizeToolCallId] Short fc_ ID padded: ${tcId} -> ${padded} (len: ${padded.length})`);
            return padded;
        }
    }

    // Otherwise, normalize it to ensure it starts with fc_ and is in safe range
    // Strip common prefixes we want to replace to keep the middle part readable
    const cleanRaw = raw.replace(/^call_|^tc_/, "");
    const safeMiddle = cleanRaw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 10);
    const hash = stableHash(raw); // Hash the FULL original ID for stability

    // Build initial: fc_ + safeMiddle + _ + hash = 3 + 10 + 1 + 16 = 30 chars minimum
    // We need at least 42 chars, so pad the hash portion to reach minimum length
    let baseOut = `${prefix}${safeMiddle}_${hash}`;

    while (baseOut.length < MIN_LENGTH) {
        baseOut += stableHash(raw).slice(0, 2);
    }

    let final: string;
    if (baseOut.length > effectiveMaxLen) {
        final = baseOut.slice(0, effectiveMaxLen);
    } else {
        final = baseOut;
    }

    Logger.trace(`[normalizeToolCallId] ID normalized: ${raw} -> ${final} (len: ${final.length})`);
    return final;
}

function stableHash(input: string): string {
    // Must work in BOTH extension host (node) and web bundle.
    // Use a small, deterministic, non-crypto hash (FNV-1a 64-bit) and encode as hex.
    // Collision risk is low for our use (shrinking IDs) and avoids bundling Node builtins.
    let hash = 0xcbf29ce484222325n; // offset basis
    const prime = 0x100000001b3n;
    for (const ch of input) {
        hash ^= BigInt(ch.codePointAt(0) ?? 0);
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    // Fixed 16-char width keeps downstream length arithmetic exact.
    return hash.toString(16).padStart(16, "0");
}

function hashOfLength(input: string, length: number): string {
    // A single 16-char hash cannot cover the largest padding request (39), so tile it.
    const hash = stableHash(input);
    return hash.repeat(Math.ceil(length / hash.length)).slice(0, length);
}

// Tool calling sanitization helpers

function isIntegerLikePropertyName(propertyName: string | undefined): boolean {
    if (!propertyName) {
        return false;
    }
    const lowered = propertyName.toLowerCase();
    const integerMarkers = [
        "id",
        "limit",
        "count",
        "index",
        "size",
        "offset",
        "length",
        "results_limit",
        "maxresults",
        "debugsessionid",
        "cellid",
    ];
    return integerMarkers.some((m) => lowered.includes(m)) || lowered.endsWith("_id");
}

function sanitizeFunctionName(name: unknown): string {
    if (typeof name !== "string" || !name) {
        return "tool";
    }
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = `tool_${sanitized}`;
    }
    sanitized = sanitized.replace(/_+/g, "_");
    return sanitized.slice(0, 64);
}

function pruneUnknownSchemaKeywords(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return {};
    }
    const allow = new Set([
        "type",
        "properties",
        "required",
        "additionalProperties",
        "description",
        "enum",
        "default",
        "items",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "pattern",
        "format",
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
        if (allow.has(k)) {
            out[k] = v as unknown;
        }
    }
    return out;
}

/**
 * Strips Markdown code blocks from a string.
 * If the string contains triple backticks, it extracts the content inside them.
 * If multiple code blocks exist, it joins them.
 * If no code blocks exist, it returns the original string trimmed.
 */
export function stripMarkdownCodeBlocks(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.includes("```")) {
        return trimmed;
    }

    // Regex to match code blocks: ```[lang]\n(content)\n```
    // Supports optional language tag and handles non-greedy matching for content.
    const codeBlockRegex = /```(?:\w+)?\s*([\s\S]*?)\s*```/g;
    const matches = [...trimmed.matchAll(codeBlockRegex)];

    if (matches.length > 0) {
        return matches
            .map((m) => m[1].trim())
            .filter((content) => content.length > 0)
            .join("\n\n");
    }

    // Fallback: if there are TRIPLE backticks but no complete block match,
    // just strip the backticks themselves as a safety measure.
    if (trimmed.includes("```")) {
        return trimmed.replace(/```/g, "").trim();
    }

    return trimmed;
}

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { type: "object", properties: {} } as Record<string, unknown>;
    }

    let schema = input as Record<string, unknown>;

    for (const composite of ["anyOf", "oneOf", "allOf"]) {
        const branch = (schema as Record<string, unknown>)[composite] as unknown;
        if (Array.isArray(branch) && branch.length > 0) {
            let preferred: Record<string, unknown> | undefined;
            for (const b of branch) {
                if (b && typeof b === "object" && (b as Record<string, unknown>).type === "string") {
                    preferred = b as Record<string, unknown>;
                    break;
                }
            }
            schema = { ...(preferred ?? (branch[0] as Record<string, unknown>)) };
            break;
        }
    }

    schema = pruneUnknownSchemaKeywords(schema);

    let t = schema.type as string | undefined;
    if (t === null) {
        t = "object";
        schema.type = t;
    }

    if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
        schema.type = "integer";
        t = "integer";
    }

    if (t === "object") {
        const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
        const newProps: Record<string, unknown> = {};
        if (props && typeof props === "object") {
            for (const [k, v] of Object.entries(props)) {
                newProps[k] = sanitizeSchema(v, k);
            }
        }
        schema.properties = newProps;

        const req = schema.required as unknown;
        if (Array.isArray(req)) {
            schema.required = req.filter((r) => typeof r === "string");
        } else if (req !== undefined) {
            schema.required = [];
        }

        const ap = schema.additionalProperties as unknown;
        if (ap !== undefined && typeof ap !== "boolean") {
            delete schema.additionalProperties;
        }
    } else if (t === "array") {
        const items = schema.items as unknown;
        if (Array.isArray(items) && items.length > 0) {
            schema.items = sanitizeSchema(items[0]);
        } else if (items && typeof items === "object") {
            schema.items = sanitizeSchema(items);
        } else {
            schema.items = { type: "string" } as Record<string, unknown>;
        }
    }

    return schema;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @returns OpenAI-compatible messages array.
 */
export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatMessage[] {
    const out: OpenAIChatMessage[] = [];
    for (const m of messages) {
        // `lmcr_toString` returns "system" | "user" | "assistant" for the supported
        // VS Code roles, which matches `Exclude<OpenAIChatRole, "tool">` exactly.
        // Casting keeps the downstream string narrowing in line 315 typed correctly.
        const role = lmcr_toString(m.role as vscode.LanguageModelChatMessageRole) as Exclude<OpenAIChatRole, "tool">;
        const textParts: string[] = [];
        const contentItems: OpenAIChatMessageContentItem[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: { callId: string; content: string }[] = [];
        // Reasoning/thinking text collected from LanguageModelThinkingPart parts.
        // Kept separate from `textParts` so it goes into the assistant message's
        // `reasoning_content` field (not `content`) — matching LiteLLM's
        // `reasoning_content` convention for reasoning-native providers
        // (GLM-5.2, DeepSeek, Qwen, etc.).
        const reasoningParts: string[] = [];

        for (const part of m.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                // Handle image and other data parts
                if (isCacheControlMimeType(part.mimeType)) {
                    // Drop cache_control metadata unconditionally (see
                    // isCacheControlMimeType doc for rationale). This branch runs
                    // BEFORE the JSON branch so that MIME types like
                    // "application/vnd.cache-control+json" cannot slip through.
                    Logger.trace(`[convertMessages] Dropping cache_control part (mimeType: ${part.mimeType})`);
                } else if (part.mimeType.startsWith("image/")) {
                    // Convert image data to base64 for OpenAI vision API
                    let base64Data: string;
                    if (part.data instanceof Uint8Array) {
                        base64Data = Buffer.from(part.data).toString("base64");
                    } else if (typeof part.data === "string") {
                        base64Data = Buffer.from(part.data, "utf-8").toString("base64");
                    } else {
                        base64Data = Buffer.from(part.data as unknown as ArrayBuffer).toString("base64");
                    }
                    contentItems.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${part.mimeType};base64,${base64Data}`,
                        },
                    });
                } else if (part.mimeType.startsWith("application/json")) {
                    // Handle JSON data parts by decoding and appending as text
                    const jsonStr = Buffer.from(part.data).toString("utf-8");
                    textParts.push(jsonStr);
                } else if (part.mimeType.startsWith("text/")) {
                    // Handle explicit text data parts
                    const textStr = Buffer.from(part.data).toString("utf-8");
                    textParts.push(textStr);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const id = normalizeToolCallId(
                    part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                );
                Logger.trace(`[convertMessages] Tool call: ${part.name} (orig: ${part.callId}, norm: ${id})`);
                let args = "{}";
                try {
                    args = JSON.stringify(part.input ?? {});
                } catch {
                    // Fallback to empty JSON if stringify fails
                }
                toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
            } else if (isToolResultPart(part)) {
                const callId = normalizeToolCallId((part as { callId?: string }).callId ?? "");
                Logger.trace(
                    `[convertMessages] Tool result: (orig: ${(part as { callId?: string }).callId}, norm: ${callId})`
                );
                const content = collectToolResultText(part as { content?: readonly unknown[] });
                toolResults.push({ callId, content });
            } else if (isThinkingPart(part)) {
                // LanguageModelThinkingPart — model's internal reasoning/thinking
                // content. Collected into `reasoningParts` (separate from
                // `textParts`) so it goes into the assistant message's
                // `reasoning_content` field, NOT `content`. This matches LiteLLM's
                // `reasoning_content` convention for reasoning-native providers
                // (GLM-5.2, DeepSeek, Qwen, etc.) which accept and return
                // `reasoning_content` as a distinct field on assistant messages.
                //
                // Putting reasoning in `content` would be incorrect — the model
                // would see its reasoning as regular response text, not as
                // reasoning, which breaks the reasoning chain semantics and can
                // confuse the model about what it actually said vs. what it
                // thought. With `reasoning_content`, the model correctly
                // distinguishes "this was my internal reasoning before the tool
                // call" from "this was my visible response."
                //
                // See: https://docs.litellm.ai/docs/reasoning_content
                const thinkingText = getThinkingPartText(part);
                if (thinkingText) {
                    reasoningParts.push(thinkingText);
                    Logger.trace(`[convertMessages] Thinking part: ${thinkingText.length} chars → reasoning_content`);
                }
            }
        }

        let emittedAssistantToolCall = false;
        // Combine all reasoning parts into one string for the assistant message's
        // `reasoning_content` field. Only set on assistant-role messages; system
        // and user messages don't carry reasoning content.
        const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join("\n") : undefined;

        if (toolCalls.length > 0) {
            const messageContent = buildMessageContent(textParts, contentItems);
            out.push({
                role: "assistant",
                content: messageContent || undefined,
                tool_calls: toolCalls,
                ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            });
            emittedAssistantToolCall = true;
        }

        for (const tr of toolResults) {
            out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "Success" });
        }

        const text = textParts.join("");
        // A message that carries reasoning (reasoning_content) must be emitted
        // even without visible text: the model needs its prior reasoning to
        // continue a resumed turn. Content is an empty string then, not
        // undefined: a reasoning-only assistant turn must carry an explicit
        // string content field on the wire, regardless of whether the
        // receiving transform or provider normalizes a missing key.
        const hasReasoning = role === "assistant" && Boolean(reasoningContent);
        if (text || contentItems.length > 0 || hasReasoning) {
            if (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall)) {
                const messageContent = buildMessageContent(textParts, contentItems);
                if (messageContent || hasReasoning) {
                    out.push({
                        role: role || "user",
                        content: messageContent ?? "",
                        ...(reasoningContent && role === "assistant" ? { reasoning_content: reasoningContent } : {}),
                    });
                }
            }
        }
    }
    return out;
}

/**
 * Returns true for any MIME type that represents opaque prompt-caching metadata
 * rather than message content. These parts must be silently dropped at the
 * transport layer — decoding them produces strings like "ephemeral" or a raw
 * {"$mid":...,"mimeType":"cache_control",...} carrier object that, once injected
 * into user/assistant content, causes LLMs to fixate on the stray fragment and
 * abandon the active task.
 */
export function isCacheControlMimeType(mimeType: string): boolean {
    if (mimeType === "cache_control") {
        return true;
    }
    // Match any vnd.*cache-control* variant, regardless of suffix (+json, +text, etc.)
    return /cache[-_]control/i.test(mimeType);
}

/**
 * Build message content from text and content items.
 * If there are content items (images), return an array format.
 * Otherwise, return a simple string.
 */
function buildMessageContent(
    textParts: string[],
    contentItems: OpenAIChatMessageContentItem[]
): string | OpenAIChatMessageContentItem[] | undefined {
    const text = textParts.join("");

    if (contentItems.length === 0) {
        return text || undefined;
    }

    // If we have content items (images), create an array with both text and images
    const items: OpenAIChatMessageContentItem[] = [];
    if (text) {
        items.push({ type: "text", text });
    }
    items.push(...contentItems);

    return items.length > 0 ? items : undefined;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
    tools?: OpenAIFunctionToolDef[];
    tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
    const tools = options.tools ?? [];
    if (!tools || tools.length === 0) {
        return {};
    }

    const toolDefs: OpenAIFunctionToolDef[] = tools
        .filter((t): t is vscode.LanguageModelChatTool => t && typeof t === "object")
        .map((t: vscode.LanguageModelChatTool) => {
            const name = sanitizeFunctionName(t.name);
            const description = typeof t.description === "string" ? t.description : "";
            const params = sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} });
            return {
                type: "function" as const,
                function: {
                    name,
                    description,
                    parameters: params,
                },
            } satisfies OpenAIFunctionToolDef;
        });

    let tool_choice: "auto" | { type: "function"; function: { name: string } } | undefined = undefined;
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        if (tools.length !== 1) {
            Logger.error("ToolMode.Required but multiple tools:", tools.length);
            throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
        }
        tool_choice = { type: "function", function: { name: sanitizeFunctionName(tools[0].name) } };
    }
    // Note: tool_choice is NOT set to "auto" by default - only when explicitly Required.
    // The request builder will add tool_choice: "auto" if tools are present AND the model
    // supports tool_choice per its capabilities. This prevents passing unsupported tool_choice
    // to models like GPT-5.6 Azure that don't support the parameter.

    return { tools: toolDefs, ...(tool_choice !== undefined && { tool_choice }) };
}

/**
 * Validate tool names to ensure they contain only word chars, hyphens, or underscores.
 * @param tools Tools to validate.
 */
export function validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
    for (const tool of tools) {
        if (!tool.name.match(/^[\w-]+$/)) {
            Logger.error("Invalid tool name detected:", tool.name);
            throw new Error(
                `Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`
            );
        }
    }
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * @param messages The full request message list.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
    if (messages.length === 0) {
        Logger.error("No messages in request");
        throw new Error("Invalid request: no messages.");
    }

    for (const message of messages) {
        if (!message.content || message.content.length === 0) {
            Logger.error("Empty message content in request");
            throw new Error("Invalid request: empty message content.");
        }
    }

    messages.forEach((message, i) => {
        if (message.content.length === 0) {
            Logger.error(`Validation failed: message at index ${i} has empty content`);
            throw new Error("Invalid request: empty message content.");
        }
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            const toolCallIds = new Set(
                message.content
                    .filter((part) => part instanceof vscode.LanguageModelToolCallPart)
                    .map((part) => (part as unknown as vscode.LanguageModelToolCallPart).callId)
            );
            if (toolCallIds.size === 0) {
                return;
            }

            let nextMessageIdx = i + 1;
            const errMsg =
                "Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";
            while (toolCallIds.size > 0) {
                const nextMessage = messages[nextMessageIdx++];
                if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
                    Logger.error("Validation failed: missing tool result for call IDs:", Array.from(toolCallIds));
                    throw new Error(errMsg);
                }

                nextMessage.content.forEach((part) => {
                    if (!isToolResultPart(part)) {
                        const ctorName =
                            (Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)
                                ?.constructor?.name ?? typeof part;
                        Logger.error("Validation failed: expected tool result part, got:", ctorName);
                        throw new Error(errMsg);
                    }
                    const callId = (part as { callId: string }).callId;
                    toolCallIds.delete(callId);
                });
            }
        }
    });
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: readonly unknown[] } {
    if (!value || typeof value !== "object") {
        return false;
    }
    const obj = value as Record<string, unknown>;
    const hasCallId = typeof obj.callId === "string";
    const hasContent = "content" in obj;
    return hasCallId && hasContent;
}

/**
 * Detects `LanguageModelThinkingPart` (a proposed-API class for model
 * reasoning/thinking content) without a static `instanceof` check. The class
 * may not be available in all VS Code builds, so we resolve it lazily from the
 * `vscode` namespace and fall back to duck-typing on the `value` + `id` shape.
 */
export function isThinkingPart(value: unknown): boolean {
    if (!value || typeof value !== "object") {
        return false;
    }
    // Try instanceof first (most reliable when the class is available).
    const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
        (new (...args: unknown[]) => unknown) | undefined;
    if (ThinkingPart && value instanceof ThinkingPart) {
        return true;
    }
    // Duck-type fallback: has a `value` property that's string or string[].
    const obj = value as Record<string, unknown>;
    return (
        "value" in obj &&
        (typeof obj.value === "string" || (Array.isArray(obj.value) && obj.value.every((v) => typeof v === "string")))
    );
}

/**
 * Extracts the text content from a `LanguageModelThinkingPart`. Joins
 * string arrays with newlines.
 */
export function getThinkingPartText(part: unknown): string {
    const obj = part as { value?: string | string[] };
    if (!obj || !obj.value) {
        return "";
    }
    return Array.isArray(obj.value) ? obj.value.join("\n") : obj.value;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
function collectToolResultText(pr: { content?: readonly unknown[] }): string {
    let text = "";
    for (const c of pr.content ?? []) {
        if (c instanceof vscode.LanguageModelTextPart) {
            text += c.value;
        } else if (c instanceof vscode.LanguageModelDataPart) {
            if (isCacheControlMimeType(c.mimeType)) {
                Logger.trace(`[collectToolResultText] Dropping cache_control part (mimeType: ${c.mimeType})`);
                continue;
            }
            if (c.mimeType.startsWith("text/") || c.mimeType.includes("json")) {
                text += Buffer.from(c.data).toString("utf-8");
            }
        } else if (typeof c === "string") {
            text += c;
        } else {
            try {
                text += JSON.stringify(c);
            } catch {
                /* ignore */
            }
        }
    }
    return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
    try {
        if (!text || !/[{]/.test(text)) {
            return { ok: false };
        }
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { ok: true, value: parsed as Record<string, unknown> };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}

/**
 * Derives a human-readable group name from a URL by returning the hostname and
 * non-default port (if present). Returns an empty string for invalid or empty
 * input so callers can fall back to other heuristics.
 */
export function deriveGroupNameFromUrl(url: string): string {
    if (typeof url !== "string" || url.length === 0) {
        return "";
    }
    try {
        const parsed = new URL(url);
        const isDefaultPort =
            (parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443")) ||
            (parsed.protocol === "http:" && (parsed.port === "" || parsed.port === "80"));
        return parsed.hostname + (parsed.port && !isDefaultPort ? `:${parsed.port}` : "");
    } catch {
        return "";
    }
}
