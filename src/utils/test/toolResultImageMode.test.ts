import * as assert from "assert";
import { resolveToolResultImageMode } from "../modelUtils";
import type { LiteLLMModelInfo } from "../../types";

suite("resolveToolResultImageMode", () => {
    suite("native providers", () => {
        test("returns native for provider families that parse tool content lists", () => {
            const providers = ["anthropic", "vertex_ai", "gemini", "bedrock"];

            for (const litellmProvider of providers) {
                const modelInfo = { litellm_provider: litellmProvider } as LiteLLMModelInfo;
                assert.strictEqual(resolveToolResultImageMode(modelInfo), "native", litellmProvider);
            }
        });

        test("matches the provider name case-insensitively", () => {
            const modelInfo = { litellm_provider: "ANTHROPIC" } as LiteLLMModelInfo;

            assert.strictEqual(resolveToolResultImageMode(modelInfo), "native");
        });
    });

    suite("hoisting providers", () => {
        test("returns hoist for OpenAI-compatible providers that stringify list content", () => {
            const providers = ["openai", "openrouter", "deepseek", "moonshot", "mistral", "sambanova"];

            for (const litellmProvider of providers) {
                const modelInfo = { litellm_provider: litellmProvider } as LiteLLMModelInfo;
                assert.strictEqual(resolveToolResultImageMode(modelInfo), "hoist", litellmProvider);
            }
        });

        test("returns hoist when the provider is unknown", () => {
            assert.strictEqual(resolveToolResultImageMode(undefined), "hoist");
            assert.strictEqual(resolveToolResultImageMode({} as LiteLLMModelInfo), "hoist");
        });

        test("returns hoist for a responses-mode model even on a native provider", () => {
            const modelInfo = { litellm_provider: "anthropic", mode: "responses" } as LiteLLMModelInfo;

            assert.strictEqual(resolveToolResultImageMode(modelInfo), "hoist");
        });
    });
});
