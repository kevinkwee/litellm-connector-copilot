import * as assert from "assert";
import {
    existsSync,
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
});
