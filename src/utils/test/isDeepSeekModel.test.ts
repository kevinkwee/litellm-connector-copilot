import * as assert from "assert";
import { isDeepSeekModel } from "../modelUtils";
import type { LiteLLMModelInfo } from "../../types";

suite("isDeepSeekModel", () => {
    test("matches the provider name case-insensitively", () => {
        const modelInfo = { litellm_provider: "DeepSeek" } as LiteLLMModelInfo;

        assert.strictEqual(isDeepSeekModel("some-alias", modelInfo), true);
    });

    test("matches a DeepSeek model id when provider info is absent", () => {
        assert.strictEqual(isDeepSeekModel("litellm.kevinkwee.dev/DeepSeek-V4.1-Flash"), true);
    });

    test("rejects other providers and model ids", () => {
        const modelInfo = { litellm_provider: "openai" } as LiteLLMModelInfo;

        assert.strictEqual(isDeepSeekModel("litellm.kevinkwee.dev/gpt-5.4-mini", modelInfo), false);
    });

    test("rejects a Claude model when the provider is Anthropic", () => {
        const modelInfo = { litellm_provider: "anthropic" } as LiteLLMModelInfo;

        assert.strictEqual(isDeepSeekModel("claude-sonnet-5", modelInfo), false);
    });
});
