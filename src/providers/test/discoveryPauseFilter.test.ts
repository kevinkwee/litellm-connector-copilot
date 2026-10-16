import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import { toListableDeployments } from "../liteLLMProviderRegistry";
import type { LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../../types";
import { createMockSecrets } from "../../test/utils/testMocks";
import type { ConfigManager } from "../../config/configManager";
import type { BackendSession } from "../backendSession";

type ModelInfoEntry = LiteLLMModelInfoResponse["data"][number];

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
 * Tests for the paused-deployment listing rule on `/model/info` discovery.
 * LiteLLM lets a proxy admin pause a deployment (`model_info.blocked`), and
 * one public `model_name` can be served by several deployments. Discovery
 * must apply the proxy's own listing semantics: hide a public name only
 * when every deployment carrying it is paused, and list a
 * multi-deployment name once from a live deployment.
 */
suite("Paused Deployment Discovery Filter", () => {
    suite("toListableDeployments", () => {
        const entry = (modelName: string | undefined, modelInfo?: LiteLLMModelInfo): ModelInfoEntry => ({
            model_name: modelName,
            model_info: modelInfo,
        });

        test("hides a public name whose every deployment is paused", () => {
            const result = toListableDeployments([
                entry("glm-5.3", { blocked: true }),
                entry("glm-5.3", { blocked: true }),
            ]);

            assert.deepStrictEqual(result, []);
        });

        test("keeps a public name with at least one live deployment", () => {
            const result = toListableDeployments([
                entry("glm-5.3", { blocked: true }),
                entry("glm-5.3", { litellm_provider: "zhipu" }),
            ]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_name, "glm-5.3");
            assert.strictEqual(result[0].model_info?.litellm_provider, "zhipu");
        });

        test("represents each multi-deployment name by its first live deployment", () => {
            const result = toListableDeployments([
                entry("glm-5.3", { litellm_provider: "zhipu", max_input_tokens: 111 }),
                entry("glm-5.3", { litellm_provider: "vertex", max_input_tokens: 222 }),
            ]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_info?.litellm_provider, "zhipu");
            assert.strictEqual(result[0].model_info?.max_input_tokens, 111);
        });

        test("keeps a live deployment even when entries for the same name start paused", () => {
            const result = toListableDeployments([
                entry("glm-5.3", { blocked: true }),
                entry("glm-5.3", { litellm_provider: "zhipu" }),
                entry("glm-5.3", { litellm_provider: "vertex" }),
            ]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_info?.litellm_provider, "zhipu");
        });

        test("treats blocked false as live to stay backward compatible", () => {
            const result = toListableDeployments([entry("glm-5.3", { blocked: false })]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_name, "glm-5.3");
        });

        test("treats blocked null as live to stay backward compatible", () => {
            const result = toListableDeployments([entry("glm-5.3", { blocked: null })]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_name, "glm-5.3");
        });

        test("lists entries without model_info because older proxies do not send the flag", () => {
            const result = toListableDeployments([entry("glm-5.3")]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_name, "glm-5.3");
        });

        test("passes entries without a model_name through for the unknown-name skip", () => {
            const malformed = entry(undefined, { litellm_provider: "openai" });
            const result = toListableDeployments([malformed]);

            assert.deepStrictEqual(result, [malformed]);
        });

        test("keeps the one unblocked entry among malformed-name entries", () => {
            const result = toListableDeployments([
                entry(undefined, { blocked: true }),
                entry(undefined, { litellm_provider: "openai" }),
            ]);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].model_info?.litellm_provider, "openai");
        });

        test("preserves the original payload order of listable entries", () => {
            const result = toListableDeployments([
                entry("alpha", { litellm_provider: "openai" }),
                entry("beta", { litellm_provider: "zhipu" }),
                entry("alpha", { litellm_provider: "vertex" }),
            ]);

            assert.deepStrictEqual(
                result.map((listed) => listed.model_name),
                ["alpha", "beta"]
            );
            assert.strictEqual(result[0].model_info?.litellm_provider, "openai");
        });
    });

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
