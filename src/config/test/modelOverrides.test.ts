import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {
    findOverride,
    getDefaultEffort,
    getEffectiveEfforts,
    loadBundledOverrides,
    loadUserOverrides,
    type ModelOverride,
} from "../modelOverrides";
import type { LiteLLMModelInfo } from "../../types";
import { Logger } from "../../utils/logger";

const CANONICAL_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

suite("modelOverrides", () => {
    let getConfigurationStub: sinon.SinonStub;
    let loggerWarnStub: sinon.SinonStub;

    const buildWorkspaceConfiguration = (overrides: unknown, enableOverrides = true): vscode.WorkspaceConfiguration => {
        const getStub = sinon.stub();
        getStub.callsFake((key: string, defaultValue?: unknown) => {
            if (key === "litellm-connector.modelOverrides") {
                return overrides;
            }
            if (key === "litellm-connector.enableModelOverrides") {
                return enableOverrides;
            }
            return defaultValue;
        });

        return {
            get: getStub,
        } as unknown as vscode.WorkspaceConfiguration;
    };

    setup(() => {
        loggerWarnStub = sinon.stub(Logger, "warn");
        getConfigurationStub = sinon.stub(vscode.workspace, "getConfiguration");
    });

    teardown(() => {
        sinon.restore();
    });

    test("loadBundledOverrides returns empty array", () => {
        const overrides = loadBundledOverrides();

        assert.deepStrictEqual(overrides, [], "should return empty bundled overrides array");
    });

    test("loadBundledOverrides can be called but returns empty", () => {
        const overrides = loadBundledOverrides();

        assert.ok(Array.isArray(overrides), "should return an array");
        assert.strictEqual(overrides.length, 0, "should return empty array since bundled overrides were cleared");
    });

    test("user overrides merge before bundled overrides and take precedence", async () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^[Gg][Pp][Tt].*",
                supportsReasoning: true,
                reasoningEfforts: ["none", "low"],
                defaultEffort: "none",
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const override = findOverride("gpt-5-mini");

        assert.ok(override, "user override should be matched first");
        assert.strictEqual(override?.defaultEffort, "none");
        assert.deepStrictEqual(override?.reasoningEfforts, ["none", "low"]);
    });

    test("invalid user override is skipped with a warning and does not crash", async () => {
        const userOverrides: unknown[] = [
            { match: "(", supportsReasoning: true },
            {
                match: ".*",
                supportsReasoning: true,
                reasoningEfforts: ["none", "low"],
                defaultEffort: "low",
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const overrides = loadUserOverrides();

        assert.ok(loggerWarnStub.calledOnce, "invalid regex should trigger a warning");
        assert.strictEqual(overrides.length, 1);
        assert.strictEqual(overrides[0].defaultEffort, "low");
    });

    test("empty config returns default behavior", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));

        // With empty config and no model info for a generic model
        const efforts = getEffectiveEfforts("generic-model");

        assert.deepStrictEqual(efforts, []);

        // With empty config and no model info, returns empty efforts for all models
        const gpt5Efforts = getEffectiveEfforts("gpt-5-mini");

        assert.deepStrictEqual(gpt5Efforts, []);
    });

    test("getEffectiveEfforts inherits proxy support when override is neutral", async () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));
        const supportedInfo: LiteLLMModelInfo = { supports_reasoning: true };
        const unsupportedInfo: LiteLLMModelInfo = { supports_reasoning: false };

        const supported = getEffectiveEfforts("unknown-model", supportedInfo);
        const unsupported = getEffectiveEfforts("unknown-model", unsupportedInfo);

        assert.deepStrictEqual(supported, CANONICAL_REASONING_EFFORTS);
        assert.deepStrictEqual(unsupported, []);
    });

    test("getDefaultEffort leaves the model info to decide when no override matches", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));

        const gptDefault = getDefaultEffort("gpt-5-mini");
        const fallbackDefault = getDefaultEffort("unknown-model", { supports_reasoning: true });
        const unsupportedDefault = getDefaultEffort("unknown-model", { supports_reasoning: false });

        assert.strictEqual(gptDefault, undefined);
        assert.strictEqual(fallbackDefault, "max");
        assert.strictEqual(unsupportedDefault, undefined);
    });

    test("an override marked forceMandatory wins over the proxy's effort flags", () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["high"],
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_low_reasoning_effort: true,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);

        assert.deepStrictEqual(result, ["high"]);
    });

    test("a forceMandatory override supplies its list when the proxy reports reasoning without levels", () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["low", "high"],
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = getEffectiveEfforts("test-model", { supports_reasoning: true });

        assert.deepStrictEqual(result, ["low", "high"]);
    });

    test("a forceMandatory override with no effort list takes the canonical list", () => {
        const override: ModelOverride = {
            match: "^test-.*",
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_low_reasoning_effort: true,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);

        assert.deepStrictEqual(result, [...CANONICAL_REASONING_EFFORTS]);
    });

    test("an override that denies reasoning wins over forceMandatory and the proxy's effort flags", () => {
        const override: ModelOverride = {
            match: "^test-.*",
            supportsReasoning: false,
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_high_reasoning_effort: true,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);

        assert.deepStrictEqual(result, []);
    });

    test("a forceMandatory override cannot outvote a model the proxy reports as non-reasoning", () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["high"],
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: false,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);

        assert.deepStrictEqual(result, []);
    });

    test("a non-mandatory override leaves the proxy's explicit effort flags in charge", () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["high"],
            forceMandatory: false,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_low_reasoning_effort: true,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);

        assert.deepStrictEqual(result, ["low"]);
    });

    test("non-mandatory override is ignored when LiteLLM has valid data", async () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["high"],
            forceMandatory: false,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);
        // If LiteLLM has valid data, returns enumeration. When supports_reasoning is true
        // but no effort flags are set, falls back to CANONICAL_REASONING_EFFORTS.
        assert.deepStrictEqual(result, [...CANONICAL_REASONING_EFFORTS]);
    });

    test("findOverride returns undefined when enableModelOverrides is false", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^[Gg][Pp][Tt].*",
                supportsReasoning: true,
                reasoningEfforts: ["none", "low"],
                defaultEffort: "none",
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides, false));

        const override = findOverride("gpt-5-mini");

        assert.strictEqual(override, undefined, "should return undefined when overrides are disabled");
    });

    test("getEffectiveEfforts ignores overrides when enableModelOverrides is false", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supportsReasoning: true,
                reasoningEfforts: ["high"],
                defaultEffort: "high",
                forceMandatory: true,
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides, false));

        const modelInfo: LiteLLMModelInfo = { supports_reasoning: true };
        const result = getEffectiveEfforts("test-model", modelInfo);

        // When overrides are disabled the override has no effect. The model has
        // supports_reasoning but no explicit effort flags, so it falls back to canonical.
        assert.deepStrictEqual(result, [...CANONICAL_REASONING_EFFORTS]);
    });

    test("getDefaultEffort ignores overrides when enableModelOverrides is false", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supportsReasoning: true,
                defaultEffort: "high",
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides, false));

        const result = getDefaultEffort("test-model", { supports_reasoning: true });

        // Overrides are off, so the canonical list decides and its highest level is "max".
        assert.strictEqual(result, "max");
    });

    test("getEffectiveEfforts lists a hand-written effort list from weakest to strongest", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supportsReasoning: true,
                reasoningEfforts: ["high", "low"],
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        assert.deepStrictEqual(getEffectiveEfforts("test-model"), ["low", "high"]);
    });

    test("getDefaultEffort sorts a hand-written effort list and returns its highest level", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supportsReasoning: true,
                reasoningEfforts: ["high", "low"],
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const result = getDefaultEffort("test-model", { supports_reasoning: true });

        assert.strictEqual(result, "high");
    });

    test("getDefaultEffort ignores an override default outside the override's declared list", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supportsReasoning: true,
                reasoningEfforts: ["low", "high"],
                defaultEffort: "max",
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const result = getDefaultEffort("test-model", { supports_reasoning: true });

        assert.strictEqual(result, "high");
    });

    test("getDefaultEffort keeps an override default inside the override's declared list", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supportsReasoning: true,
                reasoningEfforts: ["low", "high"],
                defaultEffort: "low",
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const result = getDefaultEffort("test-model", { supports_reasoning: true });

        assert.strictEqual(result, "low");
    });
});
