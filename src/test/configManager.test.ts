import * as assert from "assert";
import type * as vscode from "vscode";

import { ConfigManager } from "../config/configManager";

const CLIENT_OPTIONS = { discoveryTimeoutMs: 5_000, userAgent: "test-ua" };

function createSecrets(overrides?: { get?: (key: string) => Promise<string | undefined> }): vscode.SecretStorage {
    return {
        get: overrides?.get ?? (async () => undefined),
        store: async () => {},
        delete: async () => {},
        keys: async () => [],
        onDidChange: () => ({ dispose() {} }),
    } as unknown as vscode.SecretStorage;
}

suite("ConfigManager", () => {
    test("convertProviderConfiguration returns a backend session when provider config is complete", () => {
        const manager = new ConfigManager(createSecrets());

        const session = manager.convertProviderConfiguration(
            { providerName: "group-a", baseUrl: "http://localhost:4000", apiKey: "secret" },
            CLIENT_OPTIONS
        );

        assert.ok(session);
        assert.strictEqual(session.baseUrl, "http://localhost:4000");
        assert.strictEqual(session.apiKey, "secret");
    });

    test("derives backendName from the URL hostname", () => {
        const manager = new ConfigManager(createSecrets());

        const session = manager.convertProviderConfiguration(
            { baseUrl: "https://llmapi.wolfram.com/v1", apiKey: "sk-test" },
            CLIENT_OPTIONS
        );

        assert.ok(session);
        assert.strictEqual(session.backendName, "llmapi.wolfram.com");
    });

    test("passes the supplied discovery timeout and user agent to the session client", () => {
        const manager = new ConfigManager(createSecrets());

        const session = manager.convertProviderConfiguration(
            { baseUrl: "http://localhost:4000", apiKey: "secret" },
            { discoveryTimeoutMs: 30_000, userAgent: "GitHubCopilotChat/test VSCode/test" }
        );

        assert.ok(session);
        const clientInternals = session.client as unknown as {
            config: { discoveryTimeoutMs?: number };
            userAgent?: string;
        };
        assert.strictEqual(clientInternals.config.discoveryTimeoutMs, 30_000);
        assert.strictEqual(
            clientInternals.userAgent,
            "GitHubCopilotChat/test VSCode/test",
            "the session client must send the caller's user agent, not a hardcoded one"
        );
    });

    test("getConfig returns only supported keys", async () => {
        const manager = new ConfigManager(createSecrets());

        const config = await manager.getConfig();

        // url, key, and backends are not part of LiteLLMConfig; backends are
        // configured per provider group in VS Code's Language Models settings.
        const legacyKeys = Object.keys(config).filter((key) => ["url", "key", "backends", "apiKey"].includes(key));
        assert.deepStrictEqual(legacyKeys, []);
    });

    test("ignores a stale providerName in the configuration payload", () => {
        const manager = new ConfigManager(createSecrets());

        const session = manager.convertProviderConfiguration(
            { baseUrl: "http://localhost:4000", apiKey: "secret", providerName: "stale-payload-value" },
            CLIENT_OPTIONS
        );

        assert.ok(session);
        assert.strictEqual(session.backendName, "localhost:4000");
    });

    test("returns undefined without a baseUrl", () => {
        const manager = new ConfigManager(createSecrets());

        assert.strictEqual(
            manager.convertProviderConfiguration({ providerName: "group-a", apiKey: "secret" }, CLIENT_OPTIONS),
            undefined
        );
    });

    test("returns undefined when baseUrl is not http(s)", () => {
        const manager = new ConfigManager(createSecrets());

        assert.strictEqual(
            manager.convertProviderConfiguration(
                { providerName: "group-a", baseUrl: "localhost:4000", apiKey: "secret" },
                CLIENT_OPTIONS
            ),
            undefined
        );
    });

    test("returns undefined without apiKey", () => {
        const manager = new ConfigManager(createSecrets());

        assert.strictEqual(
            manager.convertProviderConfiguration(
                { providerName: "group-a", baseUrl: "http://localhost:4000" },
                CLIENT_OPTIONS
            ),
            undefined
        );
    });

    test("getSecret exposes stored values", async () => {
        const manager = new ConfigManager(
            createSecrets({
                get: async (key: string) => (key === "litellm-connector.apiKey.default" ? "abc" : undefined),
            })
        );

        assert.strictEqual(await manager.getSecret("litellm-connector.apiKey.default"), "abc");
    });
});
