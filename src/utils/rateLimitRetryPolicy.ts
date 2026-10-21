/** Why the client stopped retrying a 429 response. */
export type RateLimitGiveUpReason = "retries_disabled" | "budget_exhausted" | "retry_after_exceeds_budget";

/** Where a 429 wait came from: the proxy's Retry-After header, or the client's own backoff. */
export type RateLimitWaitSource = "retry_after" | "backoff";

/** Retry progress of one call to the proxy at the moment it receives a 429. */
export interface RateLimitRetryState {
    /** Waits already taken in this call. */
    readonly attempt: number;
    /** Sum of the waits already taken, in milliseconds. */
    readonly waitedMs: number;
    /** Most this call may wait in total, in milliseconds. */
    readonly budgetMs: number;
    /** Wait the proxy asked for through Retry-After, when the header is usable. */
    readonly retryAfterMs?: number;
}

export type RateLimitRetryDecision =
    | { readonly kind: "wait"; readonly delayMs: number; readonly source: RateLimitWaitSource }
    | { readonly kind: "give_up"; readonly reason: RateLimitGiveUpReason };

/** Facts about a rate-limited call the client stopped retrying. */
export interface RateLimitFailure {
    readonly reason: RateLimitGiveUpReason;
    readonly waitedMs: number;
    readonly budgetMs: number;
    readonly retryAfterMs?: number;
}

const BACKOFF_BASE_MS = 500;

/**
 * Longest single backoff wait. It keeps a large budget from turning into one
 * wait of several minutes. Retry-After is exempt because the proxy knows when
 * its limit resets.
 */
const MAX_BACKOFF_WAIT_MS = 60_000;

/**
 * Decides whether a call that just received a 429 waits and retries, and for
 * how long.
 *
 * Retry-After is honored exactly when it fits in what is left of the budget.
 * When it does not fit, the call gives up at once, because waiting out the rest
 * of the budget would only buy a retry the proxy already said it would reject.
 * A Retry-After of 0 carries no usable wait, so it gets the backoff instead of
 * a tight retry loop.
 */
export function planRateLimitRetry(state: RateLimitRetryState): RateLimitRetryDecision {
    if (state.budgetMs <= 0) {
        return { kind: "give_up", reason: "retries_disabled" };
    }

    const remainingMs = state.budgetMs - state.waitedMs;
    if (remainingMs <= 0) {
        return { kind: "give_up", reason: "budget_exhausted" };
    }

    if (state.retryAfterMs !== undefined && state.retryAfterMs > 0) {
        return state.retryAfterMs <= remainingMs
            ? { kind: "wait", delayMs: state.retryAfterMs, source: "retry_after" }
            : { kind: "give_up", reason: "retry_after_exceeds_budget" };
    }

    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** state.attempt, MAX_BACKOFF_WAIT_MS);
    return { kind: "wait", delayMs: Math.min(backoffMs, remainingMs), source: "backoff" };
}
