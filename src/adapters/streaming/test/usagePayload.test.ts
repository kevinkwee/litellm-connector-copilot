import * as assert from "assert";
import { normalizeUsagePayload, type RawUsagePayload } from "../usagePayload";

suite("normalizeUsagePayload", () => {
    test("reads LiteLLM Anthropic cache counters from prompt tokens details", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 1000,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 400, cache_creation_tokens: 100 },
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 400,
        });

        assert.strictEqual(usage.prompt_tokens, 1000);
        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 400);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 100);
    });

    test("preserves the OpenAI-style cache creation detail spelling", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 500,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 100, cache_creation_input_tokens: 25 },
        });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 100);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 25);
    });

    test("reads cache counters from input token details for /responses usage", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 700,
            completion_tokens: 10,
            input_token_details: { cached_tokens: 200, cache_creation_input_tokens: 30 },
        });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 200);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 30);
    });

    test("reads the plural /responses detail objects LiteLLM's ResponseAPIUsage emits", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 700,
            completion_tokens: 40,
            input_tokens_details: { cached_tokens: 250, cache_creation_input_tokens: 35 },
            output_tokens_details: { reasoning_tokens: 12, tool_tokens: 4 },
        });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 250);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 35);
        assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 12);
        assert.strictEqual(usage.completion_tokens_details?.tool_tokens, 4);
    });

    test("prefers the plural detail objects over the singular ones", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 700,
            completion_tokens: 40,
            input_tokens_details: { cached_tokens: 250 },
            input_token_details: { cached_tokens: 200 },
            output_tokens_details: { reasoning_tokens: 12 },
            output_token_details: { reasoning_tokens: 9 },
        });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 250);
        assert.strictEqual(usage.completion_tokens_details?.reasoning_tokens, 12);
    });

    test("reads top-level Anthropic cache counters when details are absent", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 900,
            completion_tokens: 20,
            cache_creation_input_tokens: 60,
            cache_read_input_tokens: 300,
        });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 300);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 60);
    });

    test("prefers prompt tokens details over the top-level counters", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 900,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 100, cache_creation_tokens: 10 },
            cache_creation_input_tokens: 60,
            cache_read_input_tokens: 300,
        });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 100);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, 10);
    });

    test("keeps cached tokens zero when a details object carries no counts", () => {
        const emptyDetails: RawUsagePayload = { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: {} };
        const usage = normalizeUsagePayload(emptyDetails);

        assert.ok(usage.prompt_tokens_details);
        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 0);
        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_input_tokens, undefined);
    });

    test("keeps cached tokens zero when the plural details object carries no counts", () => {
        const usage = normalizeUsagePayload({ prompt_tokens: 5, completion_tokens: 5, input_tokens_details: {} });

        assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 0);
    });

    test("preserves the cache-creation tier split", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 1_000,
            completion_tokens: 10,
            prompt_tokens_details: {
                cache_creation_input_tokens: 1_000,
                cache_creation_token_details: {
                    ephemeral_5m_input_tokens: 400,
                    ephemeral_1h_input_tokens: 600,
                },
            },
        });

        assert.deepStrictEqual(usage.prompt_tokens_details?.cache_creation_token_details, {
            ephemeral_5m_input_tokens: 400,
            ephemeral_1h_input_tokens: 600,
        });
    });

    test("omits the tier split when neither count is reported", () => {
        const usage = normalizeUsagePayload({
            prompt_tokens: 1_000,
            completion_tokens: 10,
            prompt_tokens_details: { cache_creation_input_tokens: 1_000, cache_creation_token_details: {} },
        });

        assert.strictEqual(usage.prompt_tokens_details?.cache_creation_token_details, undefined);
    });

    test("omits token details when the usage frame has none", () => {
        const usage = normalizeUsagePayload({ prompt_tokens: 5, completion_tokens: 5 });

        assert.strictEqual(usage.prompt_tokens_details, undefined);
        assert.strictEqual(usage.completion_tokens_details, undefined);
        assert.strictEqual(usage.prompt_tokens, 5);
        assert.strictEqual(usage.total_tokens, 10);
    });
});
