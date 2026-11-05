import * as assert from "assert";
import { RetryBudget, retryBudgetError } from "../retryBudget";
import { HeadersTimeoutError, InactivityTimeoutError } from "../transportRetry";

/** A clock the test advances by hand. */
function createClock(): { now: () => number; advance: (ms: number) => void } {
    let current = 1_000;
    return {
        now: () => current,
        advance: (ms: number) => {
            current += ms;
        },
    };
}

suite("RetryBudget", () => {
    test("offers the whole budget before the first failure", () => {
        const clock = createClock();
        const budget = new RetryBudget(1_000, clock.now);

        clock.advance(5_000);

        assert.strictEqual(budget.remainingMs(), 1_000, "time before the retry phase is not charged");
    });

    test("starts the clock on the first failure, which is not charged against it", () => {
        const clock = createClock();
        const budget = new RetryBudget(1_000, clock.now);

        const mayRetry = budget.markFailure();
        clock.advance(400);

        assert.strictEqual(mayRetry, true);
        assert.strictEqual(budget.remainingMs(), 600);
    });

    test("refuses the next attempt when the budget is exactly spent", () => {
        // The boundary: elapsed == budget leaves nothing, so no attempt starts.
        const clock = createClock();
        const budget = new RetryBudget(1_000, clock.now);
        budget.markFailure();

        clock.advance(1_000);

        assert.strictEqual(budget.isExhausted(), true);
        assert.strictEqual(budget.markFailure(), false);
    });

    test("allows an attempt when one millisecond is left", () => {
        const clock = createClock();
        const budget = new RetryBudget(1_000, clock.now);
        budget.markFailure();

        clock.advance(999);

        assert.strictEqual(budget.isExhausted(), false);
        assert.strictEqual(budget.markFailure(), true);
    });

    test("clips a backoff delay to the time left", () => {
        const clock = createClock();
        const budget = new RetryBudget(1_000, clock.now);
        budget.markFailure();
        clock.advance(700);

        assert.strictEqual(budget.clipDelay(5_000), 300);
        assert.strictEqual(budget.clipDelay(100), 100);
    });

    test("never returns a negative delay", () => {
        const clock = createClock();
        const budget = new RetryBudget(1_000, clock.now);
        budget.markFailure();
        clock.advance(2_000);

        assert.strictEqual(budget.clipDelay(500), 0);
    });

    test("a zero budget disables the bound", () => {
        const clock = createClock();
        const budget = new RetryBudget(0, clock.now);
        budget.markFailure();
        clock.advance(1_000_000);

        assert.strictEqual(budget.remainingMs(), Number.POSITIVE_INFINITY);
        assert.strictEqual(budget.isExhausted(), false);
        assert.strictEqual(budget.markFailure(), true);
        assert.strictEqual(budget.clipDelay(5_000), 5_000);
    });
});

suite("retryBudgetError", () => {
    test("names the setting that bounded the retries", () => {
        const error = retryBudgetError(300_000, new TypeError("terminated"));

        assert.match(error.message, /litellm-connector\.retryBudgetSeconds/);
        assert.match(error.message, /300s/);
        assert.match(error.message, /The response is incomplete/);
        assert.strictEqual(error.cause instanceof Error, true);
    });
    test("names the headers setting when that is what the last attempt hit", () => {
        const error = retryBudgetError(300_000, new HeadersTimeoutError(300_000));

        assert.match(error.message, /produced no response headers within litellm-connector\.headersTimeout/);
        assert.doesNotMatch(error.message, /HTTP runtime's own header limit/);
    });

    test("names the runtime's own limit when that is what the last attempt hit", () => {
        const error = retryBudgetError(300_000, new HeadersTimeoutError(300_000, "runtime"));

        assert.doesNotMatch(error.message, /produced no response headers within litellm-connector/);
        assert.match(error.message, /HTTP runtime's own header limit/);
    });

    test("names the inactivity setting when that is what the last attempt hit", () => {
        const error = retryBudgetError(300_000, new InactivityTimeoutError(60_000, 3));

        assert.match(error.message, /litellm-connector\.inactivityTimeout/);
    });

    test("never quotes the upstream failure", () => {
        // The connector-authored message is logged verbatim, so upstream text, which
        // can echo the prompt, must not reach it.
        const upstreamText = 'LiteLLM API error: 400 Bad Request\n{"detail":"prompt: secret customer text"}';

        const error = retryBudgetError(300_000, new Error(upstreamText));

        assert.strictEqual(error.message.includes("secret customer text"), false);
    });

    test("renders a fractional budget without losing it", () => {
        const error = retryBudgetError(400, new TypeError("terminated"));

        assert.match(error.message, /400ms/);
    });

    test("renders a whole-second budget as seconds", () => {
        const error = retryBudgetError(90_000, new TypeError("terminated"));

        assert.match(error.message, /90s/);
    });

    test("renders a fractional second budget with one decimal", () => {
        const error = retryBudgetError(1_500, new TypeError("terminated"));

        assert.match(error.message, /1\.5s/);
    });

    test("treats a negative budget as disabled", () => {
        // ConfigManager clamps to 0, so a negative value can only arrive from a
        // caller that bypassed it. It must not turn into an instant give-up.
        const clock = createClock();
        const budget = new RetryBudget(-5, clock.now);

        assert.strictEqual(budget.isExhausted(), false);
        assert.strictEqual(budget.markFailure(), true);
        assert.strictEqual(budget.clipDelay(250), 250);
    });
});
