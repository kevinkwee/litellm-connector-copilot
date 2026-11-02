import * as vscode from "vscode";
import type { ActiveRequestEntry, ActiveRequestRegistry } from "../providers/activeRequests";
import { StructuredLogger } from "../observability/structuredLogger";

/** QuickPick rows: one per live request, plus the row that cancels them all when several are live. */
type CancelItem =
    | (vscode.QuickPickItem & { action: "request"; entry: ActiveRequestEntry })
    | (vscode.QuickPickItem & { action: "all" });

/**
 * Registers the command that ends a live request at the user's choosing.
 *
 * The Agents window passes `CancellationToken.None`, so VS Code's Stop button
 * cannot reach a provider request there and a turn waiting on a wedged upstream
 * is otherwise ended only by a time bound. Cancelling aborts the connector's own
 * work, which closes the socket and lets the turn end with a notice instead of
 * hanging.
 */
export function registerCancelActiveRequestCommand(registry: ActiveRequestRegistry): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.cancelActiveRequest", async () => {
        const active = registry.list();
        if (active.length === 0) {
            void vscode.window.showInformationMessage("No LiteLLM request is currently running.");
            return;
        }

        const items: CancelItem[] = active.map((entry) => ({
            label: `$(debug-stop) ${entry.model}`,
            description: `${entry.caller} · ${describePhase(entry)} · ${describeElapsed(entry)}`,
            detail: `request ${entry.requestId}`,
            action: "request",
            entry,
        }));
        if (active.length > 1) {
            items.unshift({
                label: "$(close-all) Cancel all active requests",
                description: `${active.length} requests running`,
                action: "all",
            });
        }

        const picked = await vscode.window.showQuickPick(items, {
            title: "Cancel Active LiteLLM Request",
            placeHolder: "Choose the request to cancel",
        });
        if (!picked) {
            return;
        }

        // Read once, after the picker closes: a request may have finished, or started,
        // while the user was choosing.
        const liveEntries = new Set(registry.list());

        if (picked.action === "all") {
            // Cancel exactly the requests the user saw, not whatever happens to be
            // live now: a request that started while the picker was open is not
            // something the user chose to cancel.
            const cancelled = active.filter((entry) => liveEntries.has(entry));
            for (const entry of cancelled) {
                entry.cancel();
            }
            StructuredLogger.info("command.cancel_all_requests", {
                listed: active.length,
                cancelled: cancelled.length,
            });
            if (cancelled.length === 0) {
                void vscode.window.showInformationMessage("Those LiteLLM requests had already finished.");
            }
            return;
        }

        if (!liveEntries.has(picked.entry)) {
            StructuredLogger.info("command.cancel_request_already_finished", {
                requestId: picked.entry.requestId,
            });
            void vscode.window.showInformationMessage("That LiteLLM request had already finished.");
            return;
        }
        picked.entry.cancel();
        StructuredLogger.info("command.cancel_request", {
            requestId: picked.entry.requestId,
            model: picked.entry.model,
            caller: picked.entry.caller,
        });
    });
}

function describePhase(entry: ActiveRequestEntry): string {
    return entry.phase === "streaming" ? "streaming" : "waiting for headers";
}

function describeElapsed(entry: ActiveRequestEntry): string {
    const seconds = Math.max(0, Math.round((Date.now() - entry.startedAt) / 1_000));
    return `${seconds}s`;
}
