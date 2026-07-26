import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StructuredLogger } from "./structuredLogger";
import type { CopilotMdEntry } from "./copilotMdRenderer";
import type { CapsConfig } from "./copilotMdCaps";
import { CopilotMdWriter } from "./copilotMdWriter";

/**
 * # `.copilotmd` export manager
 *
 * Singleton coordinator that:
 * 1. Reads `litellm-connector.debug.copilotMdExport.*` settings on each call
 *    (so users can change caps without reloading the window).
 * 2. Resolves the destination root (`globalStorageUri` by default, or the
 *    first workspace folder when `destination: "workspace"`).
 * 3. Returns `undefined` quickly when the feature is disabled — no entry
 *    rendering, no I/O, no allocation. The hot path pays nothing.
 * 4. Constructs a short-lived {@link CopilotMdWriter} per export with the
 *    current caps, so a setting change between two requests takes effect
 *    immediately without re-initialization.
 *
 * ## Lifecycle
 * `CopilotMdManager.initialize(context)` is called once from `activate()`.
 * After that, `CopilotMdManager.instance.exportEntry(entry)` is safe to
 * call from any provider. The manager holds no per-request state.
 *
 * ## Why per-export writer construction
 * The writer is a thin object over `rootFolder` + `caps`. Constructing one
 * per export is a handful of property assignments — far cheaper than the
 * file write it's about to do — and avoids stale caps if the user changes
 * settings mid-session. We do not cache the writer.
 */
export class CopilotMdManager {
    private static _instance: CopilotMdManager | undefined;

    /**
     * The extension context. Used to resolve `globalStorageUri` (the default
     * destination) and to register disposables.
     */
    private context: vscode.ExtensionContext | undefined;

    // Private to enforce singleton access via `CopilotMdManager.instance`.
    // No construction-time work: the context is injected later by
    // `initialize(context)`, and per-export state is read fresh from VS Code
    // settings on each `exportEntry` call so users can change caps without
    // reloading the window.
    private constructor() {
        // Intentionally empty — see comment above.
    }

    static get instance(): CopilotMdManager {
        if (!this._instance) {
            this._instance = new CopilotMdManager();
        }
        return this._instance;
    }

    /**
     * Idempotent initialization. Safe to call multiple times; only the first
     * call stores the context.
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.instance.context = context;
    }

    /**
     * Exports a single request entry to a `.copilotmd` file under the
     * configured destination, then enforces caps.
     *
     * Returns the written file URI on success, `undefined` when the feature
     * is disabled or when the write failed (failures are logged, never
     * thrown). Designed to be called fire-and-forget from the chat
     * provider's request-completion path.
     */
    async exportEntry(entry: CopilotMdEntry): Promise<vscode.Uri | undefined> {
        const settings = this.readSettings();
        if (!settings.enabled) {
            return undefined;
        }
        const rootFolder = this.resolveRootFolder(settings.destination);
        if (!rootFolder) {
            StructuredLogger.warn("copilotmd.no_destination", {
                destination: settings.destination,
            });
            return undefined;
        }
        const writer = new CopilotMdWriter(rootFolder, settings.caps);
        return writer.write(entry);
    }

    /**
     * Resolves the root folder URI for the configured destination.
     *
     * - `globalStorage` → `context.globalStorageUri` (VS Code's extension-owned
     *   data dir; hidden, persists across all workspaces and survives workspace
     *   removal).
     * - `workspace` → `context.storageUri` (VS Code's per-workspace extension
     *   storage; hidden, scoped to the current workspace, wiped when VS Code
     *   forgets the workspace). Falls back to `globalStorageUri` when no
     *   workspace is open (e.g. a detached window) so the export still works.
     *
     * Both destinations are inside VS Code's internal storage, never the
     * user's actual repo folder — so `.copilot-debug/` never pollutes the
     * Explorer tree, never appears in search/grep, and never risks being
     * committed. Use the `litellm-connector.openCopilotMdFolder` command to
     * reveal the folder in the OS file explorer.
     *
     * Returns `undefined` only when the manager hasn't been initialized
     * (no context yet) — which would be a bug in the activation order.
     */
    private resolveRootFolder(destination: CopilotMdDestination): vscode.Uri | undefined {
        if (!this.context) {
            return undefined;
        }
        if (destination === "workspace") {
            // `context.storageUri` is VS Code's per-workspace extension storage.
            // It's `undefined` when no workspace folder is open (e.g. a detached
            // window with no folder), so fall back to global storage to keep the
            // export working in that degenerate case.
            return this.context.storageUri ?? this.context.globalStorageUri;
        }
        return this.context.globalStorageUri;
    }

    /**
     * Reads the current `litellm-connector.debug.copilotMdExport` settings.
     *
     * Re-read on every call so the user can change caps or toggle the
     * feature without reloading the window. The cost of a
     * `getConfiguration().get()` call is negligible vs. the file write
     * we're about to do.
     */
    private readSettings(): CopilotMdSettings {
        const config = vscode.workspace.getConfiguration("litellm-connector.debug.copilotMdExport");
        const enabled = config.get<boolean>("enabled", false);
        const destination = config.get<CopilotMdDestination>("destination", "workspace");
        const maxFilesPerSession = config.get<number>("maxFilesPerSession", 50);
        const maxSessions = config.get<number>("maxSessions", 100);
        const maxTotalBytes = config.get<number>("maxTotalBytes", 1_073_741_824); // 1 GiB

        // Defensive: negative numbers make no sense; treat them as "unlimited"
        // (the same as 0) so a misconfigured setting can't delete everything.
        const safeCaps: CapsConfig = {
            maxFilesPerSession: Math.max(0, maxFilesPerSession),
            maxSessions: Math.max(0, maxSessions),
            maxTotalBytes: Math.max(0, maxTotalBytes),
        };

        return {
            enabled,
            destination,
            caps: safeCaps,
        };
    }
}

export type CopilotMdDestination = "globalStorage" | "workspace";

export interface CopilotMdSettings {
    enabled: boolean;
    destination: CopilotMdDestination;
    caps: CapsConfig;
}

/**
 * Convenience wrapper for `CopilotMdManager.instance.exportEntry(entry)`
 * that never throws and never blocks the caller. Used by the chat provider
 * to fire-and-forget the export off the request hot path.
 *
 * Errors are logged via `StructuredLogger` and `Logger`; the returned
 * promise always resolves (never rejects) so callers can `void` it without
 * a `.catch()` handler.
 */
export function exportCopilotMdEntry(entry: CopilotMdEntry): Promise<vscode.Uri | undefined> {
    return CopilotMdManager.instance.exportEntry(entry).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        StructuredLogger.error("copilotmd.export_threw", {
            requestId: entry.ourRequestId,
            error: message,
        });
        Logger.error("[copilotMd] exportEntry threw", err);
        return undefined;
    });
}
