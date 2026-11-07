import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
import { RequestBuilder } from "../base/requestBuilder";
import { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";

/** Builds one request body, discarding the tool-name mapping the test does not read. */
async function buildRequest(
    builder: RequestBuilder,
    ...args: Parameters<RequestBuilder["buildOpenAIChatRequest"]>
): Promise<OpenAIChatCompletionRequest> {
    return (await builder.buildOpenAIChatRequest(...args)).request;
}

suite("RequestBuilder", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;
    let builder: RequestBuilder;

    setup(() => {
        sandbox = sinon.createSandbox();
        configManager = sandbox.createStubInstance(ConfigManager);
        builder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => true,
            getUnsupportedParameters: () => new Set<string>(),
            // Mirrors `LiteLLMProviderBase.getTelemetryOptions`: VS Code's
            // per-model picker selections arrive via `options.modelConfiguration`.
            getTelemetryOptions: (options: vscode.ProvideLanguageModelChatResponseOptions) => ({
                caller: "test",
                modelConfiguration: ((options as unknown as { modelConfiguration?: Record<string, unknown> })
                    .modelConfiguration ?? {}) as Record<string, unknown>,
            }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => {
                // Test mirror of `LiteLLMProviderRegistry.extractRawName`:
                // strip everything up to and including the first `/`.
                const slash = id.indexOf("/");
                return slash < 0 ? id : id.slice(slash + 1);
            },
        });
    });

    teardown(() => sandbox.restore());

    test("buildOpenAIChatRequest caps max_tokens to model maxOutputTokens", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "group-a/gpt-x",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const req = await buildRequest(
            builder,
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "caller"
        );
        sinon.assert.match(req.max_tokens, 50);
        sinon.assert.match(req.stream, true);
    });

    suite("reasoning effort gate", () => {
        const model = {
            id: "group-a/gpt-x",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];
        const options = (effort: string) =>
            ({
                modelOptions: {},
                modelConfiguration: { reasoningEffort: effort },
            }) as unknown as vscode.ProvideLanguageModelChatResponseOptions;

        /** Builder whose effort source is the picker selection, as the provider wires it. */
        const buildWithEffort = async (modelInfo: LiteLLMModelInfo, effort: string) =>
            buildRequest(
                new RequestBuilder({
                    configManager,
                    getReasoningEffort: (callOptions) =>
                        (callOptions as unknown as { modelConfiguration?: { reasoningEffort?: string } })
                            .modelConfiguration?.reasoningEffort,
                    stripUnsupportedParametersFromRequest: () => {},
                    isParameterSupported: () => true,
                    getUnsupportedParameters: () => new Set<string>(),
                    getTelemetryOptions: () => ({ caller: "test", modelConfiguration: {} }),
                    usageOptOutModels: new Set(),
                    extractRawModelName: (id: string) => id.slice(id.indexOf("/") + 1),
                }),
                messages,
                model,
                options(effort),
                modelInfo,
                "caller"
            );

        /** Points `modelOverrides` at one entry, so the id the gate uses decides the list. */
        const buildWithOverride = async (pattern: string) => {
            sandbox.stub(vscode.workspace, "getConfiguration").returns({
                get: (key: string, defaultValue?: unknown) => {
                    if (key === "litellm-connector.modelOverrides") {
                        return [
                            {
                                match: pattern,
                                supportsReasoning: true,
                                reasoningEfforts: ["low", "high"],
                                forceMandatory: true,
                            },
                        ];
                    }
                    if (key === "litellm-connector.enableModelOverrides") {
                        return true;
                    }
                    return defaultValue;
                },
            } as unknown as vscode.WorkspaceConfiguration);
            return buildWithEffort({} as LiteLLMModelInfo, "high");
        };

        test("keeps the effort when an override matches the namespaced id, as the picker does", async () => {
            // The picker resolves the list under the namespaced id, so an override
            // anchored to that id must also reach the request path.
            configManager.getConfig.resolves({});

            const request = await buildWithOverride("^group-a/gpt-x$");

            assert.strictEqual(request.reasoning_effort, "high");
        });

        test("drops the effort when an override matches only the raw name", async () => {
            // The picker never sees this override, so it offers no level and the request
            // must not carry one.
            configManager.getConfig.resolves({});

            const request = await buildWithOverride("^gpt-x$");

            assert.strictEqual(request.reasoning_effort, undefined);
        });

        test("sends the picker effort when the model offers that level", async () => {
            configManager.getConfig.resolves({});
            const modelInfo = { supports_reasoning: true, supports_high_reasoning_effort: true } as LiteLLMModelInfo;

            const request = await buildWithEffort(modelInfo, "high");

            assert.strictEqual(request.reasoning_effort, "high");
        });

        test("sends the effort when the model declares the level, though its parameter list omits it", async () => {
            // The picker offers the level from the declaration alone, so the request
            // must carry it even when `supported_openai_params` does not list it. A
            // deployment whose proxy still refuses it answers with guidance, which is
            // the documented outcome of a wrong declaration.
            configManager.getConfig.resolves({});
            const modelInfo = {
                supports_reasoning: true,
                supports_high_reasoning_effort: true,
                supported_openai_params: ["stream", "tools"],
            } as unknown as LiteLLMModelInfo;

            const request = await buildWithEffort(modelInfo, "high");

            assert.strictEqual(request.reasoning_effort, "high");
        });

        test("drops a saved effort the model no longer offers", async () => {
            // VS Code merges a previously picked level into every request without
            // re-checking the schema, and hides the control once the model offers
            // nothing, so the connector must not send it.
            configManager.getConfig.resolves({});
            const modelInfo = { supports_reasoning: false } as LiteLLMModelInfo;

            const request = await buildWithEffort(modelInfo, "high");

            assert.strictEqual(request.reasoning_effort, undefined);
        });

        test("drops a saved effort the model no longer offers, though it offers others", async () => {
            // The control stays visible while the list is non-empty, so the user can recover;
            // the stale level does not reach a model whose declaration dropped it.
            configManager.getConfig.resolves({});
            const modelInfo = { supports_reasoning: true, supports_low_reasoning_effort: true } as LiteLLMModelInfo;

            const request = await buildWithEffort(modelInfo, "high");

            assert.strictEqual(request.reasoning_effort, undefined);
        });
    });

    suite("temperature from modelConfiguration", () => {
        const model = {
            id: "group-a/gpt-x",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        setup(() => {
            configManager.getConfig.resolves({});
        });

        test("applies per-model temperature set in the VS Code model configuration", async () => {
            const req = await buildRequest(
                builder,
                messages,
                model,
                {
                    modelOptions: {},
                    modelConfiguration: { temperature: 0.2 },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                undefined,
                "caller"
            );

            assert.strictEqual(req.temperature, 0.2);
        });

        test("caller-supplied modelOptions.temperature wins over per-model configuration", async () => {
            const req = await buildRequest(
                builder,
                messages,
                model,
                {
                    modelOptions: { temperature: 0.9 },
                    modelConfiguration: { temperature: 0.2 },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                undefined,
                "caller"
            );

            assert.strictEqual(req.temperature, 0.9);
        });

        test("omits temperature when no explicit value is configured", async () => {
            const req = await buildRequest(
                builder,
                messages,
                model,
                { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
                undefined,
                "caller"
            );

            assert.strictEqual(req.temperature, undefined);
        });

        test("omits per-model temperature when the model does not support the parameter", async () => {
            // The suite's default builder stubs isParameterSupported to always
            // allow; this test needs a gate that rejects temperature, so it
            // builds its own.
            const gatedBuilder = new RequestBuilder({
                configManager,
                getReasoningEffort: () => undefined,
                stripUnsupportedParametersFromRequest: () => {},
                isParameterSupported: (param: string) => param !== "temperature",
                getUnsupportedParameters: () => new Set<string>(),
                getTelemetryOptions: (options: vscode.ProvideLanguageModelChatResponseOptions) => ({
                    caller: "test",
                    modelConfiguration: ((options as unknown as { modelConfiguration?: Record<string, unknown> })
                        .modelConfiguration ?? {}) as Record<string, unknown>,
                }),
                usageOptOutModels: new Set(),
                extractRawModelName: (id: string) => {
                    const slash = id.indexOf("/");
                    return slash < 0 ? id : id.slice(slash + 1);
                },
            });
            const modelInfo = { supported_openai_params: ["stream", "tools"] } as LiteLLMModelInfo;

            const req = await buildRequest(
                gatedBuilder,
                messages,
                model,
                {
                    modelOptions: {},
                    modelConfiguration: { temperature: 0.2 },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo,
                "caller"
            );

            assert.strictEqual(req.temperature, undefined);
        });
    });

    test("buildOpenAIChatRequest preserves tool_choice when ToolMode is Required", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "group-a/gpt-x",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];
        const modelInfo = { mode: "chat" } as LiteLLMModelInfo;

        const req = await buildRequest(
            builder,
            messages,
            model,
            {
                modelOptions: {},
                toolMode: vscode.LanguageModelChatToolMode.Required,
                tools: [{ name: "test_tool", description: "desc", inputSchema: {} }],
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "caller"
        );

        sinon.assert.match(req.tool_choice, {
            type: "function",
            function: { name: "test_tool" },
        });
    });

    test("buildOpenAIChatRequest omits tool_choice when not supported by model", async () => {
        // Create a builder where isParameterSupported returns false for tool_choice
        const builderWithGating = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param !== "tool_choice", // tool_choice not supported
            getUnsupportedParameters: () => new Set<string>(),
            getTelemetryOptions: () => ({ caller: "test", modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => {
                const slash = id.indexOf("/");
                return slash < 0 ? id : id.slice(slash + 1);
            },
        });

        configManager.getConfig.resolves({});
        const model = {
            id: "azure/gpt-5.6",
            maxInputTokens: 100000,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("test")],
                name: undefined,
            },
        ];
        const modelInfo = { model: "gpt-5.6", supported_openai_params: ["tools"] } as LiteLLMModelInfo;

        const req = await buildRequest(
            builderWithGating,
            messages,
            model,
            {
                tools: [{ name: "tool1", description: "test", inputSchema: {} }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {},
                requestInitiator: "test",
            } as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "test"
        );

        // tool_choice should be undefined when not supported by model
        assert.strictEqual(req.tool_choice, undefined);
    });

    test("buildOpenAIChatRequest adds tool_choice: auto when supported and tools present", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "openai/gpt-4",
            maxInputTokens: 100000,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("test")],
                name: undefined,
            },
        ];
        const modelInfo = { model: "gpt-4", supported_openai_params: ["tools", "tool_choice"] } as LiteLLMModelInfo;

        const req = await buildRequest(
            builder,
            messages,
            model,
            {
                tools: [{ name: "tool1", description: "test", inputSchema: {} }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {},
                requestInitiator: "test",
            } as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "test"
        );

        // tool_choice should be "auto" when model supports it and tools are present
        assert.strictEqual(req.tool_choice, "auto");
    });

    suite("Anthropic prompt caching", () => {
        const claudeModel = {
            id: "bg/claude-opus",
            maxInputTokens: 100_000,
            maxOutputTokens: 8_192,
        } as vscode.LanguageModelChatInformation;
        const anthropicInfo = {
            litellm_provider: "anthropic",
            supports_prompt_caching: true,
        } as LiteLLMModelInfo;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        function options(modelOptions: Record<string, unknown>): vscode.ProvideLanguageModelChatResponseOptions {
            return { modelOptions } as vscode.ProvideLanguageModelChatResponseOptions;
        }

        setup(() => {
            configManager.getConfig.resolves({});
        });

        test("marks Anthropic requests with the default 5m ephemeral CachePoint", async () => {
            const req = await buildRequest(builder, messages, claudeModel, options({}), anthropicInfo, "call");

            assert.deepStrictEqual(req.cache_control, { type: "ephemeral" });
        });

        test("adds ttl 1h when the setting requests the 1-hour tier", async () => {
            configManager.getConfig.resolves({ anthropicPromptCaching: "1h" });

            const req = await buildRequest(builder, messages, claudeModel, options({}), anthropicInfo, "call");

            assert.deepStrictEqual(req.cache_control, { type: "ephemeral", ttl: "1h" });
        });

        test("omits the marker when the setting is off", async () => {
            configManager.getConfig.resolves({ anthropicPromptCaching: "off" });

            const req = await buildRequest(builder, messages, claudeModel, options({}), anthropicInfo, "call");

            assert.strictEqual(req.cache_control, undefined);
        });

        test("omits the marker for non-Anthropic models", async () => {
            const openaiInfo = { litellm_provider: "openai" } as LiteLLMModelInfo;

            const req = await buildRequest(builder, messages, claudeModel, options({}), openaiInfo, "call");

            assert.strictEqual(req.cache_control, undefined);
        });

        test("omits the marker when model info declares supports_prompt_caching false", async () => {
            const noCachingInfo = {
                litellm_provider: "anthropic",
                supports_prompt_caching: false,
            } as LiteLLMModelInfo;

            const req = await buildRequest(builder, messages, claudeModel, options({}), noCachingInfo, "call");

            assert.strictEqual(req.cache_control, undefined);
        });

        test("omits the marker for a model that already rejected it live", async () => {
            const learnedBuilder = new RequestBuilder({
                configManager,
                getReasoningEffort: () => undefined,
                stripUnsupportedParametersFromRequest: () => {},
                isParameterSupported: () => true,
                getUnsupportedParameters: (id: string) =>
                    id.includes("claude") ? new Set(["cache_control"]) : new Set<string>(),
                getTelemetryOptions: () => ({ caller: "test", modelConfiguration: {} }),
                usageOptOutModels: new Set(),
                extractRawModelName: (id: string) => {
                    const slash = id.indexOf("/");
                    return slash < 0 ? id : id.slice(slash + 1);
                },
            });

            const req = await buildRequest(learnedBuilder, messages, claudeModel, options({}), anthropicInfo, "call");

            assert.strictEqual(req.cache_control, undefined);
        });

        test("keeps the marker for models that never rejected it", async () => {
            const learnedBuilder = new RequestBuilder({
                configManager,
                getReasoningEffort: () => undefined,
                stripUnsupportedParametersFromRequest: () => {},
                isParameterSupported: () => true,
                getUnsupportedParameters: (id: string) =>
                    id.includes("gpt-") ? new Set(["cache_control"]) : new Set<string>(),
                getTelemetryOptions: () => ({ caller: "test", modelConfiguration: {} }),
                usageOptOutModels: new Set(),
                extractRawModelName: (id: string) => {
                    const slash = id.indexOf("/");
                    return slash < 0 ? id : id.slice(slash + 1);
                },
            });

            const req = await buildRequest(learnedBuilder, messages, claudeModel, options({}), anthropicInfo, "call");

            assert.deepStrictEqual(req.cache_control, { type: "ephemeral" });
        });
    });

    suite("DeepSeek reasoning_content fill", () => {
        const callId = "fc_test_deepseek_123456789012345678901234567890";
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("do the work")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(callId, "run", {})],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")])],
                name: undefined,
            },
        ] as unknown as vscode.LanguageModelChatRequestMessage[];
        const tools = [
            { name: "run", description: "run", inputSchema: { type: "object", properties: {} } },
        ] as vscode.LanguageModelChatTool[];

        function options(withTools: boolean): vscode.ProvideLanguageModelChatResponseOptions {
            return {
                modelOptions: {},
                tools: withTools ? tools : [],
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
        }

        setup(() => {
            configManager.getConfig.resolves({});
        });

        test("fills empty reasoning_content for a DeepSeek model with tools", async () => {
            const model = {
                id: "litellm.example/DeepSeek-V4.1-Flash",
                maxInputTokens: 1000,
                maxOutputTokens: 100,
            } as vscode.LanguageModelChatInformation;
            const modelInfo = { litellm_provider: "deepseek" } as LiteLLMModelInfo;

            const req = await buildRequest(builder, messages, model, options(true), modelInfo, "caller");

            assert.strictEqual(req.messages[1].reasoning_content, "");
        });

        test("does not add reasoning_content for a non-DeepSeek model with tools", async () => {
            const model = {
                id: "litellm.example/gpt-5.4-mini",
                maxInputTokens: 1000,
                maxOutputTokens: 100,
            } as vscode.LanguageModelChatInformation;
            const modelInfo = { litellm_provider: "openai" } as LiteLLMModelInfo;

            const req = await buildRequest(builder, messages, model, options(true), modelInfo, "caller");

            assert.strictEqual(req.messages[1].reasoning_content, undefined);
        });

        test("does not add reasoning_content for a DeepSeek model without tools", async () => {
            const model = {
                id: "litellm.example/DeepSeek-V4.1-Flash",
                maxInputTokens: 1000,
                maxOutputTokens: 100,
            } as vscode.LanguageModelChatInformation;
            const modelInfo = { litellm_provider: "deepseek" } as LiteLLMModelInfo;

            const req = await buildRequest(builder, messages, model, options(false), modelInfo, "caller");

            assert.strictEqual(req.messages[1].reasoning_content, undefined);
        });

        test("detects DeepSeek from the model id when provider info is absent", async () => {
            const model = {
                id: "litellm.example/DeepSeek-V4.1-Flash",
                maxInputTokens: 1000,
                maxOutputTokens: 100,
            } as vscode.LanguageModelChatInformation;

            const req = await buildRequest(builder, messages, model, options(true), undefined, "caller");

            assert.strictEqual(req.messages[1].reasoning_content, "");
        });
    });
});
