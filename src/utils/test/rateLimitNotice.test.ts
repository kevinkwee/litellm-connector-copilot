import * as assert from "assert";

import { appendRateLimitHint } from "../rateLimitNotice";

const SETTING = "litellm-connector.rateLimitMaxDelaySeconds";

suite("rateLimitNotice", () => {
    suite("appendRateLimitHint", () => {
        test("explains a Retry-After longer than the wait left, in whole seconds", () => {
            const message = appendRateLimitHint("Rate limit reached", {
                reason: "retry_after_exceeds_budget",
                waitedMs: 30_500,
                budgetMs: 120_000,
                retryAfterMs: 89_600,
            });

            assert.strictEqual(
                message,
                `Rate limit reached. The proxy asked to retry in 90s, more than the 89s left under ${SETTING}, ` +
                    `so the request was not retried. Try again later, or raise the setting.`
            );
        });

        test("reports how long it waited once the budget is spent", () => {
            const message = appendRateLimitHint("Rate limit reached", {
                reason: "budget_exhausted",
                waitedMs: 120_000,
                budgetMs: 120_000,
            });

            assert.strictEqual(
                message,
                `Rate limit reached. Still rate limited after waiting 120s, the most ${SETTING} allows. ` +
                    `Try again later, or raise the setting.`
            );
        });

        test("names the setting that turned retries off", () => {
            const message = appendRateLimitHint("Rate limit reached", {
                reason: "retries_disabled",
                waitedMs: 0,
                budgetMs: 0,
            });

            assert.strictEqual(message, `Rate limit reached. Rate-limit retries are off because ${SETTING} is 0.`);
        });

        test("does not double the period after a message that already ends a sentence", () => {
            const message = appendRateLimitHint("Please try again in 20s. \n", {
                reason: "retries_disabled",
                waitedMs: 0,
                budgetMs: 0,
            });

            assert.ok(message.startsWith("Please try again in 20s. Rate-limit retries are off"), message);
        });

        test("keeps a long interior whitespace run from the proxy intact", () => {
            const proxyMessage = `limit${" ".repeat(50_000)}reached`;

            const message = appendRateLimitHint(proxyMessage, {
                reason: "retries_disabled",
                waitedMs: 0,
                budgetMs: 0,
            });

            assert.strictEqual(message, `${proxyMessage}. Rate-limit retries are off because ${SETTING} is 0.`);
        });

        test("strips a long trailing run of periods and whitespace", () => {
            const message = appendRateLimitHint(`limit reached${". ".repeat(50_000)}`, {
                reason: "retries_disabled",
                waitedMs: 0,
                budgetMs: 0,
            });

            assert.strictEqual(message, `limit reached. Rate-limit retries are off because ${SETTING} is 0.`);
        });

        test("returns the hint alone for a blank message", () => {
            const message = appendRateLimitHint(" . ", { reason: "retries_disabled", waitedMs: 0, budgetMs: 0 });

            assert.strictEqual(message, `Rate-limit retries are off because ${SETTING} is 0.`);
        });
    });
});
