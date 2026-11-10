import type { Disposable } from "vscode";

/** The phase a live request is in, as far as a person choosing one to cancel cares. */
export type ActiveRequestPhase = "sending" | "streaming";

/** The read-only facts about a live request. */
export interface ActiveRequestSummary {
    readonly requestId: string;
    readonly model: string;
    readonly caller: string;
    /** Epoch milliseconds when the request started. */
    readonly startedAt: number;
    readonly phase: ActiveRequestPhase;
}

/** A live request the connector can cancel on the user's behalf. */
export interface ActiveRequestEntry extends ActiveRequestSummary {
    /** Cancelling one entry leaves the others running. */
    readonly cancel: () => void;
}

/** Handle the owner keeps for the lifetime of its request. */
export interface ActiveRequestHandle extends Disposable {
    /** Records the phase the request is in, including a retry moving it back to `sending`. */
    setPhase(phase: ActiveRequestPhase): void;
}

/** Internal record: the listed entry with the phase the owner last reported. */
interface StoredRequest extends ActiveRequestEntry {
    phase: ActiveRequestPhase;
}

/**
 * The chat requests currently in flight, so the user can end one at once.
 *
 * The Agents window gives a provider request no host cancellation, so the user can
 * see the in-flight requests here and end one without waiting for a time bound.
 * Entries are removed in the request's `finally`, so a completed or failed turn
 * never shows up here.
 *
 * `list` hands out the stored entries themselves and their identity is stable for
 * the life of the request, so a caller that kept a listed entry can tell whether
 * it is still live. Keying is by a per-registration symbol, because a request id
 * is short and could repeat.
 */
export class ActiveRequestRegistry {
    private readonly entries = new Map<symbol, StoredRequest>();

    /** Adds a request and returns the handle its owner must dispose. */
    public register(entry: ActiveRequestEntry): ActiveRequestHandle {
        const key = Symbol(entry.requestId);
        const stored: StoredRequest = { ...entry };
        this.entries.set(key, stored);
        return {
            setPhase: (phase: ActiveRequestPhase): void => {
                stored.phase = phase;
            },
            dispose: (): void => {
                this.entries.delete(key);
            },
        };
    }

    /** Live requests, oldest first. */
    public list(): readonly ActiveRequestEntry[] {
        return [...this.entries.values()].sort((left, right) => left.startedAt - right.startedAt);
    }
}
