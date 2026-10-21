import type { RateLimitFailure } from "./rateLimitRetryPolicy";

const RATE_LIMIT_SETTING = "litellm-connector.rateLimitMaxDelaySeconds";
const MS_PER_SECOND = 1_000;

function describeRateLimitFailure(failure: RateLimitFailure): string {
    switch (failure.reason) {
        case "retries_disabled":
            return `Rate-limit retries are off because ${RATE_LIMIT_SETTING} is 0.`;
        case "budget_exhausted":
            return (
                `Still rate limited after waiting ${Math.round(failure.waitedMs / MS_PER_SECOND)}s, ` +
                `the most ${RATE_LIMIT_SETTING} allows. Try again later, or raise the setting.`
            );
        case "retry_after_exceeds_budget": {
            // Rounding the requested wait up and the time left down keeps the
            // comparison in the message true at whole-second precision.
            const requestedSeconds = Math.ceil((failure.retryAfterMs ?? 0) / MS_PER_SECOND);
            const remainingSeconds = Math.floor((failure.budgetMs - failure.waitedMs) / MS_PER_SECOND);
            return (
                `The proxy asked to retry in ${requestedSeconds}s, more than the ${remainingSeconds}s left ` +
                `under ${RATE_LIMIT_SETTING}, so the request was not retried. ` +
                `Try again later, or raise the setting.`
            );
        }
    }
}

/**
 * Drops the trailing periods and whitespace of a message. A backwards scan
 * keeps this linear, because the message carries proxy text of any length and
 * the equivalent `/[\s.]+$/` regex is quadratic on a long interior run.
 */
function stripSentenceEnd(message: string): string {
    let end = message.length;
    while (end > 0) {
        const char = message[end - 1];
        if (char !== "." && char.trim() !== "") {
            break;
        }
        end--;
    }
    return message.slice(0, end);
}

/**
 * Appends to a rate-limit error message why the connector stopped retrying and
 * which setting bounds the wait, so the user can tell a waiting problem from a
 * proxy one.
 */
export function appendRateLimitHint(message: string, failure: RateLimitFailure): string {
    const hint = describeRateLimitFailure(failure);
    const trimmedMessage = stripSentenceEnd(message);
    return trimmedMessage ? `${trimmedMessage}. ${hint}` : hint;
}
