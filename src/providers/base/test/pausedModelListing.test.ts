import * as assert from "assert";
import { toListableDeployments, type LiteLLMModelInfoEntry } from "../pausedModelListing";
import type { LiteLLMModelInfo } from "../../../types";

/**
 * Tests for the paused-deployment listing rule on `/model/info` discovery.
 * LiteLLM lets a proxy admin pause a single deployment (`model_info.blocked`)
 * while one public `model_name` stays served by several deployments, so the rule
 * has to decide per name rather than per row.
 */
suite("toListableDeployments", () => {
    const entry = (modelName: string | undefined, modelInfo?: LiteLLMModelInfo): LiteLLMModelInfoEntry => ({
        model_name: modelName,
        model_info: modelInfo,
    });

    test("hides a public name whose every deployment is paused", () => {
        const result = toListableDeployments([
            entry("glm-5.3", { blocked: true }),
            entry("glm-5.3", { blocked: true }),
        ]);

        assert.deepStrictEqual(result, []);
    });

    test("keeps a public name with at least one live deployment", () => {
        const result = toListableDeployments([
            entry("glm-5.3", { blocked: true }),
            entry("glm-5.3", { litellm_provider: "zhipu" }),
        ]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_name, "glm-5.3");
        assert.strictEqual(result[0].model_info?.litellm_provider, "zhipu");
    });

    test("represents each multi-deployment name by its first live deployment", () => {
        const result = toListableDeployments([
            entry("glm-5.3", { litellm_provider: "zhipu", max_input_tokens: 111 }),
            entry("glm-5.3", { litellm_provider: "vertex", max_input_tokens: 222 }),
        ]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_info?.litellm_provider, "zhipu");
        assert.strictEqual(result[0].model_info?.max_input_tokens, 111);
    });

    test("keeps a live deployment even when entries for the same name start paused", () => {
        const result = toListableDeployments([
            entry("glm-5.3", { blocked: true }),
            entry("glm-5.3", { litellm_provider: "zhipu" }),
            entry("glm-5.3", { litellm_provider: "vertex" }),
        ]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_info?.litellm_provider, "zhipu");
    });

    test("treats blocked false as live", () => {
        const result = toListableDeployments([entry("glm-5.3", { blocked: false })]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_name, "glm-5.3");
    });

    test("treats blocked null as live", () => {
        const result = toListableDeployments([entry("glm-5.3", { blocked: null })]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_name, "glm-5.3");
    });

    test("lists entries without model_info because older proxies do not send the flag", () => {
        const result = toListableDeployments([entry("glm-5.3")]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_name, "glm-5.3");
    });

    test("passes entries without a model_name through for the unknown-name skip", () => {
        const malformed = entry(undefined, { litellm_provider: "openai" });
        const result = toListableDeployments([malformed]);

        assert.deepStrictEqual(result, [malformed]);
    });

    test("keeps the one unblocked entry among malformed-name entries", () => {
        const result = toListableDeployments([
            entry(undefined, { blocked: true }),
            entry(undefined, { litellm_provider: "openai" }),
        ]);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].model_info?.litellm_provider, "openai");
    });

    test("preserves the original payload order of listable entries", () => {
        const result = toListableDeployments([
            entry("alpha", { litellm_provider: "openai" }),
            entry("beta", { litellm_provider: "zhipu" }),
            entry("alpha", { litellm_provider: "vertex" }),
        ]);

        assert.deepStrictEqual(
            result.map((listed) => listed.model_name),
            ["alpha", "beta"]
        );
        assert.strictEqual(result[0].model_info?.litellm_provider, "openai");
    });
});
