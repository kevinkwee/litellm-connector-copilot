/**
 * Command: `litellm-connector.openCopilotMdFolder`
 *
 * Reveals the directory where `.copilotmd` request logs are being written,
 * so the user can browse them in the OS file explorer without having to
 * know the path. Handles both `globalStorage` (the default, hidden in the
 * extension's data dir) and `workspace` destinations, and gracefully
 * degrades when no `.copilotmd` files have been written yet.
 */

import * as vscode from "vscode";
import { CopilotMdManager, type CopilotMdDestination } from "../observability";
import { StructuredLogger } from "../observability/structuredLogger";

/**
 * Registers the open-folder command.
 *
 * @returns Disposable for the registered command
 */
export function registerOpenCopilotMdFolderCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.openCopilotMdFolder", async () => {
        const config = vscode.workspace.getConfiguration("litellm-connector.debug.copilotMdExport");
        const enabled = config.get<boolean>("enabled", false);
        const destination = config.get<CopilotMdDestination>("destination", "globalStorage");

        if (!enabled) {
            const enable = await vscode.window.showInformationMessage(
                "LiteLLM `.copilotmd` export is currently disabled.",
                "Open Settings"
            );
            if (enable === "Open Settings") {
                await vscode.commands.executeCommand(
                    "workbench.action.openSettings",
                    "litellm-connector.debug.copilotMdExport"
                );
            }
            return;
        }

        // Resolve the root folder the same way CopilotMdManager does, so we
        // reveal the exact location the next export will land in.
        const rootFolder = resolveDestinationRoot(destination);
        if (!rootFolder) {
            vscode.window.showWarningMessage(
                "LiteLLM `.copilotmd` export is enabled but the destination folder could not be resolved. " +
                    "Make sure the extension is activated."
            );
            return;
        }

        const debugFolder = vscode.Uri.joinPath(rootFolder, "copilot-debug");

        // Ensure the folder exists so `revealFileInOS` doesn't error on a
        // missing path before the first export has been written.
        try {
            await vscode.workspace.fs.createDirectory(debugFolder);
        } catch (err) {
            StructuredLogger.warn("copilotmd.open_folder_create_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // `revealFileInOS` opens the OS file explorer at the folder on
        // Windows/macOS/Linux. Falls back to a warning if the command
        // isn't available (e.g. in a remote-only session without a local
        // file system).
        try {
            await vscode.commands.executeCommand("revealFileInOS", debugFolder);
        } catch (err) {
            vscode.window.showWarningMessage(
                `Could not reveal the folder in the OS file explorer. Files are written to: ${debugFolder.fsPath}`
            );
            StructuredLogger.warn("copilotmd.reveal_failed", {
                fsPath: debugFolder.fsPath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
}

/**
 * Resolves the root folder URI for the configured destination, mirroring
 * `CopilotMdManager`'s private logic. Kept in sync so the command reveals
 * the exact location the manager would write to.
 *
 * - `globalStorage` → `context.globalStorageUri` (persists across workspaces).
 * - `workspace` → `context.storageUri` (per-workspace; falls back to
 *   `globalStorageUri` when no workspace is open).
 *
 * Both are inside VS Code's internal storage, never the user's repo folder.
 */
function resolveDestinationRoot(destination: CopilotMdDestination): vscode.Uri | undefined {
    // Delegate to the manager's public static resolver so the command always
    // agrees with the manager on where files land, without reaching into the
    // manager's private `context` field via a fragile cast. Returns
    // `undefined` when the manager hasn't been initialized (extension not
    // activated) — the caller surfaces that as a user-visible warning.
    return CopilotMdManager.resolveDestinationRoot(destination);
}
