import * as assert from "assert";

import { planRateLimitRetry, type RateLimitRetryDecision, type RateLimitRetryState } from "../rateLimitRetryPolicy";

const DEFAULT_BUDGET_MS = 120_000;

function plan(overrides: Partial<RateLimitRetryState>): RateLimitRetryDecision {
    return planRateLimitRetry({ attempt: 0, waitedMs: 0, budgetMs: DEFAULT_BUDGET_MS, ...overrides });
}

/** Replays a request that gets a 429 without Retry-After on every attempt. */
function collectBackoffWaits(budgetMs: number): number[] {
    const waits: number[] = [];
    let waitedMs = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
        const decision = planRateLimitRetry({ attempt, waitedMs, budgetMs });
        if (decision.kind === "give_up") {
            return waits;
        }
        waits.push(decision.delayMs);
        waitedMs += decision.delayMs;
    }
    throw new Error(`backoff did not give up within 100 attempts for a ${budgetMs}ms budget`);
}

suite("rateLimitRetryPolicy", () => {
    suite("planRateLimitRetry", () => {
        test("doubles the backoff from 500ms and fits the last wait to the default budget", () => {
            assert.deepStrictEqual(
                collectBackoffWaits(DEFAULT_BUDGET_MS),
                [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 56_500]
            );
        });

        test("caps each backoff wait at 60s and keeps retrying until a large budget is spent", () => {
            assert.deepStrictEqual(
                collectBackoffWaits(240_000),
                [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 56_500]
            );
        });

        test("keeps a huge attempt count at the backoff cap", () => {
            const decision = plan({ attempt: 5_000, budgetMs: 86_400_000 });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 60_000, source: "backoff" });
        });

        test("clips the backoff to the budget left", () => {
            const decision = plan({ attempt: 3, waitedMs: 119_000 });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 1_000, source: "backoff" });
        });

        test("waits exactly as long as Retry-After asks when it fits", () => {
            const decision = plan({ retryAfterMs: 2_000 });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 2_000, source: "retry_after" });
        });

        test("honors a Retry-After above the backoff cap when it fits", () => {
            const decision = plan({ retryAfterMs: 90_000 });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 90_000, source: "retry_after" });
        });

        test("waits when Retry-After equals the budget left", () => {
            const decision = plan({ waitedMs: 30_000, retryAfterMs: 90_000 });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 90_000, source: "retry_after" });
        });

        test("gives up at once when Retry-After is longer than the budget left", () => {
            const decision = plan({ waitedMs: 30_000, retryAfterMs: 90_001 });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "retry_after_exceeds_budget" });
        });

        test("gives up when Retry-After is longer than a fresh budget", () => {
            const decision = plan({ retryAfterMs: 300_000 });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "retry_after_exceeds_budget" });
        });

        test("treats a Retry-After of 0 as no header and backs off", () => {
            const decision = plan({ attempt: 2, retryAfterMs: 0 });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 2_000, source: "backoff" });
        });

        test("backs off when Retry-After is not a number", () => {
            const decision = plan({ retryAfterMs: Number.NaN });

            assert.deepStrictEqual(decision, { kind: "wait", delayMs: 500, source: "backoff" });
        });

        test("gives up when Retry-After is infinite", () => {
            const decision = plan({ retryAfterMs: Number.POSITIVE_INFINITY });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "retry_after_exceeds_budget" });
        });

        test("reports retries as disabled when the budget is 0", () => {
            const decision = plan({ budgetMs: 0, retryAfterMs: 1_000 });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "retries_disabled" });
        });

        test("reports retries as disabled when the budget is negative", () => {
            const decision = plan({ budgetMs: -1 });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "retries_disabled" });
        });

        test("reports the budget as spent once the waits reach it, even with a Retry-After", () => {
            const decision = plan({ attempt: 8, waitedMs: DEFAULT_BUDGET_MS, retryAfterMs: 1_000 });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "budget_exhausted" });
        });

        test("reports the budget as spent when the waits overshoot it", () => {
            const decision = plan({ attempt: 8, waitedMs: DEFAULT_BUDGET_MS + 1 });

            assert.deepStrictEqual(decision, { kind: "give_up", reason: "budget_exhausted" });
        });
    });
});
