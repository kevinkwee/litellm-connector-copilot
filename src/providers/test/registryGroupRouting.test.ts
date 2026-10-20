import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient, LiteLLMDiscoveryError } from "../../adapters/litellmClient";
import type { BackendSession } from "../backendSession";
import type { LiteLLMConfig } from "../../types";
import { sharedDiscoveryBackoff } from "../base/discoveryBackoff";
import { createMockChatResponseOptions, createMockSecrets, createMockUserMessage } from "../../test/utils/testMocks";
import { createMockSSEStream } from "../../test/utils/testStreamUtils";

const USER_AGENT = "GitHubCopilotChat/test VSCode/test";
const SHARED_HOST = "https://litellm.example";

interface ProviderAccess {
    _configManager: {
        getConfig: () => Promise<Partial<LiteLLMConfig> & { url?: string }>;
        convertProviderConfiguration: (
            groupName: string,
            configuration: Record<string, unknown>
        ) => BackendSession | undefined;
    };
    _registry: {
        lookupInfo: (
            info: vscode.LanguageModelChatInformation | undefined
        ) => { baseUrl: string; apiKey: string; rawModelName: string } | undefined;
        lookup: (id: string) => { baseUrl: string; apiKey: string; rawModelName: string } | undefined;
        clear: () => void;
    };
}

function access(provider: LiteLLMChatProvider): ProviderAccess {
    return provider as unknown as ProviderAccess;
}

/** A session whose /model/info lists one model, with no HTTP involved. */
function createSession(baseUrl: string, apiKey: string, modelName: string): BackendSession {
    return {
        backendName: baseUrl,
        baseUrl,
        apiKey,
        client: {
            getModelInfo: async () => ({
                data: [{ model_name: modelName, model_info: { litellm_provider: "openai" } }],
            }),
        } as unknown as BackendSession["client"],
    };
}

function optionsFor(configuration?: Record<string, unknown>): vscode.ProvideLanguageModelChatResponseOptions {
    return {
        ...createMockChatResponseOptions(),
        configuration,
    } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
}

suite("Per-group routing", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sharedDiscoveryBackoff.reset();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("two groups on one host route to their own credentials", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({
            inactivityTimeout: 60,
            networkRetryDelayMs: 1,
        });
        const configA = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const configB = { baseUrl: SHARED_HOST, apiKey: "key-b" };
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .callsFake((_groupName: string, configuration: Record<string, unknown>) => {
                if (configuration === configA) {
                    return createSession(SHARED_HOST, "key-a", "shared-model");
                }
                if (configuration === configB) {
                    return createSession(SHARED_HOST, "key-b", "shared-model");
                }
                return undefined;
            });
        const token = new vscode.CancellationTokenSource().token;

        const modelsA = await provider.discoverModels({ silent: true, configuration: configA }, token);
        const modelsB = await provider.discoverModels({ silent: true, configuration: configB }, token);

        // Same host means the same namespaced id, which is exactly why the id
        // alone cannot select a group's credentials.
        assert.strictEqual(modelsA[0].id, modelsB[0].id);

        const usedKeys: string[] = [];
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async function (this: LiteLLMClient) {
            usedKeys.push((this as unknown as { config: { key: string } }).config.key);
            return createMockSSEStream(["ok"]);
        });

        // VS Code passes back the exact object it stored for the group, and no
        // per-group configuration, which is the common response-time shape.
        await provider.provideLanguageModelChatResponse(
            modelsA[0],
            [createMockUserMessage("hello")],
            optionsFor(),
            { report: () => undefined },
            token
        );

        assert.deepStrictEqual(usedKeys, ["key-a"]);
    });

    test("lookupInfo resolves a discovered model object to its own entry", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const config = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .returns(createSession(SHARED_HOST, "key-a", "shared-model"));

        const models = await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(internals._registry.lookupInfo(models[0])?.apiKey, "key-a");
        assert.strictEqual(internals._registry.lookupInfo(models[0])?.baseUrl, SHARED_HOST);
        assert.strictEqual(internals._registry.lookupInfo({ ...models[0] }), undefined);
    });

    test("clear() stops routing by a model object delivered before the reload", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .returns(createSession(SHARED_HOST, "key-a", "shared-model"));
        const models = await provider.discoverModels(
            { silent: true, configuration: { baseUrl: SHARED_HOST, apiKey: "key-a" } },
            new vscode.CancellationTokenSource().token
        );

        provider.clearModelCache();

        assert.strictEqual(
            internals._registry.lookupInfo(models[0]),
            undefined,
            "a user-initiated reload must drop the identity routing table too"
        );
    });
});

