import { sha256HexAsync } from "../../utils/discoveryHash";

/**
 * Hashes the API key for use in internal keys. Only the first 8 characters of
 * the SHA-256 digest are used, so the raw key is never logged or persisted.
 */
async function hashApiKeySuffixAsync(apiKey: string | undefined): Promise<string> {
    return apiKey ? (await sha256HexAsync(apiKey)).slice(0, 8) : "anonymous";
}

/**
 * Identity of one configured provider group: its server URL plus a suffix of a
 * hash of its API key.
 *
 * The same value keys the discovery response cache and the per-backend model
 * list, so groups that differ in URL, scheme, or API key never share a cache
 * entry. The scheme is kept as written because `http` and `https` may be
 * different servers.
 */
export async function toBackendIdentityKey(baseUrl: string, apiKey: string | undefined): Promise<string> {
    return `${baseUrl.replace(/\/+$/, "")}#${await hashApiKeySuffixAsync(apiKey)}`;
}
