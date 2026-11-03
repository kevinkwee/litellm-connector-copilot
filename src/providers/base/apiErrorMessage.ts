/**
 * Reads the user-facing message out of an upstream rejection body.
 *
 * The body is JSON with an `error.message` in LiteLLM's own shape, so that message
 * is preferred. A body without a usable `error.message` falls back to the first 200
 * characters of the raw text, because a wall of HTML or a stack trace does not
 * belong in a chat turn.
 */
export function parseApiError(statusCode: number, errorText: string): string {
    try {
        const parsed: unknown = JSON.parse(errorText);
        if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
            const errorObj = (parsed as Record<string, unknown>).error as unknown;
            if (errorObj && typeof errorObj === "object" && "message" in errorObj) {
                const message = (errorObj as Record<string, unknown>).message;
                if (typeof message === "string") {
                    return message;
                }
            }
        }
    } catch {
        // A non-JSON rejection body is handled by the fallbacks below.
    }
    if (errorText) {
        return errorText.slice(0, 200);
    }
    return `API request failed with status ${statusCode}`;
}
