/**
 * Web-compatible SHA-256 hash using SubtleCrypto. Works in Node.js (19+) and in
 * browser and web extension environments, where the Node `crypto` module does not
 * exist.
 */
export async function sha256HexAsync(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Web-compatible SHA-1 hash returning raw bytes, using SubtleCrypto.
 *
 * Accepts a string (hashed as UTF-8) or raw bytes. UUID v5 must feed raw
 * bytes: RFC 4122 hashes `namespace bytes || utf8(name)`, and round-tripping
 * those bytes through a string would re-encode every byte >= 0x80. The byte
 * parameter is pinned to `ArrayBuffer` because Web Crypto rejects
 * `SharedArrayBuffer`-backed views.
 *
 * The raw bytes (not hex) are returned because UUID v5 manipulates individual
 * bytes to set the version and variant bits before formatting.
 */
export async function sha1BytesAsync(input: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-1", data);
    return new Uint8Array(hashBuffer);
}
