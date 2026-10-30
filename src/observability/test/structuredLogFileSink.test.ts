import * as assert from "assert";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredLogFileSink } from "../structuredLogFileSink";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("StructuredLogFileSink", () => {
    let dir: string;

    setup(() => {
        dir = mkdtempSync(join(tmpdir(), "litellm-sink-"));
    });

    teardown(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("append no-ops before initialize", () => {
        const sink = new StructuredLogFileSink();
        assert.strictEqual(sink.isEnabled, false);
        assert.doesNotThrow(() => sink.append('{"level":"info"}'));
        assert.strictEqual(readdirSync(dir).length, 0, "nothing may be written before initialize");
    });

    test("initialize creates the log directory and append persists lines", () => {
        const sink = new StructuredLogFileSink();
        sink.initialize(dir);
        assert.strictEqual(sink.isEnabled, true, "a valid storage path must enable the sink");

        sink.append('{"a":1}');
        sink.append('{"a":2}');

        const logsDir = join(dir, "structured-logs");
        const files = readdirSync(logsDir);
        assert.strictEqual(files.length, 1, "one daily file per day");
        const content = readFileSync(join(logsDir, files[0]), "utf8");
        assert.strictEqual(content, '{"a":1}\n{"a":2}\n');
    });

    test("append disables the sink after a write failure instead of throwing", () => {
        const sink = new StructuredLogFileSink();
        // Point the sink inside an existing FILE: directory creation fails,
        // which must disable the sink rather than break the logging call site.
        const blocker = join(dir, "blocker");
        writeFileSync(blocker, "x");
        sink.initialize(join(blocker, "nested"));
        assert.strictEqual(sink.isEnabled, false, "a failed initialize must disable the sink");
        assert.doesNotThrow(() => sink.append("line"));
    });

    test("rolls to a new file when the size cap is exceeded", () => {
        const sink = new StructuredLogFileSink({ maxFileBytes: 20 });
        sink.initialize(dir);

        sink.append("x".repeat(30));
        const firstPath = sink.currentFilePath;
        assert.ok(firstPath, "initialize must establish a current file");
        assert.strictEqual(statSync(firstPath).size, 31, "line plus newline is persisted");

        sink.append("y");
        const secondPath = sink.currentFilePath;
        assert.ok(secondPath);
        assert.notStrictEqual(secondPath, firstPath, "exceeding the cap must roll to a new file");
        assert.strictEqual(readdirSync(join(dir, "structured-logs")).length, 2);
    });

    test("pruneExpiredFiles removes files older than the retention window", () => {
        const sink = new StructuredLogFileSink();
        sink.initialize(dir);
        // Materialize the current daily file; it is created lazily on first append.
        sink.append('{"seed":true}');

        const logsDir = join(dir, "structured-logs");
        const stale = join(logsDir, "structured-20000101.jsonl");
        writeFileSync(stale, "old");
        const ancient = new Date(Date.now() - 90 * 24 * 3_600_000);
        utimesSync(stale, ancient, ancient);

        const fresh = sink.currentFilePath;
        assert.ok(fresh);

        // A second initialize (extension restart) prunes the expired file.
        const sink2 = new StructuredLogFileSink();
        sink2.initialize(dir);

        assert.strictEqual(existsSync(stale), false, "expired file must be deleted");
        assert.strictEqual(existsSync(fresh), true, "current file must be retained");
    });

    test("enforces the total cap at startup and never deletes the active file", () => {
        const dayKey = new Date().toISOString().slice(0, 10);
        const todayFile = join(dir, "structured-logs", `structured-${dayKey}.jsonl`);
        mkdirSync(join(dir, "structured-logs"), { recursive: true });
        writeFileSync(todayFile, "t".repeat(20));
        // Make the active file the oldest in the folder, so a cap pass reaches it
        // before the files it must delete.
        const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
        utimesSync(todayFile, longAgo, longAgo);
        const newer = join(dir, "structured-logs", "structured-20000102.jsonl");
        writeFileSync(newer, "n".repeat(20));
        const recently = new Date(Date.now() - 5 * 24 * 3_600_000);
        utimesSync(newer, recently, recently);

        const sink = new StructuredLogFileSink({ maxTotalBytes: 30 });
        sink.initialize(dir);

        assert.strictEqual(existsSync(todayFile), true, "the active file is never deleted");
        assert.strictEqual(existsSync(newer), false, "the over-cap file is deleted at startup");
    });
    test("counts a multi-byte line in bytes when enforcing the size cap", () => {
        // 10 three-byte characters are 30 bytes but only 10 UTF-16 units, so a
        // UTF-16 count would leave the cap of 20 unenforced.
        const sink = new StructuredLogFileSink({ maxFileBytes: 20 });
        sink.initialize(dir);
        const firstPath = sink.currentFilePath;
        assert.ok(firstPath);

        sink.append("あ".repeat(10));
        sink.append("next");

        assert.strictEqual(statSync(firstPath).size, 31, "the line is written as 30 bytes plus a newline");
        assert.notStrictEqual(sink.currentFilePath, firstPath, "the byte cap rolls the file");
    });

    test("deletes the oldest files at rollover once the total cap is exceeded", () => {
        // The per-file cap of 1 byte makes the second append roll, which is when
        // the total cap is enforced.
        const sink = new StructuredLogFileSink({ maxFileBytes: 1, maxTotalBytes: 25 });
        sink.initialize(dir);
        const logsDir = join(dir, "structured-logs");

        // Two pre-existing files, oldest first by mtime, 20 bytes each.
        const older = join(logsDir, "structured-20000101.jsonl");
        const newer = join(logsDir, "structured-20000102.jsonl");
        writeFileSync(older, "a".repeat(20));
        writeFileSync(newer, "b".repeat(20));
        const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
        utimesSync(older, longAgo, longAgo);
        const recently = new Date(Date.now() - 5 * 24 * 3_600_000);
        utimesSync(newer, recently, recently);

        sink.append("seed");
        sink.append("x".repeat(20));
        const active = sink.currentFilePath;
        assert.ok(active);

        assert.strictEqual(existsSync(older), false, "the oldest file is deleted first");
        assert.strictEqual(existsSync(newer), true, "the cap pass stops once the total fits");
        assert.strictEqual(existsSync(active), true, "the active file is never deleted");
    });
});
