import { LiteLLMApiError } from "../../adapters/litellmClient";
import { UpstreamStreamError } from "../../utils/transportRetry";

/** Fields a log entry may carry about a failure. */
export type ErrorLogFields = Record<string, string | number | undefined>;

/** The prefix the client puts on a proxy rejection, which carries the body in its message. */
const UPSTREAM_MESSAGE_PATTERN = /^LiteLLM API error: (\d{3})\b/;

/**
 * Extracts upstream error identifiers from a LiteLLM error body.
 *
 * The body is external input: a proxy may answer with HTML, an empty string, or
 * a JSON document whose `error` member is a string. Anything unexpected yields
 * no identifiers rather than a thrown error inside the failure path.
 */
function readUpstreamErrorIdentifiers(bodyText: string): { type?: string; code?: string } {
    if (bodyText.length === 0) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(bodyText);
    } catch {
        return {};
    }
    if (parsed === null || typeof parsed !== "object") {
        return {};
    }
    const errorMember = (parsed as { error?: unknown }).error;
    if (errorMember === null || typeof errorMember !== "object") {
        return {};
    }
    const { type, code } = errorMember as { type?: unknown; code?: unknown };
    const toText = (value: unknown): string | undefined => {
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
        if (typeof value === "number") {
            return String(value);
        }
        return undefined;
    };
    return { type: toText(type), code: toText(code) };
}

/**
 * Builds the log fields for a failure.
 *
 * Upstream error text is model output or proxy internals: a rejected request
 * body can echo the prompt, and a mid-stream failure detail can carry generated
 * content. Logs therefore keep identifiers, sizes, and names only. Connector and
 * network errors keep their message, which the connector itself wrote or the
 * runtime produced.
 */
export function toErrorLogFields(err: unknown): ErrorLogFields {
    if (err instanceof UpstreamStreamError) {
        return {
            errorName: err.name,
            status: err.status,
            upstreamErrorCode: err.code,
            upstreamErrorType: err.type,
            detailLength: err.detail?.length,
        };
    }

    if (err instanceof LiteLLMApiError) {
        const identifiers = readUpstreamErrorIdentifiers(err.bodyText);
        return {
            errorName: err.name,
            status: err.status,
            upstreamErrorType: identifiers.type,
            upstreamErrorCode: identifiers.code,
            bodyLength: err.bodyText.length,
        };
    }

    if (err instanceof Error) {
        // A plain Error can still carry the client's prefix when another layer
        // wrapped or re-created the rejection, and that message holds the body.
        // Only the status survives.
        const upstreamMatch = UPSTREAM_MESSAGE_PATTERN.exec(err.message);
        if (upstreamMatch) {
            return {
                errorName: err.name,
                status: Number(upstreamMatch[1]),
                messageLength: err.message.length,
            };
        }
        const cause = err.cause;
        // A cause that is itself an upstream failure carries a body, so it is
        // reduced to nothing instead of contributing its message.
        const causeMessage =
            cause instanceof Error &&
            !(cause instanceof LiteLLMApiError) &&
            !(cause instanceof UpstreamStreamError) &&
            !UPSTREAM_MESSAGE_PATTERN.test(cause.message)
                ? cause.message
                : undefined;
        return {
            errorName: err.name,
            errorMessage: err.message,
            rootCause: causeMessage,
            errorStack: err.stack,
        };
    }

    // A thrown non-Error has no trustworthy message, so only its type is recorded.
    return { errorName: typeof err };
}

/**
 * Shortens a failure to a label that names it without disclosing its text.
 * Used where a log line needs a single readable token, such as a retry message.
 */
export function describeFailureForLog(err: unknown): string {
    const fields = toErrorLogFields(err);
    const status = fields.status === undefined ? "" : `:${fields.status}`;
    return `${fields.errorName ?? "Error"}${status}`;
}
