import * as assert from "assert";
import { resolveToolResultTextMode } from "../modelUtils";
import type { LiteLLMModelInfo } from "../../types";

suite("resolveToolResultTextMode", () => {
    test("returns separate for providers whose transforms keep text items apart", () => {
        const providers = ["anthropic", "vertex_ai-anthropic_models", "bedrock", "bedrock_converse", "BEDROCK"];

        for (const litellmProvider of providers) {
            const modelInfo = { litellm_provider: litellmProvider } as LiteLLMModelInfo;
            assert.strictEqual(resolveToolResultTextMode(modelInfo), "separate", litellmProvider);
        }
    });

    test("returns joined for providers whose transforms concatenate text items", () => {
        const providers = ["gemini", "openai", "openrouter", "deepseek", "vertex_ai-language-models"];

        for (const litellmProvider of providers) {
            const modelInfo = { litellm_provider: litellmProvider } as LiteLLMModelInfo;
            assert.strictEqual(resolveToolResultTextMode(modelInfo), "joined", litellmProvider);
        }
    });

    test("returns joined for provider names that merely contain a known family", () => {
        // A bare `vertex_ai` also covers Gemini and OpenAI-like partners, and
        // `bedrock_mantle` is a different transform than Bedrock's, so neither keeps
        // the items apart.
        const providers = ["vertex_ai", "vertex_ai-llama_models", "vertex_ai-openai_models", "bedrock_mantle"];

        for (const litellmProvider of providers) {
            const modelInfo = { litellm_provider: litellmProvider } as LiteLLMModelInfo;
            assert.strictEqual(resolveToolResultTextMode(modelInfo), "joined", litellmProvider);
        }
    });

    test("returns joined when the provider is unknown", () => {
        assert.strictEqual(resolveToolResultTextMode(undefined), "joined");
        assert.strictEqual(resolveToolResultTextMode({} as LiteLLMModelInfo), "joined");
    });

    test("returns joined for a responses-mode model even on a separate-item provider", () => {
        const modelInfo = { litellm_provider: "anthropic", mode: "responses" } as LiteLLMModelInfo;

        assert.strictEqual(resolveToolResultTextMode(modelInfo), "joined");
    });
});
