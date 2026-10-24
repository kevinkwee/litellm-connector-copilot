/**
 * # Caps enforcement for `.copilotmd` exports
 *
 * Pure functions that pick the files to delete so the export folder honors
 * the three user-configured caps. `0` disables a cap.
 *
 * 1. `maxFilesPerSession`: the oldest files of a session folder beyond this
 *    count. Only that session is trimmed.
 * 2. `maxSessions`: whole session folders beyond this count, oldest first
 *    by newest-file mtime.
 * 3. `maxTotalBytes`: once the total exceeds the cap, whole session folders,
 *    oldest first by newest-file mtime, until the total falls to
 *    {@link TOTAL_BYTES_LOW_WATER_RATIO} of the cap or only the written
 *    session is left.
 *
 * The byte cap deletes whole sessions so an old transcript is either kept
 * complete or removed, never stripped of its opening turns. Deleting a file
 * also updates its folder's modified time, so trimming files out of an old
 * session would make it look recently active. The margin below the cap
 * keeps later exports from triggering another deletion.
 *
 * The byte cap evicts every other session before the one being written. If
 * that session alone still exceeds the cap, its oldest files are deleted
 * until the total fits, which removes the file just written when that file
 * alone exceeds the cap. When the written session alone is above the
 * low-water mark, the mark is out of reach, so one over-cap export evicts
 * every other session.
 *
 * Kept apart from `copilotMdWriter.ts` so the selection logic is
 * unit-testable without touching the filesystem.
 */

export interface FileMeta {
    /** URI of the file, used by the writer to actually delete it. */
    readonly uri: string;
    /** File mtime in milliseconds since epoch. */
    readonly mtimeMs: number;
    /** File size in bytes. */
    readonly sizeBytes: number;
    /** Session id (folder name) the file belongs to. */
    readonly sessionId: string;
}

export interface CapsConfig {
    readonly maxFilesPerSession: number;
    readonly maxSessions: number;
    readonly maxTotalBytes: number;
}

/** Fraction of `maxTotalBytes` at which whole-session eviction stops. */
const TOTAL_BYTES_LOW_WATER_RATIO = 0.8;

/**
 * Returns the files to delete so the remaining set honors every cap.
 *
 * The caps run in order (per-session, session count, total bytes), each on
 * the files the previous ones kept, so no file is selected twice.
 *
 * @param writtenSessionId the session of the file just exported, which the
 *   byte cap evicts only after every other session.
 */
export function selectFilesForDeletion(
    files: readonly FileMeta[],
    caps: CapsConfig,
    writtenSessionId: string
): FileMeta[] {
    const toDelete = new Map<string, FileMeta>();
    const markForDeletion = (selected: readonly FileMeta[]): void => {
        for (const file of selected) {
            toDelete.set(file.uri, file);
        }
    };
    const keptFiles = (): FileMeta[] => files.filter((file) => !toDelete.has(file.uri));

    if (caps.maxFilesPerSession > 0) {
        markForDeletion(selectPerSessionOverflow(keptFiles(), caps.maxFilesPerSession));
    }
    if (caps.maxSessions > 0) {
        markForDeletion(selectSessionCountOverflow(keptFiles(), caps.maxSessions));
    }
    if (caps.maxTotalBytes > 0) {
        markForDeletion(selectTotalBytesOverflow(keptFiles(), caps.maxTotalBytes, writtenSessionId));
    }

    return [...toDelete.values()];
}

function selectPerSessionOverflow(files: readonly FileMeta[], maxFilesPerSession: number): FileMeta[] {
    const overflow: FileMeta[] = [];
    for (const sessionFiles of groupBySession(files).values()) {
        if (sessionFiles.length <= maxFilesPerSession) {
            continue;
        }
        const oldestFirst = [...sessionFiles].sort(byMtimeAsc);
        overflow.push(...oldestFirst.slice(0, sessionFiles.length - maxFilesPerSession));
    }
    return overflow;
}

function selectSessionCountOverflow(files: readonly FileMeta[], maxSessions: number): FileMeta[] {
    const newestSessionsFirst = [...groupBySession(files).values()].sort((a, b) => newestMtime(b) - newestMtime(a));
    return newestSessionsFirst.slice(maxSessions).flat();
}

function selectTotalBytesOverflow(
    files: readonly FileMeta[],
    maxTotalBytes: number,
    writtenSessionId: string
): FileMeta[] {
    let totalBytes = sumSizes(files);
    if (totalBytes <= maxTotalBytes) {
        return [];
    }

    const lowWaterBytes = Math.floor(maxTotalBytes * TOTAL_BYTES_LOW_WATER_RATIO);
    const sessions = groupBySession(files);
    const otherSessionsOldestFirst = [...sessions.entries()]
        .filter(([sessionId]) => sessionId !== writtenSessionId)
        .map(([, sessionFiles]) => sessionFiles)
        .sort((a, b) => newestMtime(a) - newestMtime(b));

    const overflow: FileMeta[] = [];
    for (const sessionFiles of otherSessionsOldestFirst) {
        if (totalBytes <= lowWaterBytes) {
            return overflow;
        }
        overflow.push(...sessionFiles);
        totalBytes -= sumSizes(sessionFiles);
    }

    // Every other session is gone. The written session is trimmed to the cap
    // rather than the low-water mark, so the file just written, normally its
    // newest, survives unless it alone exceeds the cap.
    const writtenOldestFirst = [...(sessions.get(writtenSessionId) ?? [])].sort(byMtimeAsc);
    for (const file of writtenOldestFirst) {
        if (totalBytes <= maxTotalBytes) {
            break;
        }
        overflow.push(file);
        totalBytes -= file.sizeBytes;
    }
    return overflow;
}

/** Groups files by session, keeping each session's first-seen order. */
function groupBySession(files: readonly FileMeta[]): Map<string, FileMeta[]> {
    const sessions = new Map<string, FileMeta[]>();
    for (const file of files) {
        const sessionFiles = sessions.get(file.sessionId);
        if (sessionFiles) {
            sessionFiles.push(file);
        } else {
            sessions.set(file.sessionId, [file]);
        }
    }
    return sessions;
}

function newestMtime(sessionFiles: readonly FileMeta[]): number {
    return sessionFiles.reduce((newest, file) => Math.max(newest, file.mtimeMs), -Infinity);
}

function sumSizes(files: readonly FileMeta[]): number {
    return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function byMtimeAsc(a: FileMeta, b: FileMeta): number {
    return a.mtimeMs - b.mtimeMs;
}
