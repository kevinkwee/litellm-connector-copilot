import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient, LiteLLMDiscoveryError } from "../../adapters/litellmClient";
import type { BackendSession } from "../backendSession";
import type { LiteLLMConfig, LiteLLMModelInfo } from "../../types";
import { sharedDiscoveryBackoff } from "../base/discoveryBackoff";
import { createMockChatResponseOptions, createMockSecrets, createMockUserMessage } from "../../test/utils/testMocks";
import { createMockSSEStream } from "../../test/utils/testStreamUtils";

const USER_AGENT = "GitHubCopilotChat/test VSCode/test";
const SHARED_HOST = "https://litellm.example";

interface ProviderAccess {
    _configManager: {
        getConfig: () => Promise<Partial<LiteLLMConfig> & { url?: string }>;
        convertProviderConfiguration: (
            configuration: Record<string, unknown>,
            clientOptions: { discoveryTimeoutMs: number; userAgent: string }
        ) => BackendSession | undefined;
    };
    _registry: {
        lookupInfo: (
            info: vscode.LanguageModelChatInformation | undefined
        ) => { baseUrl: string; apiKey: string; rawModelName: string } | undefined;
        lookup: (id: string) => { baseUrl: string; apiKey: string; rawModelName: string } | undefined;
        getModelInfo: (id: string) => LiteLLMModelInfo | undefined;
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

    test("discovery hands the configured timeout and the real user agent to the session client", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({
            discoveryTimeoutMs: 30_000,
            discoveryCacheTtlMs: 0,
        });
        const received: { discoveryTimeoutMs: number; userAgent: string }[] = [];
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .callsFake((_configuration, clientOptions) => {
                received.push(clientOptions);
                return createSession(SHARED_HOST, "key-a", "model-a");
            });

        await provider.discoverModels(
            { configuration: { baseUrl: SHARED_HOST, apiKey: "key-a" } },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(received, [{ discoveryTimeoutMs: 30_000, userAgent: USER_AGENT }]);
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
            .callsFake((configuration: Record<string, unknown>) => {
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

    test("a model reload keeps routing so an in-flight request still resolves", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 60_000 });
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .returns(createSession(SHARED_HOST, "key-a", "shared-model"));
        const models = await provider.discoverModels(
            { silent: true, configuration: { baseUrl: SHARED_HOST, apiKey: "key-a" } },
            new vscode.CancellationTokenSource().token
        );

        provider.reloadModelDiscovery();

        assert.strictEqual(internals._registry.lookupInfo(models[0])?.apiKey, "key-a");
        assert.strictEqual(internals._registry.lookup(models[0].id)?.apiKey, "key-a");
    });

    test("a reload during a discovery keeps the superseded result out of the cache", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 60_000 });

        let releaseFetch: (() => void) | undefined;
        const fetchGate = new Promise<void>((resolve) => {
            releaseFetch = resolve;
        });
        let markFetchStarted: (() => void) | undefined;
        const fetchStarted = new Promise<void>((resolve) => {
            markFetchStarted = resolve;
        });
        const getModelInfo = sandbox.stub().callsFake(async () => {
            markFetchStarted?.();
            await fetchGate;
            return { data: [{ model_name: "slow-model", model_info: { litellm_provider: "openai" } }] };
        });
        const session = {
            ...createSession(SHARED_HOST, "key-a", "slow-model"),
            client: { getModelInfo } as unknown as BackendSession["client"],
        };
        sandbox.stub(internals._configManager, "convertProviderConfiguration").returns(session);
        const configuration = { baseUrl: SHARED_HOST, apiKey: "key-a" };

        const inFlight = provider.discoverModels({ configuration }, new vscode.CancellationTokenSource().token);
        // The reload lands while the fetch is awaited, after this discovery captured
        // its epoch.
        await fetchStarted;
        provider.reloadModelDiscovery();
        releaseFetch?.();
        await inFlight;

        // The superseded result never entered the routing table, because the
        // reload's epoch guard rejected the write.
        assert.strictEqual(
            internals._registry.lookup("litellm.example/slow-model"),
            undefined,
            "a superseded discovery must not write its model into the routing table"
        );

        // The next discovery must reach the proxy, because the superseded result was
        // not cached.
        const getModelInfoCallsBefore = getModelInfo.callCount;
        await provider.discoverModels({ configuration }, new vscode.CancellationTokenSource().token);

        assert.strictEqual(getModelInfo.callCount, getModelInfoCallsBefore + 1);
    });

    test("a superseded discovery does not overwrite the capability caches the newer one wrote", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const configuration = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const slowModel = {
            model_name: "dual-mode",
            model_info: { litellm_provider: "openai", mode: "chat" as const },
        };
        const fastModel = {
            model_name: "dual-mode",
            model_info: { litellm_provider: "openai", mode: "responses" as const },
        };

        let releaseSlowFetch: (() => void) | undefined;
        const slowFetchGate = new Promise<void>((resolve) => {
            releaseSlowFetch = resolve;
        });
        let markSlowFetchStarted: (() => void) | undefined;
        const slowFetchStarted = new Promise<void>((resolve) => {
            markSlowFetchStarted = resolve;
        });
        let fetchCount = 0;
        const getModelInfo = sandbox.stub().callsFake(async () => {
            fetchCount += 1;
            if (fetchCount === 1) {
                markSlowFetchStarted?.();
                await slowFetchGate;
                return { data: [slowModel] };
            }
            return { data: [fastModel] };
        });
        sandbox.stub(internals._configManager, "convertProviderConfiguration").returns({
            ...createSession(SHARED_HOST, "key-a", "dual-mode"),
            client: { getModelInfo } as unknown as BackendSession["client"],
        });

        const superseded = provider.discoverModels({ configuration }, new vscode.CancellationTokenSource().token);
        await slowFetchStarted;
        await provider.discoverModels({ configuration }, new vscode.CancellationTokenSource().token);
        provider.reloadModelDiscovery();
        releaseSlowFetch?.();
        await superseded;

        assert.strictEqual(
            internals._registry.getModelInfo("litellm.example/dual-mode")?.mode,
            "responses",
            "the newer discovery's capability data must survive the late answer"
        );
    });

    test("two keys on one host keep separate lists, and the failing one serves its own last-known models", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const sharedConfig = { baseUrl: SHARED_HOST, apiKey: "shared-key" };
        const changedConfig = { baseUrl: SHARED_HOST, apiKey: "changed-key" };
        let failShared = false;
        sandbox
            .stub(internals._configManager, "convertProviderConfiguration")
            .callsFake((configuration: Record<string, unknown>) => {
                if (configuration === sharedConfig) {
                    const session = createSession(SHARED_HOST, "shared-key", "shared-model");
                    if (failShared) {
                        (session.client as unknown as { getModelInfo: () => Promise<never> }).getModelInfo =
                            async () => {
                                throw new LiteLLMDiscoveryError(500, "boom");
                            };
                    }
                    return session;
                }
                if (configuration === changedConfig) {
                    return createSession(SHARED_HOST, "changed-key", "changed-model");
                }
                return undefined;
            });
        const token = new vscode.CancellationTokenSource().token;

        // The backend identity includes the API-key hash, so the two keys keep
        // separate lists even though they share a host.
        await provider.discoverModels({ configuration: sharedConfig }, token);
        await provider.discoverModels({ configuration: changedConfig }, token);

        failShared = true;
        const stale = await provider.discoverModels({ configuration: sharedConfig }, token);

        assert.deepStrictEqual(
            stale.map((model) => model.id),
            ["litellm.example/shared-model"],
            "the failing key keeps serving its own last-known models"
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
            .callsFake((configuration: Record<string, unknown>) => {
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

    test("a cancelled refresh serves the last known models unmarked", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const configuration = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const session = createSession(SHARED_HOST, "key-a", "steady-model");
        sandbox.stub(internals._configManager, "convertProviderConfiguration").returns(session);

        const first = await provider.discoverModels({ configuration }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(first.length, 1, "the first discovery populates the backend");

        (session.client as unknown as { getModelInfo: () => Promise<never> }).getModelInfo = async () => {
            throw new DOMException("The operation was aborted.", "AbortError");
        };
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel();
        const second = await provider.discoverModels({ configuration }, tokenSource.token);

        assert.deepStrictEqual(
            second.map((model) => model.id),
            ["litellm.example/steady-model"],
            "a cancellation keeps the working list"
        );
        assert.strictEqual(second[0].statusIcon, undefined, "a cancellation is not a stale-list warning");
    });

    test("a cancelled discovery never records a failure", async () => {
        const provider = new LiteLLMChatProvider(createMockSecrets(), USER_AGENT);
        const internals = access(provider);
        sandbox.stub(internals._configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
        const configuration = { baseUrl: SHARED_HOST, apiKey: "key-a" };
        const session = createSession(SHARED_HOST, "key-a", "steady-model");
        sandbox.stub(internals._configManager, "convertProviderConfiguration").returns(session);
        const recordFailure = sandbox.spy(sharedDiscoveryBackoff, "recordFailure");
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel();
        (session.client as unknown as { getModelInfo: () => Promise<never> }).getModelInfo = async () => {
            throw new DOMException("The operation was aborted.", "AbortError");
        };

        await provider.discoverModels({ configuration }, tokenSource.token);

        sinon.assert.notCalled(recordFailure);
    });
});
