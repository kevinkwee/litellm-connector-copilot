import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import type { LiteLLMModelInfoResponse } from "../../types";
import { createMockSecrets } from "../../test/utils/testMocks";
import type { ConfigManager } from "../../config/configManager";
import type { BackendSession } from "../backendSession";

/**
 * Typed view of private members used only by tests. The production class
 * keeps these hidden from callers; the cast lives in one place here.
 */
interface ChatProviderTestAccess {
    _configManager: ConfigManager;
    _registry: {
        lookup: (id: string) => { rawModelName: string } | undefined;
    };
}

/**
 * Tests that the paused-deployment listing rule survives the path from
 * `/model/info` through the chat provider's discovery to the picker list and its
 * change event.
 */
suite("Paused Deployment Discovery Filter", () => {
    suite("discovery through the chat provider", () => {
        const userAgent = "GitHubCopilotChat/test VSCode/test";
        const providerConfig: Record<string, unknown> = {
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
        };

        let sandbox: sinon.SinonSandbox;
        let modelInfoPayload: LiteLLMModelInfoResponse["data"];

        const stubSession = (): BackendSession => ({
            backendName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: {
                getModelInfo: sandbox.stub().callsFake(async () => ({ data: modelInfoPayload })),
            } as unknown as BackendSession["client"],
        });

        const makeProvider = (session: BackendSession): LiteLLMChatProvider => {
            const provider = new LiteLLMChatProvider(createMockSecrets({}), userAgent);
            const configManager = (provider as unknown as ChatProviderTestAccess)._configManager;
            sandbox.stub(configManager, "getConfig").resolves({ discoveryCacheTtlMs: 0 });
            sandbox.stub(configManager, "convertProviderConfiguration").returns(session);
            return provider;
        };

        const access = (provider: LiteLLMChatProvider): ChatProviderTestAccess =>
            provider as unknown as ChatProviderTestAccess;

        const discover = (provider: LiteLLMChatProvider): Promise<vscode.LanguageModelChatInformation[]> =>
            provider.discoverModels(
                { silent: true, configuration: providerConfig },
                new vscode.CancellationTokenSource().token
            );

        setup(() => {
            sandbox = sinon.createSandbox();
            modelInfoPayload = [];
        });

        teardown(() => {
            sandbox.restore();
        });

        test("omits a fully-paused public name from the picker list", async () => {
            modelInfoPayload = [
                { model_name: "glm-5.3", model_info: { litellm_provider: "zhipu", blocked: true } },
                { model_name: "gpt-5.4", model_info: { litellm_provider: "openai" } },
            ];
            const provider = makeProvider(stubSession());

            const models = await discover(provider);

            assert.deepStrictEqual(
                models.map((model) => model.name),
                ["gpt-5.4"]
            );
        });

        test("lists a partially-paused name exactly once for the live deployment", async () => {
            modelInfoPayload = [
                { model_name: "glm-5.3", model_info: { litellm_provider: "zhipu", blocked: true } },
                { model_name: "glm-5.3", model_info: { litellm_provider: "vertex", max_input_tokens: 200_000 } },
            ];
            const provider = makeProvider(stubSession());

            const models = await discover(provider);

            assert.strictEqual(models.length, 1);
            assert.strictEqual(models[0].name, "glm-5.3");
            // family equals the representative deployment's litellm_provider,
            // proving capabilities came from the live deployment, not the
            // paused one shadowing it.
            assert.strictEqual(models[0].family, "vertex");
        });

        test("does not route a fully-paused name through the registry lookup", async () => {
            modelInfoPayload = [{ model_name: "glm-5.3", model_info: { litellm_provider: "zhipu", blocked: true } }];
            const provider = makeProvider(stubSession());

            await discover(provider);

            assert.strictEqual(access(provider)._registry.lookup("localhost/glm-5.3"), undefined);
        });

        test("signals the picker when a live name becomes fully paused", async () => {
            modelInfoPayload = [{ model_name: "glm-5.3", model_info: { litellm_provider: "zhipu" } }];
            const provider = makeProvider(stubSession());
            const fired: number[] = [];
            provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

            const beforePause = await discover(provider);
            assert.strictEqual(beforePause.length, 1);

            modelInfoPayload = [{ model_name: "glm-5.3", model_info: { litellm_provider: "zhipu", blocked: true } }];
            const afterPause = await discover(provider);

            assert.strictEqual(afterPause.length, 0);
            // The first discovery fires once too (no prior delivery to compare
            // against, documented in the change-detection suite), so a
            // live-to-paused transition adds exactly one more event.
            assert.strictEqual(fired.length, 2);
        });
    });
});
