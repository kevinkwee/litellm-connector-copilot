import * as vscode from "vscode";

/**
 * Cancellation token for one chat request that the connector can end.
 *
 * The Agents window harness passes `CancellationToken.None`, so a provider request
 * there has no host cancellation the user can reach. This token carries the host
 * signal and a connector-controlled one under a single `CancellationToken`, so
 * every consumer reacts to either origin without knowing which one fired.
 */
export class RequestCancellation implements vscode.CancellationToken {
    private readonly emitter = new vscode.EventEmitter<void>();
    private readonly hostRegistration: vscode.Disposable;
    private cancelledByConnectorFlag = false;
    private disposed = false;

    public constructor(private readonly hostToken: vscode.CancellationToken) {
        // Forwarding at once keeps the composite's own event a superset of the
        // host's, so a listener registered here sees either origin.
        this.hostRegistration = hostToken.onCancellationRequested(() => this.fire());
    }

    public get isCancellationRequested(): boolean {
        return this.cancelledByConnectorFlag || this.hostToken.isCancellationRequested;
    }

    public get onCancellationRequested(): vscode.Event<void> {
        return this.emitter.event;
    }

    /**
     * True when the connector cancelled this request and the host did not, so the
     * caller can tell an abandoned turn from a host-cancelled one.
     */
    public get cancelledByConnector(): boolean {
        return this.cancelledByConnectorFlag && !this.hostToken.isCancellationRequested;
    }

    /** Cancels the request from the connector side. Repeat calls are no-ops. */
    public cancelByConnector(): void {
        if (this.isCancellationRequested) {
            return;
        }
        this.cancelledByConnectorFlag = true;
        this.fire();
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.hostRegistration.dispose();
        this.emitter.dispose();
    }

    private fire(): void {
        this.emitter.fire();
    }
}
