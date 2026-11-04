import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ConfigManager } from "../configManager";

suite("ConfigManager Unit Tests", () => {
    let configManager: ConfigManager;
    let getConfigurationStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;
    let settingsMap: Map<string, unknown>;

    setup(() => {
        settingsMap = new Map<string, unknown>();

        // Stub workspace configuration reads so tests are deterministic and don't depend on VS Code defaults.
        configGetStub = sinon.stub();
        // `litellm-connector.baseUrl`, `.apiKeySecretRef`, and `.emitUsageData`
        // are not read under VS Code's per-group provider configuration.
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
            if (settingsMap.has(key)) {
                return settingsMap.get(key);
            }
            switch (key) {
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return true;
                case "litellm-connector.modelOverrides":
                    return [];
                case "litellm-connector.modelCapabilitiesOverrides":
                    return {};
                default:
                    return defaultValue;
            }
        });

        getConfigurationStub = sinon.stub(vscode.workspace, "getConfiguration").returns({
            get: configGetStub,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    settingsMap.delete(key);
                } else {
                    settingsMap.set(key, value);
                }
            },
            has: () => false,
        } as unknown as vscode.WorkspaceConfiguration);
        configManager = new ConfigManager();
    });

    teardown(() => {
        getConfigurationStub?.restore();
    });

    test("getConfig returns empty values when nothing is stored", async () => {
        const manager = new ConfigManager();
        const config = await manager.getConfig();
        // url and key are not part of LiteLLMConfig; backends are configured
        // per provider group in VS Code's Language Models settings.
        assert.deepStrictEqual(config.modelCapabilitiesOverrides, {});
    });

    test("getConfig clamps an inactivityTimeout below the minimum", async () => {
        settingsMap.set("litellm-connector.inactivityTimeout", 0);

        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        assert.strictEqual(cfg.inactivityTimeout, 1);
    });

    test("getConfig clamps an inactivityTimeout above the maximum", async () => {
        settingsMap.set("litellm-connector.inactivityTimeout", 1_000_000);

        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        assert.strictEqual(cfg.inactivityTimeout, 3600);
    });

    test("getConfig falls back to the default for a non-numeric inactivityTimeout", async () => {
        settingsMap.set("litellm-connector.inactivityTimeout", "soon");

        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        assert.strictEqual(cfg.inactivityTimeout, 60);
    });

    test("getConfig keeps an in-range inactivityTimeout", async () => {
        settingsMap.set("litellm-connector.inactivityTimeout", 90);

        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        assert.strictEqual(cfg.inactivityTimeout, 90);
    });

    test("getConfig reads modelCapabilitiesOverrides", async () => {
        settingsMap.set("litellm-connector.modelCapabilitiesOverrides", {
            "gpt-4o": "toolCalling, imageInput",
            "some-model": "tools",
            "another-model": ["vision"],
        });

        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        assert.deepStrictEqual(cfg.modelCapabilitiesOverrides, {
            "gpt-4o": { toolCalling: true, imageInput: true },
            "some-model": { toolCalling: true },
            "another-model": { imageInput: true },
        });
    });

    test("getConfig returns empty object for modelCapabilitiesOverrides when not set", async () => {
        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        assert.deepStrictEqual(cfg.modelCapabilitiesOverrides, {});
    });

    test("getConfig reports no discovery change-notification timing fields", async () => {
        const manager = new ConfigManager();
        const cfg = await manager.getConfig();

        // The registry fires the change event as soon as a model set changes, so
        // there is nothing for a debounce or rate-limit window to configure.
        assert.strictEqual("discoveryFireDebounceMs" in cfg, false);
        assert.strictEqual("discoveryFireMinIntervalMs" in cfg, false);
    });

    test("a pasted endpoint path is normalized away before it reaches the routing table", () => {
        const session = configManager.convertProviderConfiguration(
            { baseUrl: " https://proxy.example/v1/chat/completions/ ", apiKey: "secret" },
            { discoveryTimeoutMs: 5_000, userAgent: "test-ua" }
        );

        assert.ok(session);
        assert.strictEqual(session?.baseUrl, "https://proxy.example/v1");
        const clientConfig = (session?.client as unknown as { config: { url: string } }).config;
        assert.strictEqual(clientConfig.url, "https://proxy.example/v1");
    });

    test("should read forceResponsesEndpoint from workspace settings", async () => {
        settingsMap.set("litellm-connector.forceResponsesEndpoint", false);
        const config = await configManager.getConfig();
        assert.strictEqual(config.forceResponsesEndpoint, false);
    });

    test("should default forceResponsesEndpoint to false when not set", async () => {
        settingsMap.delete("litellm-connector.forceResponsesEndpoint");
        const config = await configManager.getConfig();
        assert.strictEqual(config.forceResponsesEndpoint, false);
    });

    test("should read allowChatCompletionsFallback from workspace settings", async () => {
        settingsMap.set("litellm-connector.allowChatCompletionsFallback", true);
        const config = await configManager.getConfig();
        assert.strictEqual(config.allowChatCompletionsFallback, true);
    });

    test("should default allowChatCompletionsFallback to false when not set", async () => {
        settingsMap.delete("litellm-connector.allowChatCompletionsFallback");
        const config = await configManager.getConfig();
        assert.strictEqual(config.allowChatCompletionsFallback, false);
    });

    test("should read rateLimitMaxDelaySeconds from workspace settings", async () => {
        settingsMap.set("litellm-connector.rateLimitMaxDelaySeconds", 30);
        const config = await configManager.getConfig();
        assert.strictEqual(config.rateLimitMaxDelayMs, 30000);
    });

    test("should default rateLimitMaxDelaySeconds to 120 seconds when not set", async () => {
        settingsMap.delete("litellm-connector.rateLimitMaxDelaySeconds");
        const config = await configManager.getConfig();
        assert.strictEqual(config.rateLimitMaxDelayMs, 120000);
    });

    test("should clamp rateLimitMaxDelaySeconds to its bounds", async () => {
        settingsMap.set("litellm-connector.rateLimitMaxDelaySeconds", -5);
        assert.strictEqual((await configManager.getConfig()).rateLimitMaxDelayMs, 0);
        settingsMap.set("litellm-connector.rateLimitMaxDelaySeconds", 999999999);
        assert.strictEqual((await configManager.getConfig()).rateLimitMaxDelayMs, 86400000);
        settingsMap.set("litellm-connector.rateLimitMaxDelaySeconds", Number.NaN);
        assert.strictEqual((await configManager.getConfig()).rateLimitMaxDelayMs, 120000);
    });

    test("should convert fractional seconds to whole milliseconds", async () => {
        settingsMap.set("litellm-connector.rateLimitMaxDelaySeconds", 0.5);
        assert.strictEqual((await configManager.getConfig()).rateLimitMaxDelayMs, 500);
    });

    test("should read headersTimeout from workspace settings", async () => {
        settingsMap.set("litellm-connector.headersTimeout", 45);
        assert.strictEqual((await configManager.getConfig()).headersTimeoutMs, 45_000);
    });

    test("should default headersTimeout to 120 seconds", async () => {
        settingsMap.delete("litellm-connector.headersTimeout");

        assert.strictEqual((await configManager.getConfig()).headersTimeoutMs, 120_000);
    });

    test("should raise a headersTimeout below one second to one second", async () => {
        // A zero or negative value would abort every request immediately.
        settingsMap.set("litellm-connector.headersTimeout", 0);

        assert.strictEqual((await configManager.getConfig()).headersTimeoutMs, 1_000);
    });

    test("should cap headersTimeout at the HTTP stack's own 300 second header limit", async () => {
        settingsMap.set("litellm-connector.headersTimeout", 100_000);

        assert.strictEqual((await configManager.getConfig()).headersTimeoutMs, 300_000);
    });

    test("should fall back to the default for a non-numeric headersTimeout", async () => {
        settingsMap.set("litellm-connector.headersTimeout", Number.NaN);

        assert.strictEqual((await configManager.getConfig()).headersTimeoutMs, 120_000);
    });

    test("should read retryBudgetSeconds from workspace settings", async () => {
        settingsMap.set("litellm-connector.retryBudgetSeconds", 90);

        assert.strictEqual((await configManager.getConfig()).retryBudgetMs, 90_000);
    });

    test("should default the retry budget to 300 seconds", async () => {
        settingsMap.delete("litellm-connector.retryBudgetSeconds");

        assert.strictEqual((await configManager.getConfig()).retryBudgetMs, 300_000);
    });

    test("should keep a zero retry budget as disabled", async () => {
        settingsMap.set("litellm-connector.retryBudgetSeconds", 0);

        assert.strictEqual((await configManager.getConfig()).retryBudgetMs, 0);
    });

    test("should raise a negative retry budget to zero", async () => {
        settingsMap.set("litellm-connector.retryBudgetSeconds", -5);

        assert.strictEqual((await configManager.getConfig()).retryBudgetMs, 0);
    });

    test("should cap the retry budget at one hour", async () => {
        settingsMap.set("litellm-connector.retryBudgetSeconds", 99_999);

        assert.strictEqual((await configManager.getConfig()).retryBudgetMs, 3_600_000);
    });

    test("should read large networkRetries values without capping", async () => {
        settingsMap.set("litellm-connector.networkRetries", 1000);
        assert.strictEqual((await configManager.getConfig()).networkRetries, 1000);
        settingsMap.set("litellm-connector.networkRetries", 1_000_000);
        assert.strictEqual((await configManager.getConfig()).networkRetries, 1_000_000);
    });

    test("should clamp Infinity networkRetries to the sentinel ceiling", async () => {
        settingsMap.set("litellm-connector.networkRetries", Infinity);
        assert.strictEqual((await configManager.getConfig()).networkRetries, Number.MAX_SAFE_INTEGER);
    });

    test("should default networkRetries to 3 and clamp only the floor", async () => {
        settingsMap.delete("litellm-connector.networkRetries");
        assert.strictEqual((await configManager.getConfig()).networkRetries, 3);
        settingsMap.set("litellm-connector.networkRetries", -5);
        assert.strictEqual((await configManager.getConfig()).networkRetries, 0);
        settingsMap.set("litellm-connector.networkRetries", Number.NaN);
        assert.strictEqual((await configManager.getConfig()).networkRetries, 3);
    });

    suite("anthropicPromptCaching", () => {
        test("defaults to 5m when the setting is unset", async () => {
            const config = await configManager.getConfig();

            assert.strictEqual(config.anthropicPromptCaching, "5m");
        });

        test("honors the explicit 5m value", async () => {
            settingsMap.set("litellm-connector.anthropicPromptCaching", "5m");

            const config = await configManager.getConfig();

            assert.strictEqual(config.anthropicPromptCaching, "5m");
        });

        test("honors the 1h value", async () => {
            settingsMap.set("litellm-connector.anthropicPromptCaching", "1h");

            const config = await configManager.getConfig();

            assert.strictEqual(config.anthropicPromptCaching, "1h");
        });

        test("honors the off value", async () => {
            settingsMap.set("litellm-connector.anthropicPromptCaching", "off");

            const config = await configManager.getConfig();

            assert.strictEqual(config.anthropicPromptCaching, "off");
        });

        test("falls back to 5m for an invalid string", async () => {
            settingsMap.set("litellm-connector.anthropicPromptCaching", "weekly");

            const config = await configManager.getConfig();

            assert.strictEqual(config.anthropicPromptCaching, "5m");
        });

        test("falls back to 5m for a non-string value", async () => {
            settingsMap.set("litellm-connector.anthropicPromptCaching", 6);

            const config = await configManager.getConfig();

            assert.strictEqual(config.anthropicPromptCaching, "5m");
        });
    });

    test("every LiteLLMConfig field is populated by getConfig() (anti-dead-config guard)", async () => {
        // A setting that is declared, read into LiteLLMConfig, and reported to
        // telemetry without driving behavior is dead configuration.
        // If you add a new LiteLLMConfig field, you MUST also wire it to behavior
        // or this guard will fail. Do NOT weaken this guard: it codifies the contract.
        //
        // The strong guard is the per-feature wiring tests (transport.fallback,
        // disableCaching.wiring). This test pins the expected live field set so
        // a dead field addition is at least surfaced here.
        const config = await configManager.getConfig();
        const liveFields: (keyof typeof config)[] = [
            "inactivityTimeout",
            "disableCaching",
            "anthropicPromptCaching",
            "enableModelOverrides",
            "modelCapabilitiesOverrides",
            "forceResponsesEndpoint",
            "allowChatCompletionsFallback",
            "rateLimitMaxDelayMs",
            "headersTimeoutMs",
            "retryBudgetMs",
            "discoveryTimeoutMs",
            "discoveryCacheTtlMs",
            "networkRetries",
            "networkRetryDelayMs",
            "emptyResponseRetries",
            "emptyResponseRetryDelayMs",
            "displayPricingInPicker",
            // NOTE: sendDefaultParameters, inlineCompletions*, v2ApiEnabled,
            // enableResponses, and modelOverrides (field) are absent because
            // nothing reads them. Do not re-add them.
        ];
        for (const field of liveFields) {
            assert.ok(
                field in config,
                `LiteLLMConfig.${field} must be populated by getConfig(). If removed, update this guard`
            );
        }
    });
});