suite("Stale discovery results", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sharedDiscoveryBackoff.reset();
    });

    teardown(() => {
        sandbox.restore();
        sharedDiscoveryBackoff.reset();
    });

    test("refreshing one of two same-host groups does not fire the picker refresh", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const configA = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const configB = { baseUrl: SHARED_HOST, apiKey: "key-b" };
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .callsFake((_groupName: string, configuration: Record<string, unknown>) => {
                if (configuration === configA) {
                    return createSession(SHARED_HOST, "key-a", "model-a");
                }
                if (configuration === configB) {
                    return createSession(SHARED_HOST, "key-b", "model-b");
                }
                return undefined;
            });
        const token = new vscode.CancellationTokenSource().token;
        let changes = 0;
        const subscription = provider.onDidChangeLanguageModelChatInformation(() => {
            changes += 1;
        });

        try {
            await provider.discoverModels({ silent: true, configuration: configA }, token);
            await provider.discoverModels({ silent: true, configuration: configB }, token);
            assert.strictEqual(changes, 2, "each group's first discovery changes its own model set");

            // A's list is unchanged since its own last delivery. Keying the prior
            // set by URL instead of backend identity would compare A against B's
            // list and fire a third, pointless refresh.
            await provider.discoverModels({ silent: true, configuration: configA }, token);
        } finally {
            subscription.dispose();
        }

        assert.strictEqual(changes, 2, "a group's refresh must not react to another group's list");
    });

    function configureSession(
        sandboxInstance: sinon.SinonSandbox,
        provider: LiteLLMChatProvider
    ): { getModelInfo: sinon.SinonStub } {
        const internals = access(provider);
        sandboxInstance.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const getModelInfo = sandboxInstance.stub().resolves({
            data: [{ model_name: "shared-model", model_info: { litellm_provider: "openai" } }],
        });
        sandboxInstance.stub(internals._configManager, "convertProviderConfiguration").returns({
            backendName: SHARED_HOST,
            baseUrl: SHARED_HOST,
            apiKey: "key-a",
            client: { getModelInfo } as unknown as BackendSession["client"],
        });
        return { getModelInfo };
    }

    test("serves the last known models with a visible warning when a refresh fails", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const { getModelInfo } = configureSession(sandbox, provider);
        const configuration = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const token = new vscode.CancellationTokenSource().token;

        const first = await provider.discoverModels({ silent: true, configuration }, token);
        getModelInfo.rejects(new LiteLLMDiscoveryError(503, "Service Unavailable"));
        const second = await provider.discoverModels({ silent: true, configuration }, token);

        assert.strictEqual(second.length, 1, "a failed refresh must not empty the group");
        assert.strictEqual(second[0].id, first[0].id);
        assert.ok(second[0].statusIcon, "the stale list must be marked in the picker");
        assert.match(String(second[0].warningText?.model_refresh), /Last model refresh failed/);
        // The registry's stored object must not be mutated: VS Code keeps the
        // objects it was handed and identity is what routing resolves by.
        assert.strictEqual(first[0].warningText, undefined);
        assert.notStrictEqual(second[0], first[0]);
        assert.ok(
            access(provider)._registry.lookupInfo(second[0]),
            "a copied stale model must still resolve to its group's credentials"
        );
    });

    test("returns an empty list when the group is misconfigured, so the error stays visible", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const { getModelInfo } = configureSession(sandbox, provider);
        const configuration = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const token = new vscode.CancellationTokenSource().token;

        await provider.discoverModels({ silent: true, configuration }, token);
        getModelInfo.rejects(new LiteLLMDiscoveryError(401, "Unauthorized"));
        const second = await provider.discoverModels({ silent: true, configuration }, token);

        assert.deepStrictEqual(second, [], "an auth failure must not be hidden behind a stale list");
    });

    test("returns an empty list when the first refresh for a group fails", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const { getModelInfo } = configureSession(sandbox, provider);
        getModelInfo.rejects(new TypeError("fetch failed"));

        const models = await provider.discoverModels(
            { silent: true, configuration: { baseUrl: SHARED_HOST, apiKey: "key-a" } },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(models, []);
    });
});
