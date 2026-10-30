import { LiteLLMDiscoveryError } from "../../adapters/litellmClient";

/**
 * Returns a short, log-safe reason for a failed discovery refresh.
 */
export function describeDiscoveryFailure(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const singleLine = message.replace(/\s+/g, " ").trim();
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

/**
 * Statuses that mean this group is misconfigured rather than the endpoint
 * being unhealthy. Serving the last known list for one of them would hide the
 * problem behind a warning icon, so discovery returns an empty list instead.
 */
const NON_TRANSIENT_DISCOVERY_STATUS = new Set([400, 401, 403, 404]);

export function isTransientDiscoveryFailure(err: unknown): boolean {
    return !(err instanceof LiteLLMDiscoveryError && NON_TRANSIENT_DISCOVERY_STATUS.has(err.status));
}
