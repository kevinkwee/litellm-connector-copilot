import * as assert from "assert";
import { resolveToolResultImageMode } from "../modelUtils";
import type { LiteLLMModelInfo } from "../../types";

suite("resolveToolResultImageMode", () => {
    suite("native providers", () => {
        test("returns native for every provider whose transform parses tool content lists", () => {
            const providers = [
                "anthropic",
                "vertex_ai-anthropic_models",
                "gemini",
                "vertex_ai-language-models",
                "bedrock",
                "bedrock_converse",
            ];

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

        test("returns hoist for provider names that merely contain a known family", () => {
            // A bare `vertex_ai` also covers OpenAI-like partners, and a name such as
            // `bedrock_mantle` is a different transform entirely, so neither is native.
            const providers = ["vertex_ai", "vertex_ai-llama_models", "vertex_ai-openai_models", "bedrock_mantle"];

            for (const litellmProvider of providers) {
                const modelInfo = { litellm_provider: litellmProvider } as LiteLLMModelInfo;
                assert.strictEqual(resolveToolResultImageMode(modelInfo), "hoist", litellmProvider);
            }
        });

        test("returns hoist when the provider is unknown", () => {
            assert.strictEqual(resolveToolResultImageMode(undefined), "hoist");
            assert.strictEqual(resolveToolResultImageMode({} as LiteLLMModelInfo), "hoist");
            assert.strictEqual(
                resolveToolResultImageMode({ litellm_provider: "some-new-gateway" } as LiteLLMModelInfo),
                "hoist"
            );
        });

        test("returns hoist for a responses-mode model even on a native provider", () => {
            const modelInfo = { litellm_provider: "anthropic", mode: "responses" } as LiteLLMModelInfo;

            assert.strictEqual(resolveToolResultImageMode(modelInfo), "hoist");
        });
    });
});
