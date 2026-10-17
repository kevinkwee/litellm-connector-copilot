/**
 * Parses tool calls that some LiteLLM backends stream as tagged text payloads
 * instead of structured `delta.tool_calls` arrays. The tag constants are built
 * from string fragments so tag literals never appear in source code.
 */

export interface ParsedTextToolCall {
    id?: string;
    name: string;
    args: string;
}

export const TAGGED_CALL_OPENER = "<" + "tool_call>";
export const TAGGED_CALL_CLOSER = "<" + "/" + "tool_call>";
export const PIPE_OPENER = "<" + "|tool_call_begin|>";
export const PIPE_CLOSER = "<" + "|tool_call_end|>";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function taggedPayloadPattern(opener: string, closer: string): RegExp {
    return new RegExp(escapeRegExp(opener) + "([\\s\\S]*?)" + escapeRegExp(closer), "g");
}

interface TextToolPayload {
    tool_calls?: unknown[];
    function?: unknown;
    name?: unknown;
    id?: unknown;
    arguments?: unknown;
    input?: unknown;
}

function toJsonArgumentString(value: unknown): string {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return "{}";
        }
        try {
            JSON.parse(trimmed);
            return trimmed;
        } catch {
            return JSON.stringify({ value });
        }
    }

    if (value === undefined || value === null) {
        return "{}";
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "{}";
        }
    }

    return JSON.stringify({ value });
}

function parseTextToolPayload(payload: unknown): ParsedTextToolCall[] {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    const record = payload as TextToolPayload;

    if (Array.isArray(record.tool_calls)) {
        const calls: ParsedTextToolCall[] = [];
        for (const entry of record.tool_calls) {
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const callRecord = entry as TextToolPayload;
            const fn =
                callRecord.function && typeof callRecord.function === "object"
                    ? (callRecord.function as { name?: unknown; arguments?: unknown })
                    : undefined;
            const name =
                typeof fn?.name === "string"
                    ? fn.name
                    : typeof callRecord.name === "string"
                      ? callRecord.name
                      : undefined;

            if (!name) {
                continue;
            }

            calls.push({
                id: typeof callRecord.id === "string" ? callRecord.id : undefined,
                name,
                args: toJsonArgumentString(fn?.arguments ?? callRecord.arguments),
            });
        }
        return calls;
    }

    const functionObject =
        record.function && typeof record.function === "object"
            ? (record.function as { name?: unknown; arguments?: unknown })
            : undefined;
    const name =
        typeof record.name === "string"
            ? record.name
            : typeof functionObject?.name === "string"
              ? functionObject.name
              : undefined;
    if (!name) {
        return [];
    }

    return [
        {
            id: typeof record.id === "string" ? record.id : undefined,
            name,
            args: toJsonArgumentString(record.arguments ?? functionObject?.arguments ?? record.input),
        },
    ];
}

/**
 * Extracts complete tagged tool calls from `text`, returning the text with the
 * parsed calls removed plus the normalized calls themselves. Payloads that are
 * not valid JSON are left in the text unchanged.
 */
export function parseTaggedToolCalls(text: string): {
    textWithoutParsedCalls: string;
    toolCalls: ParsedTextToolCall[];
} {
    const toolCalls: ParsedTextToolCall[] = [];
    let remaining = text;

    const patterns = [
        taggedPayloadPattern(TAGGED_CALL_OPENER, TAGGED_CALL_CLOSER),
        taggedPayloadPattern(PIPE_OPENER, PIPE_CLOSER),
    ];

    for (const pattern of patterns) {
        remaining = remaining.replace(pattern, (fullMatch: string, payloadText: string): string => {
            const payloadTrimmed = payloadText.trim();
            if (!payloadTrimmed) {
                return "";
            }
            try {
                const parsedPayload = JSON.parse(payloadTrimmed) as unknown;
                const parsedCalls = parseTextToolPayload(parsedPayload);
                if (parsedCalls.length > 0) {
                    toolCalls.push(...parsedCalls);
                    return "";
                }
            } catch {
                // Keep the original payload in the text so partial or unknown
                // formats are visible to the caller instead of being dropped.
            }
            return fullMatch;
        });
    }

    return { textWithoutParsedCalls: remaining, toolCalls };
}

/**
 * Splits streamed text into the part that is safe to emit now and a pending
 * tail holding an opener whose closer has not arrived yet, so partial tagged
 * tool calls are never emitted as visible text.
 */
export function splitStableTextAndPendingTaggedContent(text: string): { stableText: string; pendingText: string } {
    const openers = [TAGGED_CALL_OPENER, PIPE_OPENER];
    const closestOpenIndex = Math.max(...openers.map((token) => text.lastIndexOf(token)));
    if (closestOpenIndex < 0) {
        return { stableText: text, pendingText: "" };
    }

    const pendingCandidate = text.slice(closestOpenIndex);
    const hasClosingTag = pendingCandidate.includes(TAGGED_CALL_CLOSER) || pendingCandidate.includes(PIPE_CLOSER);
    if (hasClosingTag) {
        return { stableText: text, pendingText: "" };
    }

    return {
        stableText: text.slice(0, closestOpenIndex),
        pendingText: pendingCandidate,
    };
}
