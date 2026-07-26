/**
 * # Caps enforcement for `.copilotmd` exports
 *
 * Pure functions for deciding which files/folders to delete to honor the
 * three user-configured caps:
 *
 * 1. `maxFilesPerSession` — oldest files in a single session folder beyond
 *    this count are deleted. `0` = unlimited.
 * 2. `maxSessions` — oldest session folders (by newest-file mtime) beyond
 *    this count are deleted. `0` = unlimited.
 * 3. `maxTotalBytes` — oldest files across all sessions (by mtime) beyond
 *    this total size are deleted. `0` = unlimited.
 *
 * "Oldest" is determined by file mtime. Per-session and per-session-folder
 * sweeps delete the oldest *within that scope*, never globally — confirmed
 * with the user: per-session cap deletes oldest in that session, not across
 * all sessions.
 *
 * Split out from `copilotMdWriter.ts` so the selection logic is unit-testable
 * without touching the filesystem.
 */

export interface FileMeta {
    /** URI of the file, used by the writer to actually delete it. */
    uri: string;
    /** File mtime in milliseconds since epoch. */
    mtimeMs: number;
    /** File size in bytes. */
    sizeBytes: number;
    /** Session fingerprint (folder name) the file belongs to. */
    sessionFingerprint: string;
}

export interface CapsConfig {
    maxFilesPerSession: number;
    maxSessions: number;
    maxTotalBytes: number;
}

/**
 * Returns the set of files to delete to bring the current file set into
 * compliance with all three caps. The writer applies the deletions.
 *
 * Order of enforcement matters: per-session cap first (cheapest, walks one
 * folder), then session-count cap (walks all session folders), then total-
 * bytes cap (walks all files). Each pass operates on the survivors of the
 * previous one so we never re-delete.
 */
export function selectFilesForDeletion(files: FileMeta[], caps: CapsConfig): FileMeta[] {
    const toDelete = new Map<string, FileMeta>();

    // Pass 1: per-session cap
    // Group survivors by session, then within each session sort by mtime asc
    // and mark the oldest beyond the cap for deletion.
    if (caps.maxFilesPerSession > 0) {
        const bySession = new Map<string, FileMeta[]>();
        for (const f of files) {
            if (toDelete.has(f.uri)) {continue;}
            const bucket = bySession.get(f.sessionFingerprint) ?? [];
            bucket.push(f);
            bySession.set(f.sessionFingerprint, bucket);
        }
        for (const bucket of bySession.values()) {
            if (bucket.length <= caps.maxFilesPerSession) {continue;}
            // Sort oldest first; delete the leading overflow.
            bucket.sort(byMtimeAsc);
            const overflow = bucket.length - caps.maxFilesPerSession;
            for (let i = 0; i < overflow; i++) {
                toDelete.set(bucket[i].uri, bucket[i]);
            }
        }
    }

    // Pass 2: session-count cap
    // Order sessions by their newest surviving file's mtime (desc), keep the
    // top `maxSessions`, mark every surviving file in the dropped sessions
    // for deletion.
    if (caps.maxSessions > 0) {
        const sessionNewestMtime = new Map<string, number>();
        for (const f of files) {
            if (toDelete.has(f.uri)) {continue;}
            const current = sessionNewestMtime.get(f.sessionFingerprint) ?? -Infinity;
            if (f.mtimeMs > current) {
                sessionNewestMtime.set(f.sessionFingerprint, f.mtimeMs);
            }
        }
        const sortedSessions = [...sessionNewestMtime.entries()].sort((a, b) => b[1] - a[1]);
        if (sortedSessions.length > caps.maxSessions) {
            const dropped = new Set(
                sortedSessions.slice(caps.maxSessions).map(([fp]) => fp)
            );
            for (const f of files) {
                if (toDelete.has(f.uri)) {continue;}
                if (dropped.has(f.sessionFingerprint)) {
                    toDelete.set(f.uri, f);
                }
            }
        }
    }

    // Pass 3: total-bytes cap
    // Sum sizes of all surviving files; if over budget, delete oldest-first
    // (across all sessions) until under.
    if (caps.maxTotalBytes > 0) {
        const survivors = files.filter((f) => !toDelete.has(f.uri));
        const totalBytes = survivors.reduce((sum, f) => sum + f.sizeBytes, 0);
        if (totalBytes > caps.maxTotalBytes) {
            survivors.sort(byMtimeAsc);
            let remaining = totalBytes;
            for (const f of survivors) {
                if (remaining <= caps.maxTotalBytes) {break;}
                toDelete.set(f.uri, f);
                remaining -= f.sizeBytes;
            }
        }
    }

    return [...toDelete.values()];
}

function byMtimeAsc(a: FileMeta, b: FileMeta): number {
    return a.mtimeMs - b.mtimeMs;
}
