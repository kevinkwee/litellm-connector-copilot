import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Best-effort JSONL file mirror for the "LiteLLM Structured" log channel.
 *
 * VS Code rotates output-channel logs at a small cap, so warn- and
 * error-level diagnostics that would explain a failure are typically gone
 * by the time someone investigates. The sink appends every log line to a
 * daily file under `<globalStorage>/structured-logs/` with day rollover, a
 * per-file size cap, a folder-wide byte cap, and a retention prune at startup
 * and at every rollover.
 *
 * Failure policy: persistence must never break the request pipeline. A sink
 * that cannot write disables itself; the channel keeps logging.
 *
 * The storage folder is shared by every VS Code window that uses the same
 * extension host storage, so a cap pass in one window can delete a file another
 * window is writing. That window recreates the file on its next append, and every
 * deletion is best effort.
 */

const FILE_PREFIX = "structured-";
const FILE_SUFFIX = ".jsonl";
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export interface StructuredLogFileSinkOptions {
    /** Byte cap per file before rolling to a second file within the same day. */
    maxFileBytes?: number;
    /** Byte cap across every log file. Beyond it, the oldest files are deleted at startup and at each rollover. */
    maxTotalBytes?: number;
    /** Days a log file survives a retention prune. 0 disables pruning. */
    retentionDays?: number;
}

export class StructuredLogFileSink {
    private readonly maxFileBytes: number;
    private readonly maxTotalBytes: number;
    private readonly retentionDays: number;

    private enabled = false;
    private storageDir: string | undefined;
    private activeFilePath: string | undefined;
    private currentDayKey: string | undefined;
    private byteCount = 0;

    public constructor(options: StructuredLogFileSinkOptions = {}) {
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
        this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    }

    public get isEnabled(): boolean {
        return this.enabled;
    }

    public get currentFilePath(): string | undefined {
        return this.activeFilePath;
    }

    /**
     * Points the sink at a storage root and creates the log directory. A
     * missing path or an unwritable location disables the sink instead of
     * throwing: logging must never fail activation.
     */
    public initialize(storagePath: string | undefined): void {
        this.enabled = false;
        this.storageDir = undefined;
        this.activeFilePath = undefined;
        this.currentDayKey = undefined;
        this.byteCount = 0;
        if (!storagePath) {
            return;
        }
        try {
            this.storageDir = join(storagePath, "structured-logs");
            mkdirSync(this.storageDir, { recursive: true });
            this.pruneExpiredFiles();
            this.ensureCurrentFile();
            // Also enforce the folder cap at startup, not only at rollover.
            this.enforceTotalCap();
            this.enabled = true;
        } catch {
            this.storageDir = undefined;
        }
    }

    /**
     * Appends one log line. Synchronous by design: ordering matters when
     * correlating a crash against the last written events, and the sink
     * disables itself on the first write failure rather than retrying on
     * every subsequent log call.
     */
    public append(line: string): void {
        if (!this.enabled || !this.storageDir) {
            return;
        }
        try {
            this.ensureCurrentFile();
            appendFileSync(this.activeFilePath as string, `${line}\n`);
            // Bytes, not UTF-16 units: a multi-byte line would otherwise be
            // undercounted and the cap would overshoot.
            this.byteCount += Buffer.byteLength(line, "utf8") + 1;
        } catch {
            this.enabled = false;
        }
    }

    /**
     * Rotates to a fresh file on day change or when the current file exceeds
     * the size cap, and resumes byte accounting on an existing file so a
     * restart does not overshoot the cap.
     */
    private ensureCurrentFile(): void {
        const dayKey = new Date().toISOString().slice(0, 10);
        const sameDay = this.currentDayKey === dayKey;
        if (this.activeFilePath && sameDay && this.byteCount < this.maxFileBytes) {
            return;
        }
        const rolling = this.activeFilePath !== undefined;
        let name = `${FILE_PREFIX}${dayKey}${FILE_SUFFIX}`;
        if (this.activeFilePath && sameDay && this.byteCount >= this.maxFileBytes) {
            name = `${FILE_PREFIX}${dayKey}-${Date.now()}${FILE_SUFFIX}`;
        }
        this.activeFilePath = join(this.storageDir as string, name);
        this.currentDayKey = dayKey;
        this.byteCount = this.readFileSize(this.activeFilePath);
        if (rolling) {
            // Retention also runs at every rollover, so a long-running session
            // cannot keep expired files past their window.
            this.pruneExpiredFiles();
            this.enforceTotalCap();
        }
    }

    /**
     * Current size of the file, or 0 when it does not exist.
     *
     * A separate existence check races another window that deletes the file
     * between the check and the `statSync`, which would throw and disable the
     * sink for the rest of the session. Any other error still propagates, so a
     * real failure disables the sink the way every other write failure does.
     */
    private readFileSize(path: string): number {
        try {
            return statSync(path).size;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return 0;
            }
            throw err;
        }
    }

    /**
     * Deletes the oldest log files until the total fits the cap, never touching
     * the file the sink is writing. Runs at startup and at rollover, so the cap
     * covers a folder that grew while the extension was closed and a long-running
     * session alike, without a per-line cost.
     */
    private enforceTotalCap(): void {
        if (!this.storageDir || this.maxTotalBytes <= 0) {
            return;
        }
        const files = this.listLogFiles();
        let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        for (const file of files) {
            if (totalBytes <= this.maxTotalBytes) {
                return;
            }
            if (file.path === this.activeFilePath) {
                continue;
            }
            try {
                rmSync(file.path, { force: true });
                totalBytes -= file.size;
            } catch {
                // Best effort: the loop continues with the next-oldest file, so an
                // undeletable file leaves only its own bytes over the cap.
            }
        }
    }

    /** Lists the sink's log files, oldest first. */
    private listLogFiles(): { path: string; size: number; modifiedMs: number }[] {
        if (!this.storageDir) {
            return [];
        }
        let entries: string[];
        try {
            entries = readdirSync(this.storageDir);
        } catch {
            return [];
        }
        const files: { path: string; size: number; modifiedMs: number }[] = [];
        for (const entry of entries) {
            if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) {
                continue;
            }
            const fullPath = join(this.storageDir, entry);
            try {
                const stats = statSync(fullPath);
                files.push({ path: fullPath, size: stats.size, modifiedMs: stats.mtimeMs });
            } catch {
                // A file that vanished between listing and stat is already gone.
            }
        }
        return files.sort((left, right) => left.modifiedMs - right.modifiedMs);
    }

    /** Deletes log files older than the retention window. Best effort per file. */
    private pruneExpiredFiles(): void {
        if (!this.storageDir || this.retentionDays <= 0) {
            return;
        }
        const cutoff = Date.now() - this.retentionDays * MS_PER_DAY;
        for (const file of this.listLogFiles()) {
            if (file.modifiedMs >= cutoff) {
                continue;
            }
            try {
                rmSync(file.path, { force: true });
            } catch {
                // Retention is best effort; an undeletable file is harmless.
            }
        }
    }
}
