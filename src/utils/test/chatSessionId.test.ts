import * as assert from "assert";
import * as vscode from "vscode";
import { resolveChatSessionId } from "../chatSessionId";

/**
 * Tests for chat session id resolution.
 *
 * Two contracts are locked in here:
 * - A host-provided `_conversationId` always wins, so two conversations that
 *   open with the same prompt get different ids.
 * - Every resolved id is a canonical lowercase UUID, because the id names a
 *   directory under the extension's storage and is sent to LiteLLM as an
 *   opaque string.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Reference UUIDs from Python's `uuid.uuid5(namespace, name)` with
// namespace `a4c0a0d3-7d8e-4f6b-b5e1-2c1f9a8b7d6e`. They pin RFC 4122
// conformance: a Latin1 round-trip or any other re-encoding of the namespace
// bytes would produce different values, so these vectors fail loudly if the
// hash input ever stops being `namespace bytes || utf8(name)`.
const PYTHON_UUID5_USER_HI = "caf59339-a358-54fe-9771-59f7137e25c7"; // "user:hi"
const PYTHON_UUID5_CONVERSATION_SESSION_7 = "f559bfcb-c68a-5396-aff9-da6c2864be24"; // "conversation:session-7"
const PYTHON_UUID5_EMPTY = "708da911-9531-57c5-8b12-c8f0d1f6fbea"; // "empty:"

// `LanguageModelChatMessageRole.System` is part of the `languageModelSystem`
// proposed API; the stable enum only declares User(1) and Assistant(2).
const SystemRole = 3 as unknown as vscode.LanguageModelChatMessageRole;

function userMessage(text: string): vscode.LanguageModelChatRequestMessage {
    return {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart(text)],
    };
}

function assistantMessage(text: string): vscode.LanguageModelChatRequestMessage {
    return {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [new vscode.LanguageModelTextPart(text)],
    };
}

function systemMessage(text: string): vscode.LanguageModelChatRequestMessage {
    return {
        role: SystemRole,
        name: undefined,
        content: [new vscode.LanguageModelTextPart(text)],
    };
}

function withConversationId(conversationId: unknown): Record<string, unknown> {
    return { _conversationId: conversationId };
}

suite("resolveChatSessionId", () => {
    suite("host-provided conversation id", () => {
        test("passes a canonical UUID through unchanged", async () => {
            const hostId = "3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11";
            const resolved = await resolveChatSessionId([userMessage("hi")], withConversationId(hostId));
            assert.strictEqual(resolved.id, hostId);
            assert.strictEqual(resolved.source, "conversation");
        });

        test("lowercases an uppercase UUID", async () => {
            const resolved = await resolveChatSessionId(
                [userMessage("hi")],
                withConversationId("3F8A2C94-1B7D-4E05-9C62-8D1F4A7B2E11")
            );
            assert.strictEqual(resolved.id, "3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11");
        });

        test("returns the same id for different messages in one conversation", async () => {
            const hostId = "3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11";
            const firstTurn = await resolveChatSessionId(
                [userMessage("explain recursion")],
                withConversationId(hostId)
            );
            const secondTurn = await resolveChatSessionId(
                [userMessage("explain recursion"), assistantMessage("recursion is..."), userMessage("more")],
                withConversationId(hostId)
            );
            assert.strictEqual(firstTurn.id, secondTurn.id);
        });

        test("returns different ids for two conversations that open with the same prompt", async () => {
            // The collision the message fingerprint cannot avoid: identical
            // opening messages must not merge two host conversations.
            const messages = [userMessage("what is the content of result?")];
            const conversationA = await resolveChatSessionId(
                messages,
                withConversationId("aaaaaaaa-1111-4111-8111-111111111111")
            );
            const conversationB = await resolveChatSessionId(
                messages,
                withConversationId("bbbbbbbb-2222-4222-8222-222222222222")
            );
            assert.notStrictEqual(conversationA.id, conversationB.id);
        });

        test("hashes a non-UUID host id into a canonical UUID", async () => {
            const resolved = await resolveChatSessionId(
                [userMessage("hi")],
                withConversationId("agent-host/session 7")
            );
            assert.match(resolved.id, UUID_PATTERN);
            assert.strictEqual(resolved.source, "conversation-hashed");
        });

        test("matches Python's uuid5 for a hashed host id", async () => {
            const resolved = await resolveChatSessionId([], withConversationId("session-7"));
            assert.strictEqual(resolved.id, PYTHON_UUID5_CONVERSATION_SESSION_7);
        });

        test("hashes the same non-UUID host id to the same UUID", async () => {
            const first = await resolveChatSessionId([userMessage("hi")], withConversationId("session-7"));
            const second = await resolveChatSessionId([userMessage("different")], withConversationId("session-7"));
            assert.strictEqual(first.id, second.id);
        });

        test("hashes different non-UUID host ids to different UUIDs", async () => {
            const first = await resolveChatSessionId([userMessage("hi")], withConversationId("session-7"));
            const second = await resolveChatSessionId([userMessage("hi")], withConversationId("session-8"));
            assert.notStrictEqual(first.id, second.id);
        });

        test("neutralizes path traversal in a host id", async () => {
            // The id names a directory under the extension's storage, so a raw
            // `../` must never reach the filesystem layer.
            const resolved = await resolveChatSessionId([userMessage("hi")], withConversationId("../../secrets"));
            assert.match(resolved.id, UUID_PATTERN);
        });

        test("treats a whitespace-only host id as absent", async () => {
            const resolved = await resolveChatSessionId([userMessage("hi")], withConversationId("   "));
            assert.strictEqual(resolved.source, "fingerprint");
        });

        test("treats an empty host id as absent", async () => {
            const resolved = await resolveChatSessionId([userMessage("hi")], withConversationId(""));
            assert.strictEqual(resolved.source, "fingerprint");
        });

        test("treats a non-string host id as absent", async () => {
            const resolved = await resolveChatSessionId([userMessage("hi")], withConversationId(42));
            assert.strictEqual(resolved.source, "fingerprint");
        });

        test("treats a null host id as absent", async () => {
            const resolved = await resolveChatSessionId([userMessage("hi")], withConversationId(null));
            assert.strictEqual(resolved.source, "fingerprint");
        });

        test("trims a whitespace-padded UUID", async () => {
            const resolved = await resolveChatSessionId(
                [userMessage("hi")],
                withConversationId("  3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11  ")
            );
            assert.strictEqual(resolved.id, "3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11");
        });

        test("does not collide with the fingerprint of the same messages", async () => {
            // Hash-space separation: a host id equal to a fingerprint seed must
            // not reproduce that fingerprint's UUID.
            const messages = [userMessage("hi")];
            const fallback = await resolveChatSessionId(messages, undefined);
            const hashed = await resolveChatSessionId(messages, withConversationId("user:hi"));
            assert.notStrictEqual(hashed.id, fallback.id);
        });
    });

    suite("message fingerprint fallback", () => {
        test("returns a stable UUID when no host id is present", async () => {
            const messages = [userMessage("what is the content of result?")];
            const first = await resolveChatSessionId(messages, undefined);
            const second = await resolveChatSessionId(messages, undefined);
            assert.strictEqual(first.id, second.id);
            assert.match(first.id, UUID_PATTERN);
            assert.strictEqual(first.source, "fingerprint");
        });

        test("matches Python's uuid5 for the same seed", async () => {
            const resolved = await resolveChatSessionId([userMessage("hi")], undefined);
            assert.strictEqual(resolved.id, PYTHON_UUID5_USER_HI);
        });

        test("matches Python's uuid5 for an empty conversation", async () => {
            const resolved = await resolveChatSessionId([], undefined);
            assert.strictEqual(resolved.id, PYTHON_UUID5_EMPTY);
        });

        test("returns different ids for different user requests", async () => {
            const first = await resolveChatSessionId([userMessage("question A")], undefined);
            const second = await resolveChatSessionId([userMessage("question B")], undefined);
            assert.notStrictEqual(first.id, second.id);
        });

        test("skips leading System messages", async () => {
            const opened = (request: string) => [
                systemMessage("You are an expert AI programming assistant."),
                userMessage(request),
            ];
            const first = await resolveChatSessionId(opened("request A"), undefined);
            const second = await resolveChatSessionId(opened("request B"), undefined);
            assert.notStrictEqual(first.id, second.id, "same system message + different request must NOT collide");
        });

        test("differentiates sessions with the same workspace context but different first request", async () => {
            const opened = (request: string) => [
                systemMessage("system prompt"),
                userMessage("<environment_info>OS: Windows</environment_info>"),
                userMessage(request),
            ];
            const first = await resolveChatSessionId(opened("explain recursion"), undefined);
            const second = await resolveChatSessionId(opened("fix the failing test"), undefined);
            assert.notStrictEqual(first.id, second.id, "same workspace context + different request must NOT collide");
        });

        test("stays stable when later turns append assistant and follow-up messages", async () => {
            const turn1 = [userMessage("explain recursion")];
            const turn2 = [
                userMessage("explain recursion"),
                assistantMessage("recursion is..."),
                userMessage("and the tool message?"),
            ];
            const first = await resolveChatSessionId(turn1, undefined);
            const second = await resolveChatSessionId(turn2, undefined);
            assert.strictEqual(first.id, second.id);
        });

        test("window is exclusive of the first assistant message", async () => {
            const turn1 = [systemMessage("system"), userMessage("env"), userMessage("request")];
            const turn2 = [...turn1, assistantMessage("here is the answer"), userMessage("follow-up question")];
            const first = await resolveChatSessionId(turn1, undefined);
            const second = await resolveChatSessionId(turn2, undefined);
            assert.strictEqual(first.id, second.id);
        });

        test("falls back to the first message when no user message precedes the first assistant", async () => {
            const messages = [assistantMessage("calling tool")];
            const first = await resolveChatSessionId(messages, undefined);
            const second = await resolveChatSessionId(messages, undefined);
            assert.match(first.id, UUID_PATTERN);
            assert.strictEqual(first.id, second.id);
        });

        test("returns a stable id for an empty message array", async () => {
            const first = await resolveChatSessionId([], undefined);
            const second = await resolveChatSessionId([], undefined);
            assert.match(first.id, UUID_PATTERN);
            assert.strictEqual(first.id, second.id);
        });
    });
});
