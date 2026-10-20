import * as vscode from "vscode";
import { sha1BytesAsync } from "./discoveryHash";
import { lmcr_toString } from "./mapChatRoles";

/**
 * # Chat session identity
 *
 * Every chat request is tagged with a session id that names its `.copilotmd`
 * transcript folder and becomes LiteLLM's `metadata.session_id` (which the
 * proxy promotes to `litellm_session_id`), so spend logs group per
 * conversation.
 *
 * The id comes from the host when available: VS Code forwards the originating
 * conversation id in the internal `modelOptions._conversationId` field, set by
 * Copilot Chat in editor windows and by the agent host BYOK proxy in the
 * Agents window (VS Code 1.143 and later). That field is undocumented, so it
 * is treated as untrusted input. Requests with no conversation behind them
 * (title generation, commit-message generation, other extensions calling
 * `vscode.lm`, and Agents window sessions on earlier VS Code builds) send
 * nothing, and the id falls back to a fingerprint of the opening messages.
 * The fingerprint is stable across the turns of one conversation but collides
 * when two conversations open with the same prompt, so it is not a substitute
 * for the host id.
 *
 * Every returned id is a canonical lowercase UUID. The UUID shape is also a
 * safety allowlist: because the id becomes a directory name under the
 * extension's storage, an arbitrary string could otherwise escape that
 * directory with `..` or a path separator.
 */

/** Where a resolved session id came from. Logged to diagnose grouping surprises. */
export type ChatSessionIdSource = "conversation" | "conversation-hashed" | "fingerprint";

export interface ResolvedChatSessionId {
    /** Canonical lowercase UUID. */
    readonly id: string;
    readonly source: ChatSessionIdSource;
}

/** Internal VS Code model option carrying the originating conversation id. */
const CONVERSATION_ID_MODEL_OPTION = "_conversationId";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Names the UUID v5 hash space for hashed conversation ids. The prefix keeps
 * a hashed host id from colliding with a fallback fingerprint of the same
 * text.
 */
const CONVERSATION_SEED_PREFIX = "conversation:";

/**
 * Resolves the session id for a chat request.
 *
 * A host id that is already a canonical UUID is returned lowercased, so
 * LiteLLM spend rows match the id VS Code uses for that session. Any other
 * host id, and the message fingerprint used when no host id is present, is
 * hashed into this connector's UUID v5 namespace.
 *
 * @param messages the request messages, used only when the host sends no
 *   conversation id.
 * @param modelOptions the request's `options.modelOptions`.
 */
export async function resolveChatSessionId(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    modelOptions: Readonly<Record<string, unknown>> | undefined
): Promise<ResolvedChatSessionId> {
    const conversationId = readConversationId(modelOptions);
    if (conversationId !== undefined) {
        const canonical = conversationId.toLowerCase();
        if (CANONICAL_UUID_PATTERN.test(canonical)) {
            return { id: canonical, source: "conversation" };
        }
        return {
            id: await uuidFromSeed(`${CONVERSATION_SEED_PREFIX}${conversationId}`),
            source: "conversation-hashed",
        };
    }

    return { id: await uuidFromSeed(pickFingerprintSeed(messages)), source: "fingerprint" };
}

/**
 * Reads the host-provided conversation id. Returns `undefined` for a missing,
 * empty, whitespace-only, or non-string value, so a malformed field falls back
 * to the message fingerprint instead of poisoning the session grouping.
 */
