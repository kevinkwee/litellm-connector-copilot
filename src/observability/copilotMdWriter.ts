import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StructuredLogger } from "./structuredLogger";
import {
    buildCopilotMdFilename,
    computeSessionFingerprint,
    renderCopilotMd,
    type CopilotMdEntry,
} from "./copilotMdRenderer";
import { selectFilesForDeletion, type CapsConfig, type FileMeta } from "./copilotMdCaps";

/**
 * # `.copilotmd` writer + caps enforcer
 *
 * Side-effectful layer over {@link renderCopilotMd}: takes a finished
 * `CopilotMdEntry`, writes the rendered markdown to the configured
 * destination, and enforces the three user-configured caps (per-session
 * file count, session count, total bytes) by deleting the oldest files
 * that overflow.
 *
 * All filesystem work goes through `vscode.workspace.fs` so remote/WSL
 * workspaces work correctly and writes don't block the request hot path
 * the way Node's synchronous `fs` can.
 *
 * ## Never throws
 * Every public method catches its own errors and reports them via
 * `StructuredLogger` / `Logger`. A failed `.copilotmd` export must never
 * break a chat request — the exporter is observability, not on the
 * critical path.
 */
export class CopilotMdWriter {
    /**
     * @param rootFolder The folder under which `copilot-debug/{sessionFingerprint}/`
     *                    subfolders are created. Caller picks `context.storageUri`
     *                    (per-workspace extension storage, the default) or
     *                    `context.globalStorageUri` (persists across workspaces)
     *                    based on the user's `destination` setting. Both are
     *                    inside VS Code's internal storage, never the user's
     *                    actual repo folder.
     * @param caps Caps configuration already read from VS Code settings.
     */
    constructor(
        private readonly rootFolder: vscode.Uri,
        private readonly caps: CapsConfig
    ) {}

    /**
     * Renders the entry to markdown, writes it to
     * `{rootFolder}/copilot-debug/{sessionFingerprint}/{filename}`, then
     * runs caps enforcement. Resolves to the written file URI on success,
     * `undefined` on failure (errors are logged, never thrown).
     *
     * Designed to be called fire-and-forget from the request completion
     * path: `void this._writer.write(entry).catch(() => { /* already logged *\/ });`
     */
    async write(entry: CopilotMdEntry): Promise<vscode.Uri | undefined> {
        try {
            const sessionFingerprint = computeSessionFingerprint(entry.requestMessages);
            const sessionFolder = vscode.Uri.joinPath(
                this.rootFolder,
                "copilot-debug",
                sessionFingerprint
            );
            const filename = buildCopilotMdFilename(entry);
            const fileUri = vscode.Uri.joinPath(sessionFolder, filename);

            const content = renderCopilotMd(entry);
            const contentBytes = Buffer.from(content, "utf8");

            // Ensure the session folder exists. `createDirectory` is recursive
            // in vscode.workspace.fs and a no-op if the directory already exists.
            await vscode.workspace.fs.createDirectory(sessionFolder);
            await vscode.workspace.fs.writeFile(fileUri, contentBytes);

            StructuredLogger.info("copilotmd.exported", {
                requestId: entry.ourRequestId,
                sessionFingerprint,
                filename,
                bytes: contentBytes.length,
            });

            // Caps enforcement runs after the write so the new file is counted.
            // Failures here are logged but do not propagate — the write already
            // succeeded, and a failed cleanup shouldn't make the export "fail".
            try {
                await this.enforceCaps();
            } catch (cleanupErr) {
                StructuredLogger.warn("copilotmd.caps_failed", {
                    error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                });
            }

            return fileUri;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            StructuredLogger.error("copilotmd.write_failed", {
                requestId: entry.ourRequestId,
                error: message,
            });
            Logger.error("[copilotMdWriter] write failed", err);
            return undefined;
        }
    }

