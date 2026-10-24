import * as assert from "assert";
import { selectFilesForDeletion, type CapsConfig, type FileMeta } from "../copilotMdCaps";

/**
 * Tests for the `.copilotmd` caps enforcement selector.
 *
 * `selectFilesForDeletion` is a pure function: given the current set of
 * files, the user-configured caps, and the session just written, it returns
 * the files to delete. The writer applies the deletions.
 *
 * The three caps are enforced in order, each on the files the previous ones
 * kept:
 * 1. `maxFilesPerSession`: oldest files within each session folder.
 * 2. `maxSessions`: oldest session folders by newest-file mtime.
 * 3. `maxTotalBytes`: whole session folders, oldest by newest-file mtime,
 *    down to 80% of the cap. The written session goes last: when it alone
 *    still exceeds the cap, its oldest files are trimmed back to the cap.
 *
 * `0` for any cap means unlimited.
 */

const WRITTEN = "session-written";

function makeFile(uri: string, sessionId: string, mtimeMs: number, sizeBytes: number): FileMeta {
    return { uri, sessionId, mtimeMs, sizeBytes };
}

function bytesCap(maxTotalBytes: number): CapsConfig {
    return { maxFilesPerSession: 0, maxSessions: 0, maxTotalBytes };
}

function selectedUris(files: readonly FileMeta[], caps: CapsConfig, writtenSessionId = WRITTEN): string[] {
    return selectFilesForDeletion(files, caps, writtenSessionId)
        .map((file) => file.uri)
        .sort();
}

const UNLIMITED: CapsConfig = {
    maxFilesPerSession: 0,
    maxSessions: 0,
    maxTotalBytes: 0,
};