function readConversationId(modelOptions: Readonly<Record<string, unknown>> | undefined): string | undefined {
    const raw = modelOptions?.[CONVERSATION_ID_MODEL_OPTION];
    if (typeof raw !== "string") {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Picks the string to hash for the fallback fingerprint.
 *
 * The window is: the text of every `User`-role message that precedes the
 * first `Assistant` message. `System` messages are skipped wherever they
 * appear, because agent instructions are identical across sessions in the
 * same mode and add no discriminating power. Each message contributes
 * `user:<text>`, and the chunks are joined with `\n`.
 *
 * ## Why this window
 *
 * A typical Copilot Chat request's `messages` array looks like:
 *
 * ```
 * [0] System    ← agent instructions (identical across every session in the same mode)
 * [1] User      ← environment_info, workspace_info, userMemory (identical across every session in the same workspace)
 * [2] User      ← the actual user request (this is what differentiates sessions)
 * [3] Assistant ← first response (with tool call)
 * [4] Tool      ← tool result
 * [5] User      ← follow-up
 * ```
 *
 * Hashing only the first user message (`[1]`) would collapse every session in
 * the same workspace into one folder. The window captures `[1]` and `[2]`, so
 * the fingerprint includes both the workspace context and the first real
 * request.
 *
 * The window is **exclusive** of the first assistant message: including it
 * would make turn 1 (no assistant yet) and turn 2 (assistant present) hash
 * differently, splitting one conversation across two folders.
 *
 * ## Degenerate cases
 *
 * - No user message in the window (e.g. a tool-calling sub-turn seeded only
 *   with system + assistant + tool messages): falls back to hashing the first
 *   message's role + text content so the request still gets a deterministic
 *   home. Two such sub-turns with identical first messages collide.
 * - Empty message array: returns a fixed fingerprint (`empty:` → hash) so the
 *   caller always has a folder to write to.
 */
function pickFingerprintSeed(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const userChunks: string[] = [];
    for (const msg of messages) {
        if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
            // First assistant message ends the window; later messages belong to
            // subsequent turns and would destabilize the fingerprint.
            break;
        }
        if (msg.role === vscode.LanguageModelChatMessageRole.User) {
            userChunks.push(`user:${extractTextContent(msg.content)}`);
        }
    }

    if (userChunks.length > 0) {
        return userChunks.join("\n");
    }

    const first = messages[0];
    if (!first) {
        return "empty:";
    }
    return `${lmcr_toString(first.role)}:${extractTextContent(first.content)}`;
}

/**
 * Concatenates all `LanguageModelTextPart` text from a message's content array.
 * Non-text parts (tool calls, tool results, data) are skipped because they
 * vary across turns and would destabilize the fingerprint.
 */
function extractTextContent(content: readonly unknown[]): string {
    if (!Array.isArray(content)) {
        return "";
    }
    const chunks: string[] = [];
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            chunks.push(part.value);
        }
    }
    return chunks.join("\n");
}

/**
 * Fixed namespace UUID for the LiteLLM connector's session ids.
 *
 * UUID v5 (RFC 4122 / RFC 9562) derives a deterministic UUID from
 * (namespace UUID, name) via SHA-1. The namespace acts as a salt so our ids do
 * not collide with anyone else's v5 UUIDs derived from the same name strings.
 * A generated UUID v4, hardcoded as the connector's permanent namespace.
 * Reproduce any id in Python with:
 *   `uuid.uuid5(uuid.UUID("a4c0a0d3-7d8e-4f6b-b5e1-2c1f9a8b7d6e"), name)`
 */
const LITELLM_CONNECTOR_NAMESPACE_UUID = "a4c0a0d3-7d8e-4f6b-b5e1-2c1f9a8b7d6e";

/**
 * Derives a deterministic **UUID v5** (RFC 4122) from a seed string.
 *
 * UUID v5 is the standards-compliant "name-based UUID with SHA-1": given the
 * same namespace UUID and the same name, every implementation produces the
 * byte-identical UUID, which lets a Python spend-log query derive the same id
 * without TS-specific logic.
 *
 * ## Algorithm (RFC 4122 §4.3)
 * 1. Concatenate the 16-byte namespace UUID + the UTF-8 name bytes.
 * 2. SHA-1 the concatenation → 20-byte digest.
 * 3. Take the first 16 bytes.
 * 4. Set the version bits: byte[6] high nibble = 5 → `(b6 & 0x0f) | 0x50`.
 * 5. Set the variant bits: byte[8] high bits = 10xx → `(b8 & 0x3f) | 0x80`.
 * 6. Format as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (lowercase hex).
 *
 * ## Why SHA-1 is fine here
 * SHA-1's known collision breaks (SHAttered, 2017) are chosen-prefix
 * collision attacks. They do NOT let an attacker (a) predict a UUID from a
 * name, (b) invert a UUID to recover the name, or (c) find a second name
 * matching a target UUID. RFC 9562 still recommends v5 over v3 for new code
 * precisely because that collision break does not matter for content
 * addressing.
 */
async function uuidFromSeed(seed: string): Promise<string> {
    const namespaceBytes = uuidStringToBytes(LITELLM_CONNECTOR_NAMESPACE_UUID);
    const nameBytes = new TextEncoder().encode(seed);
    const concat = new Uint8Array(namespaceBytes.length + nameBytes.length);
    concat.set(namespaceBytes, 0);
    concat.set(nameBytes, namespaceBytes.length);

    const digest = await sha1BytesAsync(concat);
    const uuidBytes = digest.slice(0, 16);
    uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
    uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
    return bytesToUuidString(uuidBytes);
}

/**
 * Parses a UUID string (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) into 16 bytes.
 * Throws on malformed input — the only caller passes a hardcoded constant, so
 * a malformed value is a programming error caught by the first call.
 */
function uuidStringToBytes(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, "");
    if (!CANONICAL_UUID_PATTERN.test(uuid.toLowerCase())) {
        throw new Error(`Invalid UUID string: ${uuid}`);
    }
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Formats 16 raw bytes as a UUID string (`8-4-4-4-12` lowercase hex). */
function bytesToUuidString(bytes: Uint8Array): string {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
