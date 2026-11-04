import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import { access, apiError, seedBackendForCall } from "../../test/utils/providerBaseTestUtils";
import { EffortFallbackCache } from "../../utils/reasoningEffortFallback";
import type { BackendSession } from "../backendSession";

suite("LiteLLMProviderBase discovery", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    suite("discoverModels: change detection (no discovery loop)", () => {
        // VS Code re-queries provideLanguageModelChatInformation on every
        // onDidChangeLanguageModelChatInformation event. Firing the event
        // unconditionally from discoverModels caused an infinite loop:
        // discover → fire → VS Code re-queries → discover → fire → ...
        // The loop is broken by firing ONLY when the model id set returned
        // for a given baseUrl differs from the prior delivery.

        const makeSession = (models: { model_name: string; litellm_provider: string }[]) =>
            ({
                backendName: "test-group",
                baseUrl: "http://localhost:4000",
                apiKey: "test-key",
                client: {
                    getModelInfo: async () => ({ data: models }),
                } as unknown as { getModelInfo: sinon.SinonStub },
            }) as unknown as BackendSession;

        const makeProvider = (session: ReturnType<typeof makeSession>, sandbox: sinon.SinonSandbox) => {
            const provider = new LiteLLMChatProvider(userAgent);
            sandbox.stub(access(provider)._configManager, "convertProviderConfiguration").returns(session);
            return provider;
        };

        test("fires onDidChange on the first discovery (no prior delivery)", async () => {
            const localSandbox = sinon.createSandbox();
            try {
                const provider = makeProvider(
                    makeSession([{ model_name: "gpt-4", litellm_provider: "openai" }]),
                    localSandbox
                );
                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://localhost:4000", apiKey: "k" } },
                    new vscode.CancellationTokenSource().token
                );

                assert.strictEqual(fired.length, 1, "first delivery must fire");
            } finally {
                localSandbox.restore();
            }
        });

        test("does NOT fire onDidChange when the model set is unchanged", async () => {
            const localSandbox = sinon.createSandbox();
            try {
                const provider = makeProvider(
                    makeSession([{ model_name: "gpt-4", litellm_provider: "openai" }]),
                    localSandbox
                );
                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                const token = new vscode.CancellationTokenSource().token;
                const cfg = { baseUrl: "http://localhost:4000", apiKey: "k" };

                // First call: fires.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                // Second call: same models, must NOT fire.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                // Third call: still no change.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);

                assert.strictEqual(fired.length, 1, "only the first delivery should fire");
            } finally {
                localSandbox.restore();
            }
        });

        test("fires onDidChange again when the model set changes", async () => {
            const localSandbox = sinon.createSandbox();
            try {
                const getModelInfoStub = localSandbox.stub().resolves({
                    data: [{ model_name: "gpt-4", model_info: { litellm_provider: "openai" } }],
                });
                const session = {
                    backendName: "test-group",
                    baseUrl: "http://localhost:4000",
                    apiKey: "test-key",
                    client: { getModelInfo: getModelInfoStub },
                } as unknown as BackendSession;
                const provider = new LiteLLMChatProvider(userAgent);
                const configManager = access(provider)._configManager;
                localSandbox.stub(configManager, "convertProviderConfiguration").returns(session);
                // Disable discovery caching so subsequent calls actually call the client
                localSandbox.stub(configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                const token = new vscode.CancellationTokenSource().token;
                const cfg = { baseUrl: "http://localhost:4000", apiKey: "k" };

                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                assert.strictEqual(fired.length, 1);

                // The LiteLLM client now returns a different model set.
                getModelInfoStub.resolves({
                    data: [{ model_name: "claude-3", model_info: { litellm_provider: "anthropic" } }],
                });
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                assert.strictEqual(fired.length, 2, "second call with different ids must fire");

                // Same ids again, so no fire.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                assert.strictEqual(fired.length, 2);
            } finally {
                localSandbox.restore();
            }
        });

        test("treats different baseUrls independently", async () => {
            // Two distinct baseUrls should each have their own change-detection
            // fingerprint. A change in baseUrl A must not reset baseUrl B's
            // fingerprint, and vice versa.
            const localSandbox = sinon.createSandbox();
            try {
                const sessionA = makeSession([{ model_name: "gpt-4", litellm_provider: "openai" }]);
                const sessionB = makeSession([{ model_name: "claude-3", litellm_provider: "anthropic" }]);
                const provider = new LiteLLMChatProvider(userAgent);
                const configManager = access(provider)._configManager;
                const stub = localSandbox.stub(configManager, "convertProviderConfiguration");
                stub.callsFake((config: Record<string, unknown>) => {
                    if (config.baseUrl === "http://a") {
                        return sessionA;
                    }
                    if (config.baseUrl === "http://b") {
                        return sessionB;
                    }
                    return undefined;
                });
                // Disable discovery caching so subsequent calls actually call the client
                localSandbox.stub(configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });

                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                const token = new vscode.CancellationTokenSource().token;
                // A first → fires
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://a", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 1);
                // A again (same ids) → does not fire
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://a", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 1);
                // B first time → fires (its own fingerprint is fresh)
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://b", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 2);
                // B again → does not fire
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://b", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 2);
            } finally {
                localSandbox.restore();
            }
        });
    });

    suite("discoverModels", () => {
        const config: Record<string, unknown> = {
            providerName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
        };

        // Factory: created lazily so `sandbox` is in scope.
        const makeMockSession = (): BackendSession => ({
            backendName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: {
                getModelInfo: sandbox.stub().resolves({
                    data: [
                        {
                            model_name: "gpt-4",
                            model_info: {
                                litellm_provider: "openai",
                                supports_reasoning: true,
                                supports_reasoning_effort: true,
                                max_input_tokens: 128000,
                                max_output_tokens: 4096,
                                mode: "chat",
                            },
                        },
                    ],
                }),
            } as unknown as BackendSession["client"],
        });

        test("returns the same model id on every call", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            // The model id is stable across calls because the routing identity, derived
            // from the URL hostname, does not change.
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models1 = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            const models2 = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(models1.length, 1);
            assert.strictEqual(models2.length, 1);
            assert.strictEqual(models1[0].id, models2[0].id, "model id is stable across calls");
        });

        test("returns model objects without tags", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(models.length, 1);
            // VS Code's model metadata mapping has no `tags` field, so the
            // connector does not compute them.
            assert.strictEqual("tags" in models[0], false);
        });

        test("attaches reasoning configuration schema when supported", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.ok(models[0].configurationSchema, "schema should be attached for reasoning models");
        });

        test("surfaces temperature configuration when the model supports the parameter", async () => {
            const sessionWithTemperature: BackendSession = {
                ...makeMockSession(),
                client: {
                    getModelInfo: sandbox.stub().resolves({
                        data: [
                            {
                                model_name: "glm-5.3-flash",
                                model_info: {
                                    litellm_provider: "openai",
                                    supports_reasoning: true,
                                    supports_reasoning_effort: true,
                                    max_input_tokens: 872000,
                                    max_output_tokens: 128000,
                                    mode: "chat",
                                    supported_openai_params: ["stream", "temperature", "reasoning_effort"],
                                },
                            },
                        ],
                    }),
                } as unknown as BackendSession["client"],
            };
            const provider = new LiteLLMChatProvider(userAgent);
            const configManager = access(provider)._configManager;
            sandbox.stub(configManager, "convertProviderConfiguration").returns(sessionWithTemperature);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            const schema = models[0].configurationSchema;
            const temperatureProp = schema?.properties?.temperature;
            assert.ok(temperatureProp, "temperature property must be advertised for supporting models");
            assert.strictEqual(temperatureProp.type, "number");
        });

        test("omits temperature configuration when supported_openai_params excludes it", async () => {
            const sessionWithoutTemperature: BackendSession = {
                ...makeMockSession(),
                client: {
                    getModelInfo: sandbox.stub().resolves({
                        data: [
                            {
                                model_name: "gpt-4",
                                model_info: {
                                    litellm_provider: "openai",
                                    supports_reasoning: true,
                                    supports_reasoning_effort: true,
                                    max_input_tokens: 128000,
                                    max_output_tokens: 4096,
                                    mode: "chat",
                                    supported_openai_params: ["stream", "reasoning_effort"],
                                },
                            },
                        ],
                    }),
                } as unknown as BackendSession["client"],
            };
            const provider = new LiteLLMChatProvider(userAgent);
            const configManager = access(provider)._configManager;
            sandbox.stub(configManager, "convertProviderConfiguration").returns(sessionWithoutTemperature);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(
                models[0].configurationSchema?.properties?.temperature,
                undefined,
                "temperature must not be advertised when the model does not support the parameter"
            );
        });

        test("returns [] when no configuration is provided (vendor-level call)", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const token = new vscode.CancellationTokenSource().token;
            const models = await provider.discoverModels({ silent: true }, token);
            assert.deepStrictEqual(models, []);
        });

        test("throws a LanguageModelError when configuration is invalid", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const token = new vscode.CancellationTokenSource().token;
            const configManager = access(provider)._configManager;
            sandbox.stub(configManager, "convertProviderConfiguration").returns(undefined);
            await assert.rejects(
                () =>
                    provider.discoverModels(
                        { silent: true, configuration: { baseUrl: "http://x", apiKey: "k" } },
                        token
                    ),
                (err: unknown) => err instanceof vscode.LanguageModelError
            );
        });

        test("per-group model lists are isolated: one group refresh does not trample another", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const configManager = access(provider)._configManager;
            const wolframConfig: Record<string, unknown> = {
                baseUrl: "https://wolfram.example",
                apiKey: "k-w",
            };
            const gethConfig: Record<string, unknown> = {
                baseUrl: "https://geth.example",
                apiKey: "k-g",
            };
            const stub = sandbox.stub(configManager, "convertProviderConfiguration");
            // The URL is the routing identity, so the configuration payload alone
            // selects the session.
            stub.withArgs(wolframConfig).returns({
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k-w",
                client: {
                    getModelInfo: async () => ({
                        data: [{ model_name: "wolfram-only", model_info: { litellm_provider: "openai" } }],
                    }),
                } as unknown as BackendSession["client"],
            });
            stub.withArgs(gethConfig).returns({
                backendName: "geth",
                baseUrl: "https://geth.example",
                apiKey: "k-g",
                client: {
                    getModelInfo: async () => ({
                        data: [{ model_name: "geth-only", model_info: { litellm_provider: "openai" } }],
                    }),
                } as unknown as BackendSession["client"],
            });

            const wolframModels = await provider.discoverModels(
                { silent: true, configuration: wolframConfig },
                new vscode.CancellationTokenSource().token
            );
            const gethModels = await provider.discoverModels(
                { silent: true, configuration: gethConfig },
                new vscode.CancellationTokenSource().token
            );

            // The BackendRegistry is the source of truth. Each backend's
            // model list is keyed by its baseUrl, so a refresh of one
            // backend does not trample another.
            const registry = access(provider)._registry;
            const wolframIds = registry.lookup("wolfram.example/wolfram-only")?.rawModelName;
            const gethIds = registry.lookup("geth.example/geth-only")?.rawModelName;
            assert.strictEqual(wolframIds, "wolfram-only");
            assert.strictEqual(gethIds, "geth-only");
            // The namespaced id reflects the URL-derived routing identity.
            assert.strictEqual(wolframModels[0].id, "wolfram.example/wolfram-only");
            assert.strictEqual(gethModels[0].id, "geth.example/geth-only");
        });

        test("serves the live result instead of the prior delivery when the backend returns none", async () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const mockSession = makeMockSession();
            // An empty result is surfaced, so the picker reflects the live state of the
            // backend rather than the previous list.
            const configManager = access(provider)._configManager;
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);
            // The cache has to be off so the second call reaches the client.
            sandbox.stub(configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });

            const first = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            assert.strictEqual(first.length, 1);

            (mockSession.client.getModelInfo as sinon.SinonStub).resolves({ data: [] });

            const second = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            assert.strictEqual(second.length, 0);
        });

        test("registers the backend in the BackendRegistry with the per-group credentials", async () => {
            // The BackendRegistry is the source of truth for response-time
            // routing. After a successful discovery, the registry's
            // `lookup(modelId)` MUST resolve to the same `baseUrl` /
            // `apiKey` that was passed in on the originating call. The
            // model object on the wire does not need to carry
            // `configuration` because the registry is the source of truth.
            const provider = new LiteLLMChatProvider(userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(models.length, 1);
            const registry = access(provider)._registry;
            const looked = registry.lookup(models[0].id);
            assert.ok(looked, "registry should resolve the namespaced id back to a routing entry");
            assert.strictEqual(looked!.baseUrl, "http://localhost:4000");
            assert.strictEqual(looked!.apiKey, "test-key");
        });
    });

    suite("learned unsupported parameters", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "model-reasoning",
            name: "model-reasoning",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        test("base forwards transport strip callbacks into the registry", () => {
            const provider = new LiteLLMChatProvider(userAgent);
            const record = sandbox.stub(access(provider)._registry, "recordUnsupportedParameter");
            const transport = access(provider)._transport as unknown as {
                onUnsupportedParameter?: (model: string, param: string) => void;
            };

            transport.onUnsupportedParameter?.("claude-opus", "cache_control");

            sinon.assert.calledOnceWithExactly(record, "claude-opus", "cache_control");
        });

        test("reloadModels forgets every learned limit", async () => {
            const provider = new LiteLLMChatProvider(userAgent, new EffortFallbackCache());
            const internals = access(provider);
            internals._effortFallbackCache.recordFailure("host-a.example/model", "high");
            internals._usageOptOutModels.add("host-a.example/model");
            internals._registry.recordUnsupportedParameter("host-a.example/model", "cache_control");
            sandbox.stub(internals, "refreshModelInformation");

            provider.reloadModels();

            assert.strictEqual(
                internals._effortFallbackCache.getEffectiveEffort("host-a.example/model", "high"),
                "high"
            );
            assert.strictEqual(internals._usageOptOutModels.size, 0);
            assert.strictEqual(internals._registry.getUnsupportedParameters("host-a.example/model").size, 0);
        });

        test("a settings-triggered reload keeps every learned limit", async () => {
            const provider = new LiteLLMChatProvider(userAgent, new EffortFallbackCache());
            const internals = access(provider);
            internals._effortFallbackCache.recordFailure("host-a.example/model", "high");
            internals._usageOptOutModels.add("host-a.example/model");
            internals._registry.recordUnsupportedParameter("host-a.example/model", "cache_control");
            sandbox.stub(internals, "refreshModelInformation");

            provider.reloadModelDiscovery();

            assert.notStrictEqual(
                internals._effortFallbackCache.getEffectiveEffort("host-a.example/model", "high"),
                "high",
                "the effort ladder learns nothing from the settings"
            );
            assert.strictEqual(internals._usageOptOutModels.has("host-a.example/model"), true);
            assert.strictEqual(
                internals._registry.getUnsupportedParameters("host-a.example/model").has("cache_control"),
                true,
                "learned limits describe the proxy, not the settings"
            );
        });

        test("the effort ladder learns under the namespaced id, not the wire model name", async () => {
            const provider = new LiteLLMChatProvider(userAgent, new EffortFallbackCache());
            const internals = access(provider);
            const namespacedModel = { ...model, id: "host-a.example/model-reasoning", name: "model-reasoning" };
            const baseConfig = { baseUrl: "https://host-a.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "host-a.example",
                baseUrl: "https://host-a.example",
                apiKey: "k",
                client: {} as never,
            });
            sandbox
                .stub(internals._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            await internals.sendRequestWithRetry(
                { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                namespacedModel,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token
            );

            assert.notStrictEqual(
                internals._effortFallbackCache.getEffectiveEffort("host-a.example/model-reasoning", "high"),
                "high",
                "the namespaced id is where the ladder records the failure"
            );
            assert.strictEqual(
                internals._effortFallbackCache.getEffectiveEffort("model-reasoning", "high"),
                "high",
                "the wire name must not become a second key"
            );
        });

        test("the usage opt-out learns under the namespaced id, not the wire model name", async () => {
            const provider = new LiteLLMChatProvider(userAgent, new EffortFallbackCache());
            const internals = access(provider);
            const namespacedModel = { ...model, id: "host-a.example/model-usage", name: "model-usage" };
            const baseConfig = { baseUrl: "https://host-a.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "host-a.example",
                baseUrl: "https://host-a.example",
                apiKey: "k",
                client: {} as never,
            });
            sandbox
                .stub(internals._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: Unsupported parameter: stream_options", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            await internals.sendRequestWithRetry(
                { model: "model-usage", messages: [], stream: true, max_tokens: 100 },
                namespacedModel,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(internals._usageOptOutModels.has("host-a.example/model-usage"), true);
            assert.strictEqual(
                internals._usageOptOutModels.has("model-usage"),
                false,
                "the wire name must not become a second key"
            );
        });

        test("sendRequestWithRetry hands the transport the namespaced id as the learned-limits key", async () => {
            const provider = new LiteLLMChatProvider(userAgent, new EffortFallbackCache());
            const internals = access(provider);
            const namespacedModel = { ...model, id: "host-a.example/model-key", name: "model-key" };
            const baseConfig = { baseUrl: "https://host-a.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "host-a.example",
                baseUrl: "https://host-a.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox.stub(internals._transport, "sendRequestToLiteLLM").resolves(new ReadableStream());

            await internals.sendRequestWithRetry(
                { model: "model-key", messages: [], stream: true, max_tokens: 100 },
                namespacedModel,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(
                sendStub.firstCall.args[7],
                "host-a.example/model-key",
                "a learned rejection must be readable under the id the builder looks up"
            );
        });
    });
});
