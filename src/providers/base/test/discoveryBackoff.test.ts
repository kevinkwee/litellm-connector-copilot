import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ConfigManager } from "../../../config/configManager";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { DiscoveryBackoffController, sharedDiscoveryBackoff, type DiscoveryBackoffDecision } from "../discoveryBackoff";
import { LiteLLMProviderRegistry } from "../../liteLLMProviderRegistry";

/**
 * Tests for `DiscoveryBackoffController`, the `DiscoveryBackoffRegistry` that
 * keeps one controller per backend, and the registry's discovery integration.
 * When an HTTP `/model/info` request fails, the registry consults
 * `sharedDiscoveryBackoff.recordFailure(...)` and waits for the computed
 * delay. It then serves the backend's last-known models. With none to serve it
 * returns an empty list, until the failure threshold is exceeded and a
 * `vscode.LanguageModelError.Blocked` is thrown.
 *
 * `clearCaches()` clears every backend's history so a user-initiated reload
 * starts from a clean slate.
 */
suite("Discovery backoff", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;

    setup(() => {
        sandbox = sinon.createSandbox();
        sharedDiscoveryBackoff.reset();
        configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({} as never);
    });

    teardown(() => {
        sharedDiscoveryBackoff.reset();
        sandbox.restore();
    });

    test("controller escalates delay and blocks on the 10th failure", () => {
        const backoff = new DiscoveryBackoffController();

        const decisions: DiscoveryBackoffDecision[] = [];
        for (let i = 0; i < 9; i++) {
            const decision = backoff.recordFailure(i * 1_000);
            decisions.push(decision);
            assert.strictEqual(decision.attempt, i + 1);
            assert.strictEqual(decision.delayMs, (i + 1) * 500);
            assert.strictEqual(decision.shouldBlock, false);
        }

        const ninth = decisions[8];
        assert.strictEqual(ninth.attempt, 9);
        assert.strictEqual(ninth.delayMs, 4_500);
        assert.strictEqual(ninth.shouldBlock, false);

        const tenth = backoff.recordFailure(9_000);
        assert.strictEqual(tenth.attempt, 10);
        assert.strictEqual(tenth.delayMs, 5_000);
        assert.strictEqual(tenth.shouldBlock, true);

        const blockedWhileCoolingDown = backoff.recordFailure(9_500);
        assert.strictEqual(blockedWhileCoolingDown.attempt, 10);
        assert.strictEqual(blockedWhileCoolingDown.delayMs, 0);
        assert.strictEqual(blockedWhileCoolingDown.shouldBlock, true);
    });

    test("controller resets after 5 seconds without a new failure", () => {
        const backoff = new DiscoveryBackoffController();

        backoff.recordFailure(0);
        backoff.recordFailure(1_000);

        const resetDecision = backoff.recordFailure(6_001);
        assert.strictEqual(resetDecision.attempt, 1);
        assert.strictEqual(resetDecision.delayMs, 500);
        assert.strictEqual(resetDecision.shouldBlock, false);
    });

    test("turns a blocked decision into a Blocked error when the group has no models", async () => {
        // The shared backoff reports the backend as blocked, so discovery must
        // reject instead of returning an empty list.

        const recordFailureStub = sandbox.stub(sharedDiscoveryBackoff, "recordFailure").callsFake(() => ({
            attempt: 1,
            delayMs: 500,
            shouldBlock: true,
        }));

        // Create a stub client that rejects on getModelInfo
        const stubClient = {
            getModelInfo: sandbox.stub().rejects(new Error("HTTP request failed")),
            getEndpoint: sandbox.stub().returns("http://localhost:4000/v1/chat/completions"),
        };

        (configManager.convertProviderConfiguration as sinon.SinonStub).returns({
            backendName: "test-backend",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: stubClient,
        });

        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
        });

        const token = new vscode.CancellationTokenSource().token;

        // First discovery should trigger backoff and block
        const promise = registry.discoverModels(
            {
                silent: false,
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            token
        );
        await assert.rejects(promise, /Discovery blocked/);

        // recordFailure should have been called at least once
        assert.ok(recordFailureStub.calledOnce);
    });

    test("clearCaches resets the shared backoff state", () => {
        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
        });

        sharedDiscoveryBackoff.recordFailure("backend", 0);
        sharedDiscoveryBackoff.recordFailure("backend", 1_000);

        registry.clearCaches();

        const decision = sharedDiscoveryBackoff.recordFailure("backend", 0);
        assert.strictEqual(decision.attempt, 1);
        assert.strictEqual(decision.delayMs, 500);
        assert.strictEqual(decision.shouldBlock, false);
    });

    test("keeps one failure history per backend", () => {
        for (let i = 0; i < 9; i++) {
            sharedDiscoveryBackoff.recordFailure("backend-a", i * 1_000);
        }

        const otherBackend = sharedDiscoveryBackoff.recordFailure("backend-b", 9_500);

        assert.strictEqual(otherBackend.attempt, 1);
        assert.strictEqual(otherBackend.delayMs, 500);
        assert.strictEqual(otherBackend.shouldBlock, false);
    });

    test("a successful discovery clears that backend's failure history", async () => {
        const stubClient = {
            getModelInfo: sandbox
                .stub()
                .onFirstCall()
                .rejects(new Error("HTTP request failed"))
                .onSecondCall()
                .resolves({ data: [{ model_name: "model", model_info: { key: "model" } }] }),
            getEndpoint: sandbox.stub().returns("http://localhost:4000/v1/chat/completions"),
        };
        (configManager.convertProviderConfiguration as sinon.SinonStub).returns({
            backendName: "test-backend",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: stubClient,
        });
        configManager.getConfig.resolves({ discoveryCacheTtlMs: 0 } as never);
        const resetSpy = sandbox.spy(sharedDiscoveryBackoff, "reset");
        const recordFailureSpy = sandbox.spy(sharedDiscoveryBackoff, "recordFailure");

        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
        });
        const configuration = { baseUrl: "http://localhost:4000", apiKey: "test-key" };
        const token = new vscode.CancellationTokenSource().token;

        // First fetch fails, second succeeds. A second backend accumulates a
        // failure in between, so a reset that cleared every history would be
        // detected.
        await registry.discoverModels({ configuration }, token);
        assert.strictEqual(resetSpy.called, false);
        sharedDiscoveryBackoff.recordFailure("other-backend", Date.now());
        await registry.discoverModels({ configuration }, token);

        assert.strictEqual(resetSpy.callCount, 1);
        const key = resetSpy.firstCall.args[0];
        assert.strictEqual(typeof key, "string");
        assert.ok((key as string).length > 0);
        assert.strictEqual(key, recordFailureSpy.firstCall.args[0]);
        assert.strictEqual(sharedDiscoveryBackoff.recordFailure(key as string, Date.now()).attempt, 1);
        assert.strictEqual(sharedDiscoveryBackoff.recordFailure("other-backend", Date.now()).attempt, 2);
    });

    test("serves last-known models instead of blocking a group that still has them", async () => {
        const stubClient = {
            getModelInfo: sandbox
                .stub()
                .onFirstCall()
                .resolves({ data: [{ model_name: "model", model_info: { key: "model" } }] })
                .rejects(new Error("HTTP request failed")),
            getEndpoint: sandbox.stub().returns("http://localhost:4000/v1/chat/completions"),
        };
        (configManager.convertProviderConfiguration as sinon.SinonStub).returns({
            backendName: "test-backend",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: stubClient,
        });
        configManager.getConfig.resolves({ discoveryCacheTtlMs: 0 } as never);

        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
        });

        const configuration = { baseUrl: "http://localhost:4000", apiKey: "test-key" };
        const token = new vscode.CancellationTokenSource().token;

        const seeded = await registry.discoverModels({ configuration }, token);
        assert.strictEqual(seeded.length, 1);

        // The endpoint has crossed the block threshold, but the group still has
        // a list to serve, so the stale list must win over the Blocked error.
        sandbox.stub(sharedDiscoveryBackoff, "recordFailure").returns({
            attempt: 10,
            delayMs: 0,
            shouldBlock: true,
        });

        const served = await registry.discoverModels({ configuration }, token);

        assert.strictEqual(served.length, 1);
        assert.ok(served[0].statusIcon !== undefined);
    });

    test("a cancelled discovery does not wait out the backoff delay", async () => {
        const stubClient = {
            getModelInfo: sandbox.stub().rejects(new Error("HTTP request failed")),
            getEndpoint: sandbox.stub().returns("http://localhost:4000/v1/chat/completions"),
        };
        (configManager.convertProviderConfiguration as sinon.SinonStub).returns({
            backendName: "test-backend",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: stubClient,
        });
        configManager.getConfig.resolves({ discoveryCacheTtlMs: 0 } as never);
        sandbox.stub(sharedDiscoveryBackoff, "recordFailure").returns({
            attempt: 9,
            delayMs: 5_000,
            shouldBlock: false,
        });

        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
        });
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel();

        const startedAt = Date.now();
        const models = await registry.discoverModels(
            { configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" } },
            tokenSource.token
        );

        assert.deepStrictEqual(models, []);
        assert.ok(Date.now() - startedAt < 1_000, "the cancelled wait must not sleep the full delay");
    });

    test("logs a discovery failure that has no last-known models", async () => {
        const stubClient = {
            getModelInfo: sandbox.stub().rejects(new Error("HTTP request failed")),
            getEndpoint: sandbox.stub().returns("http://localhost:4000/v1/chat/completions"),
        };
        (configManager.convertProviderConfiguration as sinon.SinonStub).returns({
            backendName: "test-backend",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: stubClient,
        });
        configManager.getConfig.resolves({ discoveryCacheTtlMs: 0 } as never);
        sandbox.stub(sharedDiscoveryBackoff, "recordFailure").returns({
            attempt: 1,
            delayMs: 0,
            shouldBlock: false,
        });
        const warnStub = sandbox.stub(StructuredLogger, "warn");

        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
        });
        await registry.discoverModels(
            { configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" } },
            new vscode.CancellationTokenSource().token
        );

        const events = warnStub
            .getCalls()
            .filter((call) => call.args[0] === "discovery.failed_without_last_known")
            .map((call) => call.args[1] as Record<string, unknown>);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].baseUrl, "http://localhost:4000");
        assert.strictEqual(typeof events[0].reason, "string");
    });
});
