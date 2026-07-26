import * as assert from "assert";
import { selectFilesForDeletion, type CapsConfig, type FileMeta } from "../copilotMdCaps";

/**
 * Tests for the `.copilotmd` caps enforcement selector.
 *
 * `selectFilesForDeletion` is a pure function: given the current set of
 * files and the user-configured caps, it returns the files to delete to
 * bring the set into compliance. The writer applies the deletions.
 *
 * The three caps are enforced in order:
 * 1. `maxFilesPerSession` — oldest within each session folder (NOT globally)
 * 2. `maxSessions` — oldest session folders (by newest-file mtime)
 * 3. `maxTotalBytes` — oldest files globally (by mtime)
 *
 * "Oldest" is by mtime. `0` for any cap means unlimited (no enforcement).
 */

function makeFile(
    uri: string,
    sessionFingerprint: string,
    mtimeMs: number,
    sizeBytes: number
): FileMeta {
    return { uri, sessionFingerprint, mtimeMs, sizeBytes };
}

const UNLIMITED: CapsConfig = {
    maxFilesPerSession: 0,
    maxSessions: 0,
    maxTotalBytes: 0,
};

suite("selectFilesForDeletion", () => {
    test("returns empty list when no caps are set (all zero = unlimited)", () => {
        const files = [
            makeFile("file1", "session-a", 1000, 100),
            makeFile("file2", "session-a", 2000, 100),
        ];
        assert.deepStrictEqual(selectFilesForDeletion(files, UNLIMITED), []);
    });

    test("returns empty list when no files are over any cap", () => {
        const files = [
            makeFile("file1", "session-a", 1000, 100),
            makeFile("file2", "session-a", 2000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 5, maxSessions: 5, maxTotalBytes: 100_000 };
        assert.deepStrictEqual(selectFilesForDeletion(files, caps), []);
    });

    // Pass 1: per-session cap

    test("per-session cap deletes oldest files in the overflowing session only", () => {
        // session-a has 3 files; cap is 2 → oldest 1 deleted.
        // session-b has 1 file; under cap → untouched.
        const files = [
            makeFile("a-old", "session-a", 1000, 100),
            makeFile("a-mid", "session-a", 2000, 100),
            makeFile("a-new", "session-a", 3000, 100),
            makeFile("b-1", "session-b", 5000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 2, maxSessions: 0, maxTotalBytes: 0 };
        const toDelete = selectFilesForDeletion(files, caps);
        assert.deepStrictEqual(
            toDelete.map((f) => f.uri),
            ["a-old"]
        );
    });

    test("per-session cap does not affect other sessions when one overflows", () => {
        const files = [
            makeFile("a-old", "session-a", 1000, 100),
            makeFile("a-new", "session-a", 2000, 100),
            makeFile("b-1", "session-b", 3000, 100),
            makeFile("b-2", "session-b", 4000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 1, maxSessions: 0, maxTotalBytes: 0 };
        const toDelete = selectFilesForDeletion(files, caps);
        // session-a: keep newest (a-new), delete a-old
        // session-b: keep newest (b-2), delete b-1
        assert.deepStrictEqual(
            toDelete.map((f) => f.uri).sort(),
            ["a-old", "b-1"]
        );
    });

    test("per-session cap = 0 means unlimited (no per-session deletion)", () => {
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("a-2", "session-a", 2000, 100),
            makeFile("a-3", "session-a", 3000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 0, maxSessions: 0, maxTotalBytes: 0 };
        assert.deepStrictEqual(selectFilesForDeletion(files, caps), []);
    });

    // Pass 2: session-count cap

    test("session-count cap deletes all files in the oldest dropped sessions", () => {
        // 3 sessions, cap = 2 → drop the oldest session (by newest-file mtime).
        // session-a newest = 3000 (oldest), session-b newest = 5000, session-c newest = 7000
        // → session-a dropped entirely.
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("a-2", "session-a", 3000, 100),
            makeFile("b-1", "session-b", 5000, 100),
            makeFile("c-1", "session-c", 7000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 0, maxSessions: 2, maxTotalBytes: 0 };
        const toDelete = selectFilesForDeletion(files, caps);
        assert.deepStrictEqual(
            toDelete.map((f) => f.uri).sort(),
            ["a-1", "a-2"]
        );
    });

    test("session-count cap = 0 means unlimited (no session deletion)", () => {
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("b-1", "session-b", 2000, 100),
            makeFile("c-1", "session-c", 3000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 0, maxSessions: 0, maxTotalBytes: 0 };
        assert.deepStrictEqual(selectFilesForDeletion(files, caps), []);
    });

    // Pass 3: total-bytes cap

    test("total-bytes cap deletes oldest files globally until under budget", () => {
        // Total = 100+200+300+400 = 1000; cap = 600 → delete oldest (100 + 200 = 300) → remaining 700 still over → delete next (300) → remaining 400 under.
        // Wait: 1000 - 100 = 900 (over), -200 = 700 (over), -300 = 400 (under). Delete 3 oldest.
        const files = [
            makeFile("oldest", "session-a", 1000, 100),
            makeFile("old", "session-a", 2000, 200),
            makeFile("mid", "session-b", 3000, 300),
            makeFile("newest", "session-b", 4000, 400),
        ];
        const caps: CapsConfig = {
            maxFilesPerSession: 0,
            maxSessions: 0,
            maxTotalBytes: 600,
        };
        const toDelete = selectFilesForDeletion(files, caps);
        assert.deepStrictEqual(
            toDelete.map((f) => f.uri),
            ["oldest", "old", "mid"]
        );
    });

    test("total-bytes cap = 0 means unlimited (no byte-based deletion)", () => {
        const files = [
            makeFile("a-1", "session-a", 1000, 1_000_000),
            makeFile("a-2", "session-a", 2000, 1_000_000),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 0, maxSessions: 0, maxTotalBytes: 0 };
        assert.deepStrictEqual(selectFilesForDeletion(files, caps), []);
    });

    // Combinations

    test("all three caps combine: per-session first, then session-count, then bytes", () => {
        // 3 sessions × 4 files each = 12 files, 1000 bytes each = 12000 total.
        // Caps: maxFilesPerSession=3 (delete 1 per session = 3 total), maxSessions=2 (drop oldest session = -3 more, but those are already deleted by per-session? No — per-session keeps newest 3, deletes oldest 1 per session. The dropped session's remaining 3 also get deleted.)
        const files: FileMeta[] = [];
        for (let s = 0; s < 3; s++) {
            for (let f = 0; f < 4; f++) {
                files.push(
                    makeFile(`s${s}-f${f}`, `session-${s}`, 1000 + s * 4000 + f * 1000, 1000)
                );
            }
        }
        const caps: CapsConfig = {
            maxFilesPerSession: 3,
            maxSessions: 2,
            maxTotalBytes: 100_000, // large enough not to trigger
        };
        const toDelete = selectFilesForDeletion(files, caps);

        // Pass 1: per-session cap=3 → delete oldest 1 file per session (3 files: s0-f0, s1-f0, s2-f0)
        const pass1Deleted = ["s0-f0", "s1-f0", "s2-f0"];
        // Pass 2: session-count=2 → drop the oldest session (session-0, newest mtime = 4000).
        // session-0's surviving files are s0-f1, s0-f2, s0-f3 (3 files).
        const pass2Deleted = ["s0-f1", "s0-f2", "s0-f3"];
        const expectedDeleted = [...pass1Deleted, ...pass2Deleted].sort();
        assert.deepStrictEqual(
            toDelete.map((f) => f.uri).sort(),
            expectedDeleted
        );
    });

    test("pass-1 survivors are visible to pass-2 (no double-counting)", () => {
        // session-a has 5 files; per-session cap=2 deletes 3 oldest.
        // session-count cap=1 → keep only the newest session.
        // If session-a's newest surviving file is older than session-b's newest,
        // session-a is dropped, but its 2 survivors should also be deleted.
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("a-2", "session-a", 2000, 100),
            makeFile("a-3", "session-a", 3000, 100),
            makeFile("a-4", "session-a", 4000, 100),
            makeFile("a-5", "session-a", 5000, 100),
            makeFile("b-1", "session-b", 6000, 100),
            makeFile("b-2", "session-b", 7000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 2, maxSessions: 1, maxTotalBytes: 0 };
        const toDelete = selectFilesForDeletion(files, caps);
        // Pass 1: session-a cap=2 → delete a-1, a-2, a-3 (3 oldest). session-b under cap.
        // Pass 2: session-count=1 → keep newest session (b, newest=7000). Drop session-a (newest surviving=5000). Delete a-4, a-5.
        const expected = ["a-1", "a-2", "a-3", "a-4", "a-5"].sort();
        assert.deepStrictEqual(
            toDelete.map((f) => f.uri).sort(),
            expected
        );
    });
});
