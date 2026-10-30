import { UpstreamStreamError } from "../../utils/transportRetry";

/** Longest upstream error detail carried into the user-facing message. */
const UPSTREAM_ERROR_DETAIL_MAX_CHARS = 300;

function readText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Reads an HTTP status from an error frame. LiteLLM's ProxyException puts the
 * status in `code`, so a three-digit `code` counts; a symbolic code such as
 * `invalid_request_error` does not.
 */
function readUpstreamStatus(error: Record<string, unknown>): number | undefined {
    for (const candidate of [error.status, error.status_code, error.code]) {
        if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
            return candidate;
        }
        if (typeof candidate === "string" && /^\d{3}$/.test(candidate.trim())) {
            return Number(candidate.trim());
        }
    }
    return undefined;
}

function toUpstreamStreamError(error: unknown): UpstreamStreamError | undefined {
    if (typeof error === "string") {
        return new UpstreamStreamError(
            undefined,
            undefined,
            undefined,
            error.trim().slice(0, UPSTREAM_ERROR_DETAIL_MAX_CHARS) || undefined
        );
    }
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const record = error as Record<string, unknown>;
    const status = readUpstreamStatus(record);
    const code = readText(record.code);
    const type = readText(record.type);
    const detail = (readText(record.message) ?? readText(record.detail))?.slice(0, UPSTREAM_ERROR_DETAIL_MAX_CHARS);
    if (status === undefined && code === undefined && type === undefined && detail === undefined) {
        return undefined;
    }
    return new UpstreamStreamError(status, code, type, detail);
}

/**
 * Reads an in-stream failure frame. Recognized shapes:
 * - `{"error": {...}}`: the LiteLLM proxy's mid-stream failure after the
 *   response headers were already sent;
 * - `{"type": "error", ...}`: an OpenAI Responses API error event;
 * - `{"type": "response.failed", "response": {"error": {...}}}`.
 *
 * Returns `undefined` for a frame that reports no failure. A recognized failure
 * shape without a status, code, type, or detail still produces an error carrying
 * the frame's `message`.
 */
export function extractUpstreamStreamError(data: Record<string, unknown>): UpstreamStreamError | undefined {
    if (data.type === "response.failed") {
        const response = data.response as Record<string, unknown> | undefined;
        return (
            toUpstreamStreamError(response?.error ?? response) ??
            new UpstreamStreamError(undefined, undefined, "response.failed", readText(data.message))
        );
    }
    if (data.error !== undefined && data.error !== null) {
        return (
            toUpstreamStreamError(data.error) ??
            new UpstreamStreamError(undefined, undefined, "error", readText(data.message))
        );
    }
    if (data.type === "error") {
        return (
            toUpstreamStreamError(data) ??
            new UpstreamStreamError(undefined, undefined, "error", readText(data.message))
        );
    }
    return undefined;
}
