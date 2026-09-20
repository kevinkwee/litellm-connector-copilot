import * as assert from "assert";
import * as vscode from "vscode";

import {
    StreamedTextAccumulator,
    ReasoningOnlyError,
    InactivityTimeoutError,
    isTransportRetriableError,
    backoffDelayMs,
    buildResumeMessages,
    sleepWithCancellation,
} from "../transportRetry";

function userMessage(text: string): vscode.LanguageModelChatRequestMessage {
    return {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart(text)],
    };
}

/**
 * Thinking parts are proposed-API values: the class may be absent in a given
 * VS Code host. The duck-typed `{ value }` shape is what
 * StreamedTextAccumulator accepts, so it exercises the real classification
 * path regardless of host.
 */
function thinkingPart(value: string): vscode.LanguageModelResponsePart {
    const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
        (new (v: string) => vscode.LanguageModelResponsePart) | undefined;
    if (ThinkingPart) {
        return new ThinkingPart(value);
    }
    return { value } as vscode.LanguageModelResponsePart;
}

/**
 * Asserts that a message is the user-role continuation nudge appended after
 * a resumed assistant turn: a single text part reading "Continue".
 */
function assertContinueNudge(message: vscode.LanguageModelChatRequestMessage | undefined): void {
    assert.ok(message, "expected a continuation nudge message");
    assert.strictEqual(message.role, vscode.LanguageModelChatMessageRole.User);
    const content = message.content as vscode.LanguageModelResponsePart[];
    assert.strictEqual(content.length, 1);
    assert.strictEqual((content[0] as vscode.LanguageModelTextPart).value, "Continue");
}

