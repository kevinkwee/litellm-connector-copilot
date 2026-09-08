import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
import { RequestBuilder } from "../base/requestBuilder";
import { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo } from "../../types";

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
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => true,
            // Mirrors `LiteLLMProviderBase.getTelemetryOptions`: VS Code's
            // per-model picker selections arrive via `options.modelConfiguration`.
            getTelemetryOptions: (options: vscode.ProvideLanguageModelChatResponseOptions) => ({
                caller: "test",
                justification: undefined,
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
        const model = { id: "gpt-x", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "caller"
        );
        sinon.assert.match(req.max_tokens, 50);
        sinon.assert.match(req.stream, true);
    });

    suite("temperature from modelConfiguration", () => {
        const model = { id: "gpt-x", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
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
            const req = await builder.buildOpenAIChatRequest(
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
            const req = await builder.buildOpenAIChatRequest(
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
            const req = await builder.buildOpenAIChatRequest(
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
                detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
                stripUnsupportedParametersFromRequest: () => {},
                isParameterSupported: (param: string) => param !== "temperature",
                getTelemetryOptions: (options: vscode.ProvideLanguageModelChatResponseOptions) => ({
                    caller: "test",
                    justification: undefined,
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

            const req = await gatedBuilder.buildOpenAIChatRequest(
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
        const model = { id: "gpt-x", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];
        const modelInfo = { mode: "chat" } as LiteLLMModelInfo;

        const req = await builder.buildOpenAIChatRequest(
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
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param !== "tool_choice", // tool_choice not supported
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
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

        const req = await builderWithGating.buildOpenAIChatRequest(
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

        const req = await builder.buildOpenAIChatRequest(
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

    test("buildOpenAIChatRequest skips trimming when autoTrimMessages is disabled", async () => {
        configManager.getConfig.resolves({ autoTrimMessages: false });
        const model = {
            id: "gpt-x",
            maxInputTokens: 10,
            maxOutputTokens: 5,
        } as vscode.LanguageModelChatInformation;
        const longText = "word ".repeat(500);
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(longText)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "caller"
        );

        // The oversized first message is untouched because trimming is skipped.
        assert.strictEqual(req.messages.length, 2);
    });

    test("buildOpenAIChatRequest trims when autoTrimMessages is enabled", async () => {
        configManager.getConfig.resolves({ autoTrimMessages: true });
        const model = {
            id: "gpt-x",
            maxInputTokens: 10,
            maxOutputTokens: 5,
        } as vscode.LanguageModelChatInformation;
        const longText = "word ".repeat(500);
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(longText)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "caller"
        );

        // Only the recent message fits the tiny budget, so the oversized one is dropped.
        assert.strictEqual(req.messages.length, 1);
        assert.strictEqual(req.messages[0].content, "hi");
    });
});
