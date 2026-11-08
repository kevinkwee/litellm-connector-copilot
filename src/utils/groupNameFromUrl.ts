/**
 * Derives a human-readable group name from a URL by returning the hostname and
 * non-default port (if present). Returns an empty string for invalid or empty
 * input so callers can fall back to other heuristics.
 */
export function deriveGroupNameFromUrl(url: string): string {
    if (typeof url !== "string" || url.length === 0) {
        return "";
    }
    try {
        const parsed = new URL(url);
        const isDefaultPort =
            (parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443")) ||
            (parsed.protocol === "http:" && (parsed.port === "" || parsed.port === "80"));
        return parsed.hostname + (parsed.port && !isDefaultPort ? `:${parsed.port}` : "");
    } catch {
        return "";
    }
}
