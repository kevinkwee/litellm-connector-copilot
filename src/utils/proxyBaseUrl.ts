const ENDPOINT_SUFFIXES = ["/chat/completions", "/completions", "/responses", "/model/info"] as const;

/**
 * Reduces a user-entered proxy URL to the base the connector appends endpoints to.
 *
 * A user pastes whatever the proxy's own docs show: with a trailing slash, with
 * a full endpoint path, or with `/v1`. Stripping the endpoint path and the
 * trailing slash keeps one spelling per proxy, so two groups on one proxy reach
 * the same backend identity and the connector does not request
 * `https://p/chat/completions/chat/completions`. A `/v1` prefix is kept, because
 * gateways commonly mount the API under it and a bare host need not serve it.
 */
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
    // A doubled slash before the stripped path leaves one behind.
    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }
    return base;
}
