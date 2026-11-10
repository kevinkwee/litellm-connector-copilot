import { findRejectedParameter, LiteLLMApiError } from "../../adapters/litellmClient";

/** Parameter names whose refusal means the proxy refused the usage flag. */
const USAGE_OPT_OUT_PARAMETERS = new Set(["stream_options", "include_usage", "stream_options.include_usage"]);

/** The flag names a rejection body may mention. */
const USAGE_FLAG_NAMES = ["stream_options", "include_usage"] as const;

/** How close a refusal must sit to a flag name to describe that flag. */
const PROXIMITY_CHARS = 60;

/** Sentences end at a period, a newline, or a JSON-escaped newline. */
const SENTENCE_BREAK = /[.\n]|\\n/;

/** Wordings that turn a mentioned flag into a refused one. */
const REFUSAL_PHRASES = [
    "not supported",
    "unsupported",
    "does not support",
    "not permitted",
    // Two-word forms that name a refusal only together with a field name.
    "unknown field",
    "unknown name",
    "unrecognized field",
];

/**
 * Decides whether a rejection refused the `stream_options.include_usage` flag.
 *
 * The flag name alone is not enough. A proxy rejection can echo the request, and a
 * refusal of a different parameter would then look like a refusal of this one, which
 * would drop the usage flag (and with it every token and cost figure) for the rest of
 * the session.
 *
 * A body that names its rejected parameter is answered by that name alone, so a
 * refusal of another parameter is final even when the echoed request also carries the
 * flag. Only a body that names no parameter falls back to {@link PROXIMITY_CHARS},
 * where a refusal beside the flag in the same sentence is the evidence.
 *
 * A `LiteLLMApiError` carries the proxy body separately from its message, and the body
 * is where the proxy states what it refused.
 */
export function rejectsUsageOptOut(error: unknown): boolean {
    const text = readRejectionText(error);
    if (!text) {
        return false;
    }
    const named = findRejectedParameter(text);
    if (named) {
        return USAGE_OPT_OUT_PARAMETERS.has(named.toLowerCase());
    }
    return namesFlagNearRefusal(text);
}

function readRejectionText(error: unknown): string {
    if (error instanceof LiteLLMApiError && error.bodyText.trim().length > 0) {
        return error.bodyText;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : "";
}

function namesFlagNearRefusal(text: string): boolean {
    const lowered = text.toLowerCase();
    for (const flag of USAGE_FLAG_NAMES) {
        let index = lowered.indexOf(flag);
        while (index >= 0) {
            if (refusalNearFlag(lowered, index, flag.length)) {
                return true;
            }
            index = lowered.indexOf(flag, index + 1);
        }
    }
    return false;
}

/** True when a refusal phrase sits within the proximity window beside the flag. */
function refusalNearFlag(lowered: string, flagIndex: number, flagLength: number): boolean {
    const windowStart = Math.max(0, flagIndex - PROXIMITY_CHARS);
    const windowEnd = Math.min(lowered.length, flagIndex + flagLength + PROXIMITY_CHARS);
    const before = lowered.slice(windowStart, flagIndex);
    const after = lowered.slice(flagIndex + flagLength, windowEnd);
    const beforeSentence = before.split(SENTENCE_BREAK).pop() ?? "";
    const afterSentence = after.split(SENTENCE_BREAK)[0];
    return REFUSAL_PHRASES.some((phrase) => beforeSentence.includes(phrase) || afterSentence.includes(phrase));
}