suite("Transport Retry Utilities", () => {
    test("backoffDelayMs doubles per attempt from the base and caps at 30s", () => {
        assert.strictEqual(backoffDelayMs(1, 1000), 1000);
        assert.strictEqual(backoffDelayMs(2, 1000), 2000);
        assert.strictEqual(backoffDelayMs(3, 1000), 4000);
        assert.strictEqual(backoffDelayMs(4, 1000), 8000);
        // attempt 0 and negatives clamp to the base
        assert.strictEqual(backoffDelayMs(0, 500), 500);
        assert.strictEqual(backoffDelayMs(-3, 500), 500);
        // exponential growth stops at the cap
        assert.strictEqual(backoffDelayMs(10, 4000), 30_000);
        assert.strictEqual(backoffDelayMs(20, 60_000), 30_000);
    });

    test("isTransportRetriableError accepts socket deaths and stream truncation", () => {
        for (const message of [
            "terminated",
            "TypeError: fetch failed",
            "socket hang up",
            "read ECONNRESET",
            "connect ECONNREFUSED 127.0.0.1:4000",
            "getaddrinfo ENOTFOUND example.com",
            "connect ETIMEDOUT 1.2.3.4:443",
            "write EPIPE",
            "other side closed",
            "Stream ended before [DONE] marker",
        ]) {
            assert.ok(isTransportRetriableError(new Error(message)), `expected retriable: ${message}`);
        }
        assert.ok(isTransportRetriableError(new InactivityTimeoutError(60_000, 3)));
        assert.ok(isTransportRetriableError(new Error("Some prefix, then terminated")));
        // non-Error values are not retriable
        assert.strictEqual(isTransportRetriableError("terminated"), false);
        assert.strictEqual(isTransportRetriableError(undefined), false);
        assert.strictEqual(isTransportRetriableError(null), false);
        assert.strictEqual(isTransportRetriableError(42), false);
    });

    test("isTransportRetriableError rejects API errors, cancellation, and reasoning-only", () => {
        assert.strictEqual(isTransportRetriableError(new Error("LiteLLM API error: 500 boom")), false);
        assert.strictEqual(isTransportRetriableError(new Error("LiteLLM Error (model-1): nope")), false);
        assert.strictEqual(isTransportRetriableError(new Error("Operation cancelled by user")), false);
        const abortErr = new Error("This operation was aborted");
        abortErr.name = "AbortError";
        assert.strictEqual(isTransportRetriableError(abortErr), false);
        const cancelErr = new Error("weird failure");
        cancelErr.name = "CancellationError";
        assert.strictEqual(isTransportRetriableError(cancelErr), false);
        // the standard VS Code cancellation object carries the same name
        if ("CancellationError" in vscode) {
            assert.strictEqual(isTransportRetriableError(new vscode.CancellationError()), false);
        }
        // reasoning-only streams have their own retry budget, never the transport budget
        assert.strictEqual(isTransportRetriableError(new ReasoningOnlyError(5, 400)), false);
        assert.strictEqual(isTransportRetriableError(new Error("some unrelated failure")), false);
    });

    test("StreamedTextAccumulator classifies text, tool call, and thinking parts", () => {
        const accumulator = new StreamedTextAccumulator();
        assert.ok(accumulator.isEmpty, "fresh accumulator is empty");

        accumulator.add(new vscode.LanguageModelTextPart("Hello "));
        accumulator.add(thinkingPart("deep "));
        accumulator.add(thinkingPart("thought"));
        accumulator.add(new vscode.LanguageModelTextPart("world"));
        accumulator.add(new vscode.LanguageModelToolCallPart("call-1", "get_time", {}));

        assert.strictEqual(accumulator.text, "Hello world");
        assert.strictEqual(accumulator.thinking, "deep thought");
        assert.ok(accumulator.sawToolCall);
        assert.strictEqual(accumulator.isEmpty, false);

        accumulator.reset();
        assert.ok(accumulator.isEmpty);
        assert.strictEqual(accumulator.text, "");
        assert.strictEqual(accumulator.thinking, "");
        assert.strictEqual(accumulator.sawToolCall, false);
    });

    test("StreamedTextAccumulator ignores non-text, non-thinking parts", () => {
        const accumulator = new StreamedTextAccumulator();
        const usagePart = new vscode.LanguageModelDataPart(new TextEncoder().encode("{}"), "usage");
        accumulator.add(usagePart);
        assert.ok(accumulator.isEmpty, "data parts must not affect resume content");
    });

    test("buildResumeMessages appends one assistant turn with text and reasoning", () => {
        const original = [userMessage("hi")];
        const resumed = buildResumeMessages(original, "partial answer", "partial reasoning");

        assert.strictEqual(resumed.length, 3);
        assert.strictEqual(resumed[0].role, vscode.LanguageModelChatMessageRole.User);
        assert.strictEqual(resumed[1].role, vscode.LanguageModelChatMessageRole.Assistant);
        const content = resumed[1].content as vscode.LanguageModelResponsePart[];
        assert.strictEqual(content.length, 2);
        assert.strictEqual((content[0] as { value?: unknown }).value, "partial reasoning");
        assert.strictEqual((content[1] as vscode.LanguageModelTextPart).value, "partial answer");
        assertContinueNudge(resumed[2]);
        // original list untouched
        assert.strictEqual(original.length, 1);
    });

    test("buildResumeMessages merges into a trailing assistant turn when one exists", () => {
        const assistantTurn = {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("prior turn")],
        } as vscode.LanguageModelChatRequestMessage;
        const original = [userMessage("hi"), assistantTurn];
        const resumed = buildResumeMessages(original, "resume text", "");

        assert.strictEqual(resumed.length, 3, "merge keeps the message count and adds the nudge");
        const content = resumed[1].content as vscode.LanguageModelResponsePart[];
        assert.strictEqual(content.length, 2, "resume parts are appended to the existing turn");
        assert.strictEqual((content[0] as vscode.LanguageModelTextPart).value, "prior turn");
        assert.strictEqual((content[1] as vscode.LanguageModelTextPart).value, "resume text");
        assertContinueNudge(resumed[2]);
        // original list untouched
        const originalContent = original[1].content as vscode.LanguageModelResponsePart[];
        assert.strictEqual(originalContent.length, 1);
    });

    test("buildResumeMessages keeps the original list when nothing was streamed", () => {
        const original = [userMessage("hi")];
        const resumed = buildResumeMessages(original, "", "   ");

        assert.strictEqual(resumed.length, 1);
        assert.strictEqual(resumed[0].role, vscode.LanguageModelChatMessageRole.User);
    });

    test("buildResumeMessages adds no nudge when nothing was streamed and the request ends with tool results", () => {
        // Tool results ride in user-role messages, so an agent-flow request
        // whose tools already ran ends on a user-role tool-result message.
        const toolResultTurn = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [{ callId: "call-1", content: [] }],
        } as unknown as vscode.LanguageModelChatRequestMessage;
        const original = [userMessage("hi"), toolResultTurn];
        const resumed = buildResumeMessages(original, "", "");

        assert.strictEqual(resumed.length, 2, "a tool-result-final request is resent unchanged");
    });

    test("buildResumeMessages appends the nudge when nothing was streamed but the request ends with an assistant message", () => {
        const assistantTurn = {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("prior turn")],
        } as vscode.LanguageModelChatRequestMessage;
        const original = [userMessage("hi"), assistantTurn];
        const resumed = buildResumeMessages(original, "", "");

        assert.strictEqual(resumed.length, 3);
        const assistantContent = resumed[1].content as vscode.LanguageModelResponsePart[];
        assert.strictEqual((assistantContent[0] as vscode.LanguageModelTextPart).value, "prior turn");
        assertContinueNudge(resumed[2]);
    });

    test("buildResumeMessages appends the assistant turn and nudge after a trailing tool-result message", () => {
        // Agent flow with a mid-response transport death: the partial text
        // becomes a fresh assistant turn after the tool results.
        const toolResultTurn = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [{ callId: "call-1", content: [] }],
        } as unknown as vscode.LanguageModelChatRequestMessage;
        const original = [userMessage("hi"), toolResultTurn];
        const resumed = buildResumeMessages(original, "partial answer", "");

        assert.strictEqual(resumed.length, 4);
        assert.strictEqual(resumed[2].role, vscode.LanguageModelChatMessageRole.Assistant);
        assertContinueNudge(resumed[3]);
    });

    test("sleepWithCancellation resolves immediately when already cancelled", async () => {
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel();
        const startedAt = Date.now();
        await sleepWithCancellation(60_000, tokenSource.token);
        assert.ok(Date.now() - startedAt < 1_000, "cancelled sleep must not wait out the full delay");
    });

    test("sleepWithCancellation resolves at the delay when not cancelled", async () => {
        const tokenSource = new vscode.CancellationTokenSource();
        const startedAt = Date.now();
        await sleepWithCancellation(50, tokenSource.token);
        const elapsed = Date.now() - startedAt;
        assert.ok(elapsed >= 45, `slept only ${elapsed}ms`);
        assert.ok(elapsed < 1_000, `slept ${elapsed}ms, expected ~50ms`);
    });

    test("sleepWithCancellation resolves on cancellation mid-sleep", async () => {
        const tokenSource = new vscode.CancellationTokenSource();
        setTimeout(() => tokenSource.cancel(), 30);
        const startedAt = Date.now();
        await sleepWithCancellation(60_000, tokenSource.token);
        const elapsed = Date.now() - startedAt;
        assert.ok(elapsed < 1_000, `cancellation ended sleep after ${elapsed}ms, not 60s`);
    });
});
