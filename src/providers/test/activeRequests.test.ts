import * as assert from "assert";
import * as sinon from "sinon";
import { ActiveRequestRegistry, type ActiveRequestEntry } from "../activeRequests";

function createEntry(requestId: string, startedAt: number, cancel: () => void = () => undefined): ActiveRequestEntry {
    return {
        requestId,
        model: `model-${requestId}`,
        caller: "core",
        startedAt,
        phase: "sending",
        cancel,
    };
}

suite("ActiveRequestRegistry", () => {
    test("lists a registered request until its handle is disposed", () => {
        const registry = new ActiveRequestRegistry();

        const handle = registry.register(createEntry("a", 1_000));
        assert.deepStrictEqual(
            registry.list().map((listed) => listed.requestId),
            ["a"]
        );

        handle.dispose();
        assert.deepStrictEqual(registry.list(), []);
    });

    test("lists requests oldest first", () => {
        const registry = new ActiveRequestRegistry();

        registry.register(createEntry("later", 2_000));
        registry.register(createEntry("earlier", 1_000));

        assert.deepStrictEqual(
            registry.list().map((listed) => listed.requestId),
            ["earlier", "later"]
        );
    });

    test("records the phase the owner reports", () => {
        const registry = new ActiveRequestRegistry();
        const handle = registry.register(createEntry("a", 1_000));

        handle.setPhase("streaming");

        assert.strictEqual(registry.list()[0].phase, "streaming");
    });

    test("ignores a phase update after the request is gone", () => {
        const registry = new ActiveRequestRegistry();
        const handle = registry.register(createEntry("a", 1_000));
        handle.dispose();

        handle.setPhase("streaming");

        assert.deepStrictEqual(registry.list(), [], "a finished request must not reappear");
    });

    test("keeps two requests apart when one is cancelled", () => {
        const registry = new ActiveRequestRegistry();
        const first = sinon.spy();
        const second = sinon.spy();
        registry.register(createEntry("a", 1_000, first));
        registry.register(createEntry("b", 2_000, second));

        registry.list()[0].cancel();

        assert.strictEqual(first.callCount, 1);
        assert.strictEqual(second.callCount, 0);
        assert.strictEqual(registry.list().length, 2, "cancelling does not remove the entry");
    });

    test("keeps two requests apart when they share a request id", () => {
        // A short request id can repeat; registering the second must not make the
        // first one's handle remove it.
        const registry = new ActiveRequestRegistry();
        const first = registry.register(createEntry("same", 1_000));
        registry.register(createEntry("same", 2_000));

        first.dispose();

        assert.strictEqual(registry.list().length, 1, "only the disposed registration is removed");
        assert.strictEqual(registry.list()[0].startedAt, 2_000);
    });

    test("list identity stays stable across phase updates", () => {
        // The command tells liveness by identity, so a phase change must not replace
        // the listed object.
        const registry = new ActiveRequestRegistry();
        const handle = registry.register(createEntry("a", 1_000));
        const before = registry.list()[0];

        handle.setPhase("streaming");

        assert.strictEqual(registry.list()[0], before, "the entry keeps its identity");
        assert.strictEqual(registry.list()[0].phase, "streaming");
    });
});
