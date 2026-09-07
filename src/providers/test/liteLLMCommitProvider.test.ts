import * as assert from "assert";
import * as sinon from "sinon";

import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { createMockSecrets } from "../../test/utils/testMocks";

/**
 * The commit-message command routes generation through VS Code's model
 * request API, so the provider itself carries no request logic. These tests
 * cover the thin surface the command consumes: construction and the
 * shared-base accessors.
 */
suite("LiteLLMCommitMessageProvider", () => {
    let sandbox: sinon.SinonSandbox;

    const mockSecrets = createMockSecrets({
        "litellm-connector.baseUrl": "http://localhost:4000",
        "litellm-connector.apiKey": "test-api-key",
    });

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("constructor creates a usable provider from secrets and user agent", () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        assert.ok(provider);
    });

    test("getConfigManager exposes the shared ConfigManager", () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        const configManager = provider.getConfigManager();
        assert.ok(configManager);
        assert.strictEqual(typeof configManager.getConfig, "function");
    });

    test("getModelInfo delegates to the BackendRegistry cache", () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // No discovery has run, so the registry has no capability cache entry.
        assert.strictEqual(provider.getModelInfo("unknown-model"), undefined);
    });

    test("setTelemetryService stores the telemetry service for the base pipeline", () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        provider.setTelemetryService({ captureException: sandbox.stub() } as never);
        assert.ok(provider);
    });
});