suite("selectFilesForDeletion", () => {
    test("returns empty list when no caps are set (all zero = unlimited)", () => {
        const files = [makeFile("file1", "session-a", 1000, 100), makeFile("file2", "session-a", 2000, 100)];
        assert.deepStrictEqual(selectedUris(files, UNLIMITED), []);
    });

    test("returns empty list when no files are over any cap", () => {
        const files = [makeFile("file1", "session-a", 1000, 100), makeFile("file2", "session-a", 2000, 100)];
        const caps: CapsConfig = { maxFilesPerSession: 5, maxSessions: 5, maxTotalBytes: 100_000 };
        assert.deepStrictEqual(selectedUris(files, caps), []);
    });

    test("returns empty list for an empty file set", () => {
        const caps: CapsConfig = { maxFilesPerSession: 1, maxSessions: 1, maxTotalBytes: 1 };
        assert.deepStrictEqual(selectedUris([], caps), []);
    });

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
        assert.deepStrictEqual(selectedUris(files, caps), ["a-old"]);
    });

    test("per-session cap does not affect other sessions when one overflows", () => {
        const files = [
            makeFile("a-old", "session-a", 1000, 100),
            makeFile("a-new", "session-a", 2000, 100),
            makeFile("b-1", "session-b", 3000, 100),
            makeFile("b-2", "session-b", 4000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 1, maxSessions: 0, maxTotalBytes: 0 };
        // session-a: keep newest (a-new), delete a-old
        // session-b: keep newest (b-2), delete b-1
        assert.deepStrictEqual(selectedUris(files, caps), ["a-old", "b-1"]);
    });

    test("per-session cap = 0 means unlimited (no per-session deletion)", () => {
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("a-2", "session-a", 2000, 100),
            makeFile("a-3", "session-a", 3000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, UNLIMITED), []);
    });

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
        assert.deepStrictEqual(selectedUris(files, caps), ["a-1", "a-2"]);
    });

    test("session-count cap = 0 means unlimited (no session deletion)", () => {
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("b-1", "session-b", 2000, 100),
            makeFile("c-1", "session-c", 3000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, UNLIMITED), []);
    });

    test("total-bytes cap deletes nothing when the total equals the cap", () => {
        const files = [makeFile("old-1", "session-old", 1000, 200), makeFile("w-1", WRITTEN, 2000, 100)];
        assert.deepStrictEqual(selectedUris(files, bytesCap(300)), []);
    });

    test("total-bytes cap evicts the oldest session when the total is one byte over", () => {
        const files = [
            makeFile("old-1", "session-old", 1000, 200),
            makeFile("mid-1", "session-mid", 2000, 1),
            makeFile("w-1", WRITTEN, 3000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(300)), ["old-1"]);
    });

    test("total-bytes cap deletes every file of an evicted session, not only its oldest", () => {
        // Deleting a-1 alone would already fit the cap; the whole session goes anyway.
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("a-2", "session-a", 2000, 100),
            makeFile("w-1", WRITTEN, 5000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(250)), ["a-1", "a-2"]);
    });

    test("total-bytes cap orders sessions by their newest file, not their oldest", () => {
        // session-a holds the oldest single file (1000) but was active more
        // recently (4000) than session-b (3000), so session-b goes first.
        const files = [
            makeFile("a-1", "session-a", 1000, 100),
            makeFile("a-2", "session-a", 4000, 100),
            makeFile("b-1", "session-b", 3000, 200),
            makeFile("w-1", WRITTEN, 5000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(450)), ["b-1"]);
    });

    test("total-bytes cap evicts sessions until the total is at 80% of the cap", () => {
        // Total 600, cap 500, low-water mark 400: two sessions go, and the
        // eviction stops exactly at the mark instead of taking a third.
        const files = [
            makeFile("s1", "session-1", 1000, 100),
            makeFile("s2", "session-2", 2000, 100),
            makeFile("s3", "session-3", 3000, 100),
            makeFile("s4", "session-4", 4000, 100),
            makeFile("s5", "session-5", 5000, 100),
            makeFile("w-1", WRITTEN, 6000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(500)), ["s1", "s2"]);
    });

    test("total-bytes cap evicts other sessions before the written one, even when it looks oldest", () => {
        const files = [makeFile("w-1", WRITTEN, 1000, 100), makeFile("other-1", "session-other", 2000, 100)];
        assert.deepStrictEqual(selectedUris(files, bytesCap(150)), ["other-1"]);
    });

    test("total-bytes cap trims the written session to the cap, not to 80%, when it is alone", () => {
        // Total 400, cap 350: one file brings it to 300, which fits the cap
        // even though it is above the 280 low-water mark.
        const files = [
            makeFile("w-1", WRITTEN, 1000, 100),
            makeFile("w-2", WRITTEN, 2000, 100),
            makeFile("w-3", WRITTEN, 3000, 100),
            makeFile("w-4", WRITTEN, 4000, 100),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(350)), ["w-1"]);
    });

    test("total-bytes cap trims the written session after evicting every other session", () => {
        const files = [
            makeFile("other-1", "session-other", 1000, 100),
            makeFile("w-1", WRITTEN, 2000, 200),
            makeFile("w-2", WRITTEN, 3000, 200),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(350)), ["other-1", "w-1"]);
    });

    test("total-bytes cap leaves the written session intact once the others fit it under the cap", () => {
        // Evicting session-other leaves 300: above the 280 low-water mark but
        // within the cap, so the written session keeps all of its files.
        const files = [
            makeFile("other-1", "session-other", 1000, 100),
            makeFile("w-1", WRITTEN, 2000, 150),
            makeFile("w-2", WRITTEN, 3000, 150),
        ];
        assert.deepStrictEqual(selectedUris(files, bytesCap(350)), ["other-1"]);
    });

    test("total-bytes cap deletes the just-written file when it alone exceeds the cap", () => {
        const files = [makeFile("w-1", WRITTEN, 1000, 500)];
        assert.deepStrictEqual(selectedUris(files, bytesCap(400)), ["w-1"]);
    });

    test("total-bytes cap protects no session when the written session has no files", () => {
        const files = [makeFile("s1", "session-1", 1000, 100), makeFile("s2", "session-2", 2000, 100)];
        assert.deepStrictEqual(selectedUris(files, bytesCap(50), "session-missing"), ["s1", "s2"]);
    });

    test("total-bytes cap = 0 means unlimited (no byte-based deletion)", () => {
        const files = [makeFile("a-1", "session-a", 1000, 1_000_000), makeFile("a-2", "session-a", 2000, 1_000_000)];
        assert.deepStrictEqual(selectedUris(files, UNLIMITED), []);
    });

    test("total-bytes cap counts only the files the per-session cap kept", () => {
        // The per-session cap drops a-1 (300 bytes), which brings the total to
        // 200 and under the 250 cap, so no session is evicted for bytes.
        const files = [
            makeFile("a-1", "session-a", 1000, 300),
            makeFile("a-2", "session-a", 2000, 100),
            makeFile("w-1", WRITTEN, 3000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 1, maxSessions: 0, maxTotalBytes: 250 };
        assert.deepStrictEqual(selectedUris(files, caps), ["a-1"]);
    });

    test("total-bytes cap counts only the sessions the session-count cap kept", () => {
        // The session-count cap drops session-big. The 240 bytes left sit
        // above the 200 low-water mark but within the 250 cap, so the byte
        // cap evicts nothing more.
        const files = [
            makeFile("big-1", "session-big", 1000, 1000),
            makeFile("a-1", "session-a", 2000, 140),
            makeFile("w-1", WRITTEN, 3000, 100),
        ];
        const caps: CapsConfig = { maxFilesPerSession: 0, maxSessions: 2, maxTotalBytes: 250 };
        assert.deepStrictEqual(selectedUris(files, caps), ["big-1"]);
    });

    test("all three caps combine: per-session first, then session-count, then bytes", () => {
        // 3 sessions × 4 files each, 1000 bytes per file.
        const files: FileMeta[] = [];
        for (let s = 0; s < 3; s++) {
            for (let f = 0; f < 4; f++) {
                files.push(makeFile(`s${s}-f${f}`, `session-${s}`, 1000 + s * 4000 + f * 1000, 1000));
            }
        }
        const caps: CapsConfig = { maxFilesPerSession: 3, maxSessions: 2, maxTotalBytes: 5000 };

        // Per-session cap of 3: the oldest file of each session goes.
        const perSessionDeleted = ["s0-f0", "s1-f0", "s2-f0"];
        // Session-count cap of 2: session-0 (newest mtime 4000) goes with its survivors.
        const sessionCountDeleted = ["s0-f1", "s0-f2", "s0-f3"];
        // Byte cap: 6000 bytes remain against 5000, so session-1 goes and
        // the written session-2 keeps 3000, under the 4000 low-water mark.
        const totalBytesDeleted = ["s1-f1", "s1-f2", "s1-f3"];
        const expectedDeleted = [...perSessionDeleted, ...sessionCountDeleted, ...totalBytesDeleted].sort();
        assert.deepStrictEqual(selectedUris(files, caps, "session-2"), expectedDeleted);
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
        // Pass 1: session-a cap=2 → delete a-1, a-2, a-3 (3 oldest). session-b under cap.
        // Pass 2: session-count=1 → keep newest session (b, newest=7000). Drop session-a (newest surviving=5000). Delete a-4, a-5.
        const expected = ["a-1", "a-2", "a-3", "a-4", "a-5"];
        assert.deepStrictEqual(selectedUris(files, caps, "session-b"), expected);
    });
});
