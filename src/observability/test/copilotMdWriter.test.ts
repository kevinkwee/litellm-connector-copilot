import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotMdWriter } from "../copilotMdWriter";
import { renderCopilotMd } from "../copilotMdRenderer";
import { StructuredLogger } from "../structuredLogger";
import type { CapsConfig } from "../copilotMdCaps";
import { makeMinimalEntry } from "../../test/utils/copilotMdEntryFixtures";

/**
 * Tests for the `.copilotmd` writer against a real temporary folder, so
 * folder pruning and the `writtenSessionId` the writer passes to the caps
 * selector are checked end to end.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const OLD_MTIME = new Date("2026-01-01T00:00:00Z");

function bytesCap(maxTotalBytes: number): CapsConfig {
    return { maxFilesPerSession: 0, maxSessions: 0, maxTotalBytes };
}

suite("CopilotMdWriter", () => {
    let rootDir: string;
    let debugRoot: string;

    setup(() => {
        rootDir = mkdtempSync(join(tmpdir(), "litellm-copilotmd-"));
        debugRoot = join(rootDir, "copilot-debug");
    });

    teardown(() => {
        sinon.restore();
        rmSync(rootDir, { recursive: true, force: true });
    });

    function seedExportFile(sessionId: string, filename: string, sizeBytes: number, mtime: Date): void {
        const sessionFolder = join(debugRoot, sessionId);
        mkdirSync(sessionFolder, { recursive: true });
        const filePath = join(sessionFolder, filename);
        writeFileSync(filePath, "x".repeat(sizeBytes));
        utimesSync(filePath, mtime, mtime);
    }

    function listEntries(folder: string): string[] {
        return readdirSync(folder).sort();
    }

    test("deletes the oldest whole session and its folder when the byte cap is exceeded", async () => {
        const entry = makeMinimalEntry();
        const writtenBytes = Buffer.byteLength(renderCopilotMd(entry), "utf8");
        seedExportFile("session-old", "a.copilotmd", writtenBytes, OLD_MTIME);
        seedExportFile("session-old", "b.copilotmd", writtenBytes, new Date(OLD_MTIME.getTime() + 60_000));
        const writer = new CopilotMdWriter(vscode.Uri.file(rootDir), bytesCap(2 * writtenBytes));

        await writer.write(entry);

        assert.deepStrictEqual(listEntries(debugRoot), [entry.sessionId]);
    });

    test("keeps the session being written when another session's files look newer", async () => {
        // A future mtime (clock skew, a synced folder) orders the other
        // session after the written one, so only the written-session
        // ordering keeps the new export.
        const entry = makeMinimalEntry();
        const writtenBytes = Buffer.byteLength(renderCopilotMd(entry), "utf8");
        seedExportFile("session-skewed", "a.copilotmd", writtenBytes, new Date(Date.now() + ONE_DAY_MS));
        const writer = new CopilotMdWriter(vscode.Uri.file(rootDir), bytesCap(2 * writtenBytes - 1));

        await writer.write(entry);

        assert.deepStrictEqual(listEntries(debugRoot), [entry.sessionId]);
    });

    test("keeps entries that are not transcripts when evicting their session", async () => {
        // The notes file and the subfolder are neither counted toward the cap
        // nor deleted, so the evicted session's folder is not pruned.
        const entry = makeMinimalEntry();
        const writtenBytes = Buffer.byteLength(renderCopilotMd(entry), "utf8");
        seedExportFile("session-old", "a.copilotmd", writtenBytes, OLD_MTIME);
        seedExportFile("session-old", "notes.txt", 10 * writtenBytes, OLD_MTIME);
        mkdirSync(join(debugRoot, "session-old", "attachments"));
        const writer = new CopilotMdWriter(vscode.Uri.file(rootDir), bytesCap(2 * writtenBytes - 1));

        await writer.write(entry);

        assert.deepStrictEqual(listEntries(join(debugRoot, "session-old")), ["attachments", "notes.txt"]);
    });

    test("keeps a file at the export root when evicting sessions", async () => {
        const entry = makeMinimalEntry();
        const writtenBytes = Buffer.byteLength(renderCopilotMd(entry), "utf8");
        seedExportFile("session-old", "a.copilotmd", writtenBytes, OLD_MTIME);
        writeFileSync(join(debugRoot, "stray.txt"), "x");
        const writer = new CopilotMdWriter(vscode.Uri.file(rootDir), bytesCap(2 * writtenBytes - 1));

        await writer.write(entry);

        assert.deepStrictEqual(listEntries(debugRoot), [entry.sessionId, "stray.txt"].sort());
    });

    test("logs the session id source on the copilotmd.exported event", async () => {
        const infoStub = sinon.stub(StructuredLogger, "info");
        const writer = new CopilotMdWriter(vscode.Uri.file(rootDir), bytesCap(0));

        await writer.write(makeMinimalEntry({ sessionIdSource: "conversation" }));

        const exportedEvent = infoStub.getCalls().find((call) => call.args[0] === "copilotmd.exported");
        assert.strictEqual(exportedEvent?.args[1].sessionIdSource, "conversation");
    });

    test("resolves to undefined instead of throwing when the session folder cannot be created", async () => {
        // A file named `copilot-debug` blocks the directory the writer needs.
        writeFileSync(debugRoot, "x");
        const writer = new CopilotMdWriter(vscode.Uri.file(rootDir), bytesCap(0));

        const written = await writer.write(makeMinimalEntry());

        assert.strictEqual(written, undefined);
    });
});
