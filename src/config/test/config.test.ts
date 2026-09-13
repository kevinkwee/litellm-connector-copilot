import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ConfigManager } from "../configManager";
import type { TelemetryService } from "../../telemetry/telemetryService";

suite("ConfigManager Unit Tests", () => {
    let mockSecrets: vscode.SecretStorage;
    let secretsMap: Map<string, string>;
    let configManager: ConfigManager;
    let getConfigurationStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;
    let settingsMap: Map<string, unknown>;

    setup(() => {
        settingsMap = new Map<string, unknown>();
        secretsMap = new Map<string, string>();
        mockSecrets = {
            get: async (key: string) => secretsMap.get(key),
            store: async (key: string, value: string) => {
                secretsMap.set(key, value);
            },
            delete: async (key: string) => {
                secretsMap.delete(key);
            },
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        } as unknown as vscode.SecretStorage;

        // Stub workspace configuration reads so tests are deterministic and don't depend on VS Code defaults.
        // We return explicit values for the keys ConfigManager reads.
        configGetStub = sinon.stub();
        // Note: legacy `litellm-connector.baseUrl`, `.apiKeySecretRef`, and
        // `.emitUsageData` settings are no longer read by ConfigManager
        // (VS Code 1.120+ per-group configuration). Stubs for them have been
        // removed; tests that previously relied on these returns are covered
        // by the per-test `configGetStub.callsFake(...)` overrides below.
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
            if (settingsMap.has(key)) {
                return settingsMap.get(key);
            }
            switch (key) {
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return true;
                case "litellm-connector.disableQuotaToolRedaction":
                    return false;
                case "litellm-connector.modelOverrides":
                    return [];
                case "litellm-connector.commitModelIdOverride":
                    return "";
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
        configManager = new ConfigManager(mockSecrets);
    });

    teardown(() => {
        getConfigurationStub?.restore();
    });

    test("getConfig returns empty values when nothing is stored", async () => {
        const manager = new ConfigManager(mockSecrets);
        const config = await manager.getConfig();
        // url and key are not part of LiteLLMConfig; backends are configured
        // per provider group in VS Code's Language Models settings.
        assert.strictEqual(config.commitModelIdOverride, "");
        assert.deepStrictEqual(config.modelCapabilitiesOverrides, {});
    });

    test("getConfig reads modelCapabilitiesOverrides", async () => {
        settingsMap.set("litellm-connector.modelCapabilitiesOverrides", {
            "gpt-4o": "toolCalling, imageInput",
            "some-model": "tools",
            "another-model": ["vision"],
        });

        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();

        assert.deepStrictEqual(cfg.modelCapabilitiesOverrides, {
            "gpt-4o": { toolCalling: true, imageInput: true },
            "some-model": { toolCalling: true },
            "another-model": { imageInput: true },
        });
    });

    test("getConfig returns empty object for modelCapabilitiesOverrides when not set", async () => {
        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();

        assert.deepStrictEqual(cfg.modelCapabilitiesOverrides, {});
    });

    test("getConfig reads autoTrimMessages (default false, opt-in)", async () => {
        const manager = new ConfigManager(mockSecrets);

        const defaultConfig = await manager.getConfig();
        assert.strictEqual(defaultConfig.autoTrimMessages, false);

        settingsMap.set("litellm-connector.autoTrimMessages", true);
        const enabledConfig = await manager.getConfig();
        assert.strictEqual(enabledConfig.autoTrimMessages, true);
    });

    test("convertProviderConfiguration passes the configured discoveryTimeoutMs to the session client", async () => {
        settingsMap.set("litellm-connector.discoveryTimeoutMs", 15_000);
        await configManager.getConfig();

        const session = configManager.convertProviderConfiguration("group-a", {
            baseUrl: "http://localhost:4000",
            apiKey: "secret",
        });

        assert.ok(session);
        const clientConfig = (session?.client as unknown as { config: { discoveryTimeoutMs?: number } }).config;
        assert.strictEqual(clientConfig.discoveryTimeoutMs, 15_000);
    });

    test("session client falls back to the 5000ms discovery timeout before the first getConfig", () => {
        const session = configManager.convertProviderConfiguration("group-a", {
            baseUrl: "http://localhost:4000",
            apiKey: "secret",
        });

        assert.ok(session);
        const clientConfig = (session?.client as unknown as { config: { discoveryTimeoutMs?: number } }).config;
        assert.strictEqual(clientConfig.discoveryTimeoutMs, 5_000);
    });

    test("reportFeatureToggles calls telemetry service with correct toggles", async () => {
        const manager = new ConfigManager(mockSecrets);
        const captureStub = sinon.stub();
        const telemetryMock = {
            captureFeatureToggled: captureStub,
        } as unknown as TelemetryService;
        manager.setTelemetryService(telemetryMock);

        settingsMap.set("litellm-connector.commitModelIdOverride", "gpt-4");
        settingsMap.set("litellm-connector.disableCaching", false);
        settingsMap.set("litellm-connector.disableQuotaToolRedaction", false);

        settingsMap.set("litellm-connector.forceResponsesEndpoint", true);
        settingsMap.set("litellm-connector.allowChatCompletionsFallback", true);

        await manager.reportFeatureToggles("test_source");

        assert.strictEqual(captureStub.callCount, 4);
        assert.ok(captureStub.calledWith("commit-message", true, "test_source"));
        assert.ok(captureStub.calledWith("caching", true, "test_source"));
        assert.ok(captureStub.calledWith("quota-tool-redaction", true, "test_source"));
        assert.ok(captureStub.calledWith("auto-trim-messages", false, "test_source"));
    });

    test("reportFeatureToggles is a no-op without telemetry service", async () => {
        const manager = new ConfigManager(mockSecrets);
        // This should not throw
        await manager.reportFeatureToggles("test");
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

    test("every LiteLLMConfig field is populated by getConfig() (anti-dead-config guard)", async () => {
        // This test exists because settings were previously declared, read into
        // LiteLLMConfig, and reported to telemetry WITHOUT any runtime behavior.
        // If you add a new LiteLLMConfig field, you MUST also wire it to behavior
        // or this guard will fail. Do NOT weaken this guard — codify the contract.
        //
        // The strong guard is the per-feature wiring tests (transport.fallback,
        // disableCaching.wiring). This test pins the expected live field set so
        // a dead field addition is at least surfaced here.
        const config = await configManager.getConfig();
        const liveFields: (keyof typeof config)[] = [
            "inactivityTimeout",
            "disableCaching",
            "disableQuotaToolRedaction",
            "enableModelOverrides",
            "modelCapabilitiesOverrides",
            "commitModelIdOverride",
            "forceResponsesEndpoint",
            "allowChatCompletionsFallback",
            "rateLimitMaxDelayMs",
            "autoTrimMessages",
            // NOTE: sendDefaultParameters, inlineCompletions*, v2ApiEnabled,
            // enableResponses, modelOverrides (field) are intentionally absent —
            // removed as dead config. Do NOT re-add them.
        ];
        for (const field of liveFields) {
            assert.ok(
                field in config,
                `LiteLLMConfig.${field} must be populated by getConfig() — if removed, update this guard`
            );
        }
    });
});
