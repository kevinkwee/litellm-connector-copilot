import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { registerCancelActiveRequestCommand } from "../cancelActiveRequest";
import { ActiveRequestRegistry, type ActiveRequestHandle } from "../../providers/activeRequests";

/** Captures the registered handler so the test can run the command. */
function captureHandler(sandbox: sinon.SinonSandbox): () => Promise<void> {
    let handler: (() => Promise<void>) | undefined;
    sandbox.stub(vscode.commands, "registerCommand").callsFake((id, callback) => {
        if (id === "litellm-connector.cancelActiveRequest") {
            handler = callback as () => Promise<void>;
        }
        return { dispose: () => undefined } as vscode.Disposable;
    });
    return () => {
        assert.ok(handler, "the command must be registered");
        return handler();
    };
}

function addRequest(
    registry: ActiveRequestRegistry,
    requestId: string,
    options: { model?: string; caller?: string; startedAt?: number; phase?: "sending" | "streaming" } = {}
): { cancel: sinon.SinonSpy; handle: ActiveRequestHandle } {
    const cancel = sinon.spy();
    const handle = registry.register({
        requestId,
        model: options.model ?? "model-1",
        caller: options.caller ?? "core",
        startedAt: options.startedAt ?? 1_000,
        phase: options.phase ?? "streaming",
        cancel,
    });
    return { cancel, handle };
}

suite("Cancel Active Request Command", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("reports that nothing is running when the registry is empty", async () => {
        const registry = new ActiveRequestRegistry();
        const run = captureHandler(sandbox);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(infoStub.callCount, 1);
        assert.match(String(infoStub.firstCall.args[0]), /No LiteLLM request is currently running/);
        assert.strictEqual(quickPickStub.callCount, 0, "an empty registry must not open a picker");
    });

    test("renders one row per live request with its model, caller, phase and elapsed time", async () => {
        const registry = new ActiveRequestRegistry();
        sandbox.useFakeTimers({ now: 1_000_000 });
        addRequest(registry, "req-1", { startedAt: 997_000 });
        const run = captureHandler(sandbox);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.resolves(undefined);

        registerCancelActiveRequestCommand(registry);
        await run();

        const rows = quickPickStub.firstCall?.args[0] as vscode.QuickPickItem[] | undefined;
        assert.ok(rows, "the picker must open");
        assert.strictEqual(rows.length, 1, "a single request needs no Cancel all row");
        assert.match(rows[0].label, /model-1/);
        assert.match(String(rows[0].description), /^core · streaming · 3s$/);
    });

    test("cancels the only live request when it is picked", async () => {
        const registry = new ActiveRequestRegistry();
        const { cancel } = addRequest(registry, "req-1");
        const run = captureHandler(sandbox);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.callsFake(async (items) => (items as vscode.QuickPickItem[])[0]);

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(cancel.callCount, 1);
    });

    test("names the phase of a request that has not received headers yet", async () => {
        const registry = new ActiveRequestRegistry();
        addRequest(registry, "req-1", { phase: "sending" });
        const run = captureHandler(sandbox);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.resolves(undefined);

        registerCancelActiveRequestCommand(registry);
        await run();

        const rows = quickPickStub.firstCall?.args[0] as vscode.QuickPickItem[] | undefined;
        assert.ok(rows, "the picker must open");
        assert.match(String(rows[0].description), /waiting for headers/);
    });

    test("does nothing when the picker is dismissed", async () => {
        const registry = new ActiveRequestRegistry();
        const { cancel } = addRequest(registry, "req-1");
        const run = captureHandler(sandbox);
        sandbox.stub(vscode.window, "showQuickPick").resolves(undefined);

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(cancel.callCount, 0, "a dismissed picker must not cancel anything");
    });

    test("offers Cancel all when several requests are live and cancels them all", async () => {
        const registry = new ActiveRequestRegistry();
        const first = addRequest(registry, "req-1", { startedAt: 1_000 });
        const second = addRequest(registry, "req-2", { startedAt: 2_000 });
        const run = captureHandler(sandbox);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.callsFake(async (items) => {
            const rows = items as vscode.QuickPickItem[];
            assert.strictEqual(rows.length, 3, "two requests plus the Cancel all row");
            assert.match(rows[0].label, /Cancel all active requests/);
            return rows[0];
        });

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(first.cancel.callCount, 1);
        assert.strictEqual(second.cancel.callCount, 1);
    });

    test("Cancel all skips a request that finished and one that started while the picker was open", async () => {
        const registry = new ActiveRequestRegistry();
        const live = addRequest(registry, "req-1", { startedAt: 1_000 });
        const finished = addRequest(registry, "req-2", { startedAt: 2_000 });
        const run = captureHandler(sandbox);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        const late = { cancel: sinon.spy() };
        quickPickStub.callsFake(async (items) => {
            const rows = items as vscode.QuickPickItem[];
            assert.strictEqual(rows.length, 3, "two requests plus the Cancel all row");
            finished.handle.dispose();
            // A request that was not among the rows the user saw.
            registry.register({
                requestId: "req-late",
                model: "model-late",
                caller: "core",
                startedAt: 3_000,
                phase: "sending",
                cancel: late.cancel,
            });
            return rows[0];
        });

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(live.cancel.callCount, 1);
        assert.strictEqual(finished.cancel.callCount, 0, "a request that finished must not be cancelled");
        assert.strictEqual(late.cancel.callCount, 0, "only the requests the user saw are cancelled");
    });

    test("reports that every listed request had finished when Cancel all finds none left", async () => {
        const registry = new ActiveRequestRegistry();
        const first = addRequest(registry, "req-1", { startedAt: 1_000 });
        const second = addRequest(registry, "req-2", { startedAt: 2_000 });
        const run = captureHandler(sandbox);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.callsFake(async (items) => {
            const rows = items as vscode.QuickPickItem[];
            first.handle.dispose();
            second.handle.dispose();
            return rows[0];
        });

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.match(String(infoStub.firstCall?.args[0]), /^Those /);
    });

    test("reports that a picked request already finished instead of cancelling", async () => {
        const registry = new ActiveRequestRegistry();
        const first = addRequest(registry, "req-1", { startedAt: 1_000, model: "model-a" });
        const second = addRequest(registry, "req-2", { startedAt: 2_000 });
        const run = captureHandler(sandbox);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.callsFake(async (items) => {
            const rows = items as vscode.QuickPickItem[];
            const row = rows.find((item) => item.label.includes("model-a"));
            assert.ok(row, "the first request must be listed");
            first.handle.dispose();
            return row;
        });

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(first.cancel.callCount, 0, "a finished request must not be cancelled");
        assert.strictEqual(second.cancel.callCount, 0);
        assert.strictEqual(infoStub.callCount, 1);
        assert.match(String(infoStub.firstCall.args[0]), /already finished/);
    });

    test("cancels only the picked request out of several", async () => {
        const registry = new ActiveRequestRegistry();
        const first = addRequest(registry, "req-1", { startedAt: 1_000, model: "model-a" });
        const second = addRequest(registry, "req-2", { startedAt: 2_000, model: "model-b" });
        const run = captureHandler(sandbox);
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.callsFake(async (items) => {
            const rows = items as vscode.QuickPickItem[];
            const row = rows.find((item) => item.label.includes("model-b"));
            assert.ok(row, "the second request must be listed");
            return row;
        });

        registerCancelActiveRequestCommand(registry);
        await run();

        assert.strictEqual(first.cancel.callCount, 0);
        assert.strictEqual(second.cancel.callCount, 1);
    });
});
