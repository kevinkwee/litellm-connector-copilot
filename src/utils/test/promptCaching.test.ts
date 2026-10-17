import * as assert from "assert";
import {
    DEFAULT_ANTHROPIC_PROMPT_CACHING,
    normalizeAnthropicPromptCachingMode,
    resolveAnthropicCacheControl,
} from "../promptCaching";
import type { LiteLLMModelInfo } from "../../types";

function anthropicInfo(overrides?: Partial<LiteLLMModelInfo>): LiteLLMModelInfo {
    return { litellm_provider: "anthropic", supports_prompt_caching: true, ...overrides } as LiteLLMModelInfo;
}

suite("promptCaching", () => {
    suite("normalizeAnthropicPromptCachingMode", () => {
        test("passes through each valid mode", () => {
            assert.strictEqual(normalizeAnthropicPromptCachingMode("off"), "off");
            assert.strictEqual(normalizeAnthropicPromptCachingMode("5m"), "5m");
            assert.strictEqual(normalizeAnthropicPromptCachingMode("1h"), "1h");
        });

        test("falls back to the 5m default for anything else", () => {
            assert.strictEqual(normalizeAnthropicPromptCachingMode("weekly"), DEFAULT_ANTHROPIC_PROMPT_CACHING);
            assert.strictEqual(normalizeAnthropicPromptCachingMode(6), DEFAULT_ANTHROPIC_PROMPT_CACHING);
            assert.strictEqual(normalizeAnthropicPromptCachingMode(undefined), DEFAULT_ANTHROPIC_PROMPT_CACHING);
        });
    });

    suite("resolveAnthropicCacheControl", () => {
        const input = (
            overrides: Partial<Parameters<typeof resolveAnthropicCacheControl>[0]>
        ): Parameters<typeof resolveAnthropicCacheControl>[0] => ({
            mode: "5m",
            modelId: "claude-opus",
            modelInfo: anthropicInfo(),
            ...overrides,
        });

        test("5m marks the request without a ttl (5m is the API default)", () => {
            assert.deepStrictEqual(resolveAnthropicCacheControl(input({})), { type: "ephemeral" });
        });

        test("1h marks the request with ttl 1h", () => {
            assert.deepStrictEqual(resolveAnthropicCacheControl(input({ mode: "1h" })), {
                type: "ephemeral",
                ttl: "1h",
            });
        });

        test("off marks nothing", () => {
            assert.strictEqual(resolveAnthropicCacheControl(input({ mode: "off" })), undefined);
        });

        test("per-request opt-out wins over a non-off setting", () => {
            assert.strictEqual(resolveAnthropicCacheControl(input({ requestOptOut: true })), undefined);
        });

        test("non-Anthropic models are never marked", () => {
            assert.strictEqual(
                resolveAnthropicCacheControl(input({ modelInfo: anthropicInfo({ litellm_provider: "openai" }) })),
                undefined
            );
        });

        test("a claude model id is detected without model info", () => {
            assert.deepStrictEqual(
                resolveAnthropicCacheControl(input({ modelId: "vertex_ai/claude-sonnet-4", modelInfo: undefined })),
                { type: "ephemeral" }
            );
        });

        test("model info is authoritative when it names a non-Anthropic gateway", () => {
            assert.strictEqual(
                resolveAnthropicCacheControl(input({ modelInfo: anthropicInfo({ litellm_provider: "openai" }) })),
                undefined
            );
        });

        test("model info is authoritative when it names Anthropic", () => {
            assert.deepStrictEqual(
                resolveAnthropicCacheControl(input({ modelId: "custom-shape", modelInfo: anthropicInfo() })),
                { type: "ephemeral" }
            );
        });

        test("explicitly unsupported caching is respected", () => {
            assert.strictEqual(
                resolveAnthropicCacheControl(input({ modelInfo: anthropicInfo({ supports_prompt_caching: false }) })),
                undefined
            );
        });

        test("missing supports_prompt_caching still marks (absence is not proof of exclusion)", () => {
            assert.deepStrictEqual(
                resolveAnthropicCacheControl(
                    input({ modelInfo: anthropicInfo({ supports_prompt_caching: undefined }) })
                ),
                { type: "ephemeral" }
            );
        });
    });
});