    /**
     * Walks the `copilot-debug/` tree, builds a {@link FileMeta} list, asks
     * {@link selectFilesForDeletion} which files to drop, and deletes them.
     *
     * Exposed `protected` so tests can drive it with a stubbed `vscode.workspace.fs`.
     * Production callers go through {@link write} which invokes this once per
     * exported file.
     */
    protected async enforceCaps(): Promise<void> {
        const debugRoot = vscode.Uri.joinPath(this.rootFolder, "copilot-debug");
        const files = await this.collectFileMetas(debugRoot);
        if (files.length === 0) {
            return;
        }
        const toDelete = selectFilesForDeletion(files, this.caps);
        if (toDelete.length === 0) {
            return;
        }
        StructuredLogger.info("copilotmd.caps_enforced", {
            deletedCount: toDelete.length,
            byBytes: toDelete.reduce((sum, f) => sum + f.sizeBytes, 0),
        });
        await Promise.all(
            toDelete.map(async (f) => {
                try {
                    await vscode.workspace.fs.delete(vscode.Uri.parse(f.uri), { recursive: false });
                } catch (err) {
                    // A missing file between collect and delete is a benign race
                    // (e.g. another sweep or a user cleanup). Don't log those.
                    if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") {
                        return;
                    }
                    StructuredLogger.warn("copilotmd.delete_failed", {
                        uri: f.uri,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            })
        );
        // Clean up now-empty session folders so the directory tree doesn't
        // accumulate orphaned empty folders over time.
        await this.pruneEmptySessionFolders(debugRoot);
    }

    /**
     * Walks `debugRoot/{sessionFingerprint}/*.copilotmd` and builds the
     * flat {@link FileMeta} list the caps selector needs.
     *
     * Two-level walk: list session folders, then list files in each. We
     * intentionally do NOT recurse deeper — the layout is fixed at
     * `copilot-debug/{sessionFingerprint}/{filename}.copilotmd`.
     */
    private async collectFileMetas(debugRoot: vscode.Uri): Promise<FileMeta[]> {
        const metas: FileMeta[] = [];
        let sessionEntries: [string, vscode.FileType][];
        try {
            sessionEntries = await vscode.workspace.fs.readDirectory(debugRoot);
        } catch {
            // Root doesn't exist yet — nothing to enforce.
            return [];
        }
        await Promise.all(
            sessionEntries.map(async ([sessionFingerprint, type]) => {
                if (type !== vscode.FileType.Directory) {return;}
                const sessionFolder = vscode.Uri.joinPath(debugRoot, sessionFingerprint);
                let fileEntries: [string, vscode.FileType][];
                try {
                    fileEntries = await vscode.workspace.fs.readDirectory(sessionFolder);
                } catch {
                    return;
                }
                await Promise.all(
                    fileEntries.map(async ([filename, fileType]) => {
                        if (fileType !== vscode.FileType.File) {return;}
                        if (!filename.endsWith(".copilotmd")) {return;}
                        const fileUri = vscode.Uri.joinPath(sessionFolder, filename);
                        try {
                            const stat = await vscode.workspace.fs.stat(fileUri);
                            metas.push({
                                uri: fileUri.toString(),
                                mtimeMs: stat.mtime,
                                sizeBytes: stat.size,
                                sessionFingerprint,
                            });
                        } catch {
                            // Stat failed (race with deletion) — skip.
                        }
                    })
                );
            })
        );
        return metas;
    }

    /**
     * Removes session folders that no longer contain any `.copilotmd` files.
     * Called after caps enforcement deletes files, so empty folders are
     * expected as a normal byproduct of the per-session and session-count
     * caps.
     */
    private async pruneEmptySessionFolders(debugRoot: vscode.Uri): Promise<void> {
        let sessionEntries: [string, vscode.FileType][];
        try {
            sessionEntries = await vscode.workspace.fs.readDirectory(debugRoot);
        } catch {
            return;
        }
        await Promise.all(
            sessionEntries.map(async ([name, type]) => {
                if (type !== vscode.FileType.Directory) {return;}
                const sessionFolder = vscode.Uri.joinPath(debugRoot, name);
                try {
                    const entries = await vscode.workspace.fs.readDirectory(sessionFolder);
                    if (entries.length === 0) {
                        await vscode.workspace.fs.delete(sessionFolder, { recursive: false });
                    }
                } catch {
                    // Race or already gone — ignore.
                }
            })
        );
    }
}
