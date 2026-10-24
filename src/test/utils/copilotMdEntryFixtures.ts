import * as vscode from "vscode";
import type { CopilotMdEntry } from "../../observability";
import type { OpenAIChatCompletionRequest } from "../../types";
import type { TokenSnapshot } from "../../adapters/streaming/streamTokenCapture";

/** Builds the usage snapshot of a small successful request. */
export function makeMinimalSnapshot(): TokenSnapshot {
    return {
        promptTokens: 100,
        cachedTokens: 0,
        cacheCreationInputTokens: 0,
        systemPromptTokens: 0,
        completionTokens: 50,
        reasoningTokens: 0,
        toolTokens: 0,
        acceptedPredictionTokens: 0,
        rejectedPredictionTokens: 0,
        sawUpstreamUsage: true,
    };
}

/** Builds a streaming chat request body with no messages or tools. */
export function makeMinimalBody(): OpenAIChatCompletionRequest {
    return {
        model: "test-model",
        messages: [],
        stream: true,
        max_tokens: 1024,
    };
}

/** Builds a successful `.copilotmd` entry; `overrides` replace individual fields. */
export function makeMinimalEntry(overrides: Partial<CopilotMdEntry> = {}): CopilotMdEntry {
    return {
        debugName: "chat",
        id: "abc12345",
        model: "test-model",
        url: "https://litellm.example.com",
        maxPromptTokens: 8192,
        maxResponseTokens: 1024,
        location: 1,
        body: makeMinimalBody(),
        requestMessages: [],
        startTimeIso: "2026-07-26T10:00:00.000Z",
        endTimeIso: "2026-07-26T10:00:05.000Z",
        durationMs: 5000,
        ourRequestId: "req-abc12345",
        timeToFirstTokenMs: 250,
        resolvedModel: "test-model",
        usage: makeMinimalSnapshot(),
        responseParts: [new vscode.LanguageModelTextPart("Hello, world!")],
        status: "success",
        sessionId: "e7074038-e624-585e-bf91-fc179549e3ca",
        // A UUID v5, the shape every fingerprint id has, so the pair stays self-consistent.
        sessionIdSource: "fingerprint",
        ...overrides,
    };
}
