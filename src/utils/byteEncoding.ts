/**
 * Byte and text conversions that work in both extension hosts.
 *
 * The browser build (`dist/web/extension.js`) has no Node `Buffer`, so binary
 * payloads are decoded and encoded with the web platform primitives that both
 * hosts provide: `TextDecoder`, `TextEncoder` and `btoa`.
 */

/**
 * Chunk size for base64 encoding, kept a multiple of 3 so every chunk but the
 * last encodes without padding and the concatenated result is one valid string.
 * 24 KiB also keeps the spread under the argument limit of `String.fromCharCode`.
 */
const BASE64_CHUNK_SIZE = 3 * 8192;

/** Decodes UTF-8 bytes into text. */
export function decodeUtf8(data: Uint8Array): string {
    return new TextDecoder().decode(data);
}

/** Encodes text as UTF-8 bytes. */
export function encodeUtf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** Encodes bytes as standard base64, chunked so a large payload cannot overflow the call stack. */
export function encodeBase64(data: Uint8Array): string {
    let encoded = "";
    for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_SIZE) {
        const chunk = data.subarray(offset, offset + BASE64_CHUNK_SIZE);
        encoded += btoa(String.fromCharCode(...chunk));
    }
    return encoded;
}
