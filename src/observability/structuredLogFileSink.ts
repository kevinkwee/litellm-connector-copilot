import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Best-effort JSONL file mirror for the "LiteLLM Structured" log channel.
 *
 * VS Code rotates output-channel logs at a small cap, so warn- and
 * error-level diagnostics that would explain a failure are typically gone
 * by the time someone investigates. The sink appends every log line to a
 * daily file under `<globalStorage>/structured-logs/` with day rollover, a
 * per-file size cap, and a retention prune on startup.
 *
 * Failure policy: persistence must never break the request pipeline. A sink
 * that cannot write disables itself; the channel keeps logging.
 */

const FILE_PREFIX = "structured-";
const FILE_SUFFIX = ".jsonl";
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export interface StructuredLogFileSinkOptions {
    /** Byte cap per file before rolling to a second file within the same day. */
    maxFileBytes?: number;
    /** Days a log file survives the startup retention prune. 0 disables pruning. */
    retentionDays?: number;
}

export class StructuredLogFileSink {
    private readonly maxFileBytes: number;
    private readonly retentionDays: number;

    private enabled = false;
    private storageDir: string | undefined;
    private activeFilePath: string | undefined;
    private currentDayKey: string | undefined;
    private byteCount = 0;

    public constructor(options: StructuredLogFileSinkOptions = {}) {
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
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
            this.byteCount += line.length + 1;
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
        let name = `${FILE_PREFIX}${dayKey}${FILE_SUFFIX}`;
        if (this.activeFilePath && sameDay && this.byteCount >= this.maxFileBytes) {
            name = `${FILE_PREFIX}${dayKey}-${Date.now()}${FILE_SUFFIX}`;
        }
        this.activeFilePath = join(this.storageDir as string, name);
        this.currentDayKey = dayKey;
        this.byteCount = existsSync(this.activeFilePath) ? statSync(this.activeFilePath).size : 0;
    }

    /** Deletes log files older than the retention window. Best effort per file. */
    private pruneExpiredFiles(): void {
        if (!this.storageDir || this.retentionDays <= 0) {
            return;
        }
        const cutoff = Date.now() - this.retentionDays * MS_PER_DAY;
        let entries: string[];
        try {
            entries = readdirSync(this.storageDir);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) {
                continue;
            }
            const fullPath = join(this.storageDir, entry);
            try {
                if (statSync(fullPath).mtimeMs < cutoff) {
                    rmSync(fullPath, { force: true });
                }
            } catch {
                // Retention is best effort; an undeletable file is harmless.
            }
        }
    }
}
