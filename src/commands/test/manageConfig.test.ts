import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
} from "../../commands/manageConfig";
import type { LiteLLMChatProvider } from "../../providers";

suite("ManageConfig Command Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("registers command correctly", () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerManageConfigCommand();
        assert.strictEqual(registerStub.calledWith("litellm-connector.manage"), true);
    });

    test("manage command opens Language Models view", async () => {
        const executeCommandStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        // Simulate the user clicking "Open Language Models" so the handler proceeds to execute the command.
        sandbox
            .stub(vscode.window, "showInformationMessage")
            .resolves("Open Language Models" as unknown as vscode.MessageItem);

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageConfigCommand();
        await commandHandler?.();

        assert.strictEqual(executeCommandStub.called, true);
    });

    test("calls reloadModels and reports that a reload started", async () => {
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");
        const reloadStub = sandbox.stub();

        const provider = {
            reloadModels: reloadStub,
        } as unknown as LiteLLMChatProvider;

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.strictEqual(reloadStub.calledOnce, true);
        assert.ok(infoStub.calledOnce);
        assert.strictEqual(infoStub.firstCall.args[0], "LiteLLM: Reloading models...");
    });
});

suite("Model Commands Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("showModels: describes each row with the routable id", async () => {
        const model = { id: "litellm.example/model", name: "model", family: "litellm" } as vscode.LanguageModelChat;
        const listModels = () => Promise.resolve([model]);
        let items: readonly vscode.QuickPickItem[] | undefined;
        sandbox.stub(vscode.window, "showQuickPick").callsFake(async (candidate) => {
            items = candidate as readonly vscode.QuickPickItem[];
            return undefined;
        });

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(listModels);
        await handler?.();

        assert.strictEqual(items?.[0].description, "litellm.example/model");
    });
    test("showModels: prompts to reload when no models are available", async () => {
        const listModels = () => Promise.resolve([]);

        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(listModels);
        await handler?.();

        assert.strictEqual(infoStub.calledOnce, true);
        assert.ok(String(infoStub.firstCall.args[0]).includes("No LiteLLM models are available"));
    });

    test("showModels: quick pick copies model id", async () => {
        // The `vscode.env.clipboard.writeText` property is non-configurable in the
        // extension host test environment, so we cannot stub it directly. Instead we
        // assert the user-visible side-effect: the "Copied model id:" information
        // message includes the model id the user selected. The clipboard write itself
        // is exercised manually in development.
        const listModels = () =>
            Promise.resolve([
                {
                    id: "backend/model",
                    name: "backend/model",
                    family: "litellm",
                } as vscode.LanguageModelChat,
            ]);

        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.resolves({ modelId: "backend/model" } as unknown as vscode.QuickPickItem);

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(listModels);
        await handler?.();

        assert.strictEqual(infoStub.calledOnce, true);
        assert.ok(
            String(infoStub.firstCall.args[0]).includes("Copied model id: backend/model"),
            "Information message should announce the copied model id"
        );
    });

    test("showModels: lists exactly the models VS Code reports", async () => {
        const listModels = () =>
            Promise.resolve([
                { id: "host-a/model-1", name: "model-1", family: "openai" },
                { id: "host-b/model-2", name: "model-2", family: "anthropic" },
            ] as vscode.LanguageModelChat[]);
        let items: readonly vscode.QuickPickItem[] | undefined;
        sandbox.stub(vscode.window, "showQuickPick").callsFake(async (candidate) => {
            items = candidate as readonly vscode.QuickPickItem[];
            return undefined;
        });

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(listModels);
        await handler?.();

        assert.deepStrictEqual(
            items?.map((item) => `${item.label}|${item.description}|${item.detail}`),
            ["model-1|host-a/model-1|openai", "model-2|host-b/model-2|anthropic"],
            "each row shows the model name, the routable id, and the family"
        );
    });
});
