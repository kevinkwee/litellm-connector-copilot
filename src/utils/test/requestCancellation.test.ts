import * as assert from "assert";
import * as vscode from "vscode";
import { RequestCancellation } from "../requestCancellation";

/** A host token whose cancellation and disposal the test can observe. */
function createHostToken(): {
    token: vscode.CancellationToken;
    cancel: () => void;
    disposeCalls: () => number;
} {
    const emitter = new vscode.EventEmitter<void>();
    let cancelled = false;
    let disposeCalls = 0;
    const token: vscode.CancellationToken = {
        get isCancellationRequested(): boolean {
            return cancelled;
        },
        onCancellationRequested: (listener: (e: void) => void): vscode.Disposable => {
            const registration = emitter.event(listener);
            return {
                dispose: (): void => {
                    disposeCalls += 1;
                    registration.dispose();
                },
            };
        },
    };
    return {
        token,
        cancel: () => {
            cancelled = true;
            emitter.fire();
        },
        disposeCalls: () => disposeCalls,
    };
}

suite("RequestCancellation", () => {
    test("reports no cancellation before anyone asks", () => {
        const host = new vscode.CancellationTokenSource();
        const cancellation = new RequestCancellation(host.token);

        assert.strictEqual(cancellation.isCancellationRequested, false);
        assert.strictEqual(cancellation.cancelledByConnector, false);

        cancellation.dispose();
        host.dispose();
    });

    test("mirrors a host cancellation without claiming the connector caused it", () => {
        const host = new vscode.CancellationTokenSource();
        const cancellation = new RequestCancellation(host.token);
        const listener = { calls: 0 };
        cancellation.onCancellationRequested(() => {
            listener.calls += 1;
        });

        host.cancel();

        assert.strictEqual(cancellation.isCancellationRequested, true);
        assert.strictEqual(listener.calls, 1, "the composite fires for the host's cancellation");
        assert.strictEqual(cancellation.cancelledByConnector, false);

        cancellation.dispose();
        host.dispose();
    });

    test("cancels from the connector side and reports that origin", () => {
        const host = new vscode.CancellationTokenSource();
        const cancellation = new RequestCancellation(host.token);
        let fired = 0;
        cancellation.onCancellationRequested(() => {
            fired += 1;
        });

        cancellation.cancelByConnector();

        assert.strictEqual(cancellation.isCancellationRequested, true);
        assert.strictEqual(cancellation.cancelledByConnector, true);
        assert.strictEqual(fired, 1);

        cancellation.dispose();
        host.dispose();
    });

    test("treats a repeated connector cancel as a no-op", () => {
        const host = new vscode.CancellationTokenSource();
        const cancellation = new RequestCancellation(host.token);
        let fired = 0;
        cancellation.onCancellationRequested(() => {
            fired += 1;
        });

        cancellation.cancelByConnector();
        cancellation.cancelByConnector();

        assert.strictEqual(fired, 1, "listeners must run once");

        cancellation.dispose();
        host.dispose();
    });

    test("does not cancel when the host already cancelled", () => {
        const host = createHostToken();
        const cancellation = new RequestCancellation(host.token);
        let fired = 0;
        cancellation.onCancellationRequested(() => {
            fired += 1;
        });
        host.cancel();

        cancellation.cancelByConnector();

        assert.strictEqual(cancellation.cancelledByConnector, false, "the host owns that cancellation");
        assert.strictEqual(fired, 1, "the listener must not run twice for one cancellation");

        cancellation.dispose();
    });

    test("releases the host registration when disposed", () => {
        const host = createHostToken();
        const cancellation = new RequestCancellation(host.token);

        cancellation.dispose();

        assert.strictEqual(host.disposeCalls(), 1, "the host registration must be released");
    });

    test("releases the host registration once however often it is disposed", () => {
        const host = createHostToken();
        const cancellation = new RequestCancellation(host.token);

        cancellation.dispose();
        cancellation.dispose();

        assert.strictEqual(host.disposeCalls(), 1);
    });

    test("a disposed token never fires for a connector cancel", () => {
        // The host is never cancelled here, so cancelByConnector really does reach
        // the emitter. What silences the listener is that dispose() disposed the
        // emitter, not the flag that makes dispose() idempotent.
        const host = createHostToken();
        const cancellation = new RequestCancellation(host.token);
        let fired = 0;
        cancellation.onCancellationRequested(() => {
            fired += 1;
        });

        cancellation.dispose();
        cancellation.cancelByConnector();

        assert.strictEqual(fired, 0, "a disposed token must not fire");
    });
});
