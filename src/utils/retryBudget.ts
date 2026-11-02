import { HeadersTimeoutError, InactivityTimeoutError } from "./transportRetry";

/** Default retry budget, in milliseconds, for a request that declares no budget. */
export const DEFAULT_RETRY_BUDGET_MS = 300_000;

/**
 * Wall-clock budget for the retry phase of one chat request.
 *
 * The clock starts at the first failure, so the time before it, which includes the
 * first attempt however long it ran, is not charged. Everything after it is: each
 * failed retry attempt and each backoff sleep counts. The budget gates only
 * *starting* another attempt, so an attempt already in flight runs to its own
 * bound, and the backoff sleep is clipped to the time left. A budget of 0 or less
 * disables the bound.
 */
export class RetryBudget {
    private startedAt: number | undefined;

    public constructor(
        public readonly budgetMs: number,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Milliseconds left before another attempt may start, or `Infinity` when the
     * budget is disabled. Before the first failure the whole budget is available.
     * Once the budget is overspent the result is negative.
     */
    public remainingMs(): number {
        if (this.budgetMs <= 0) {
            return Number.POSITIVE_INFINITY;
        }
        if (this.startedAt === undefined) {
            return this.budgetMs;
        }
        return this.budgetMs - (this.now() - this.startedAt);
    }

    /** True when the retry phase has used up its budget. */
    public isExhausted(): boolean {
        return this.remainingMs() <= 0;
    }

    /**
     * Records a failure and reports whether another attempt may start.
     *
     * The call that starts the clock always allows the retry: the failure that
     * begins the retry phase is not itself charged against the budget.
     */
    public markFailure(): boolean {
        if (this.startedAt === undefined) {
            this.startedAt = this.now();
            return true;
        }
        return !this.isExhausted();
    }

    /** A backoff delay clipped to the budget's remaining time, never negative. */
    public clipDelay(delayMs: number): number {
        return Math.max(0, Math.min(delayMs, this.remainingMs()));
    }
}

/** Renders a budget as a compact duration, keeping a sub-second value readable. */
function formatBudget(budgetMs: number): string {
    if (budgetMs < 1_000) {
        return `${budgetMs}ms`;
    }
    const seconds = budgetMs / 1_000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/**
 * The error a request ends with when its retry budget stops it.
 *
 * Connector-authored, so the text is safe to log. It names the setting that
 * bounded the turn and never quotes the upstream failure, which may echo the
 * prompt. When the last failure was one of the connector's own time budgets, the
 * setting that would actually help is named too.
 */
export function retryBudgetError(budgetMs: number, lastError: unknown): Error {
    let hint = "";
    if (lastError instanceof HeadersTimeoutError) {
        hint = " The last attempt produced no response headers within litellm-connector.headersTimeout.";
    } else if (lastError instanceof InactivityTimeoutError) {
        hint = " The last attempt streamed nothing within litellm-connector.inactivityTimeout.";
    }
    return new Error(
        `LiteLLM: stopped retrying after ${formatBudget(budgetMs)} of retries ` +
            `(litellm-connector.retryBudgetSeconds). The response is incomplete.${hint}`,
        { cause: lastError }
    );
}
