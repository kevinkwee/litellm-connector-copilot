/**
 * Reduces a user-entered proxy URL to the base the connector appends endpoints to.
 *
 * A user pastes whatever the proxy's own docs show: with a trailing slash, with
 * `/v1`, or with a full endpoint path. Every one of them must reach the same
 * backend identity, or two groups on one proxy look like two backends and the
 * connector requests `https://p/chat/completions/chat/completions`.
 */
const ENDPOINT_SUFFIXES = ["/chat/completions", "/completions", "/responses", "/model/info"] as const;

/** Strips one trailing endpoint path and any trailing slash, keeping a `/v1` prefix. */
export function normalizeProxyBaseUrl(raw: string): string {
    let base = raw.trim();
    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }
    const lower = base.toLowerCase();
    for (const suffix of ENDPOINT_SUFFIXES) {
        if (lower.endsWith(suffix)) {
            base = base.slice(0, base.length - suffix.length);
            break;
        }
    }
    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }
    return base;
}
