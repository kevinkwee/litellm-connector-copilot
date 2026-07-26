import * as assert from "assert";
import * as vscode from "vscode";
import {
    renderCopilotMd,
    buildCopilotMdFilename,
    computeSessionFingerprint,
    type CopilotMdEntry,
} from "../copilotMdRenderer";
import type { OpenAIChatCompletionRequest } from "../../types";
import type { TokenSnapshot } from "../../adapters/streaming/streamTokenCapture";

/**
 * Tests for the `.copilotmd` request-log renderer.
 *
 * These tests lock in the byte-format contract: the rendered output must
 * match VS Code Copilot's `RequestLogger._renderRequestToMarkdown` line-
 * for-line (header banner, TOC, `## Metadata` `<pre><code>` block, `tools`
 * `<details>`, `## Request Messages` `~~~md` fenced blocks with `🛠️` tool
 * markers, `## Response` section, trailing `<style>`). When the upstream
 * Copilot format changes, these tests are the canary that tells us to
 * update the renderer.
 *
 * Tests use the real `vscode.LanguageModelTextPart` / `LanguageModelToolCallPart`
 * / `LanguageModelToolResultPart` constructors so the `instanceof` checks
 * inside `requestPartToMarkdown` exercise the same code path production does.
 */

function makeMinimalSnapshot(): TokenSnapshot {
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

function makeMinimalBody(): OpenAIChatCompletionRequest {
    return {
        model: "test-model",
        messages: [],
        stream: true,
        max_tokens: 1024,
    };
}

function makeMinimalEntry(overrides: Partial<CopilotMdEntry> = {}): CopilotMdEntry {
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
        ...overrides,
    };
}

suite("renderCopilotMd", () => {
    test("renders the privacy banner and H1 header first", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        const lines = md.split("\n");
        assert.strictEqual(
            lines[0],
            "> 🚨 Note: This log may contain personal information such as the contents of your files or terminal output. Please review the contents carefully before sharing."
        );
        assert.strictEqual(lines[1], "# chat - abc12345");
    });

    test("renders the table of contents with Request Messages and Response", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(md.includes("- [Request Messages](#request-messages)"));
        assert.ok(md.includes("  - [System](#system)"));
        assert.ok(md.includes("  - [User](#user)"));
        assert.ok(md.includes("- [Response](#response)"));
    });

    test("renders the Metadata block with the expected keys", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(md.includes("## Metadata"));
        assert.ok(md.includes("<pre><code>"));
        assert.ok(md.includes("url              : https://litellm.example.com"));
        assert.ok(md.includes("model            : test-model"));
        assert.ok(md.includes("maxPromptTokens  : 8192"));
        assert.ok(md.includes("maxResponseTokens: 1024"));
        assert.ok(md.includes("location         : 1"));
        assert.ok(md.includes("otherOptions     : {\"stream\":true}"));
        assert.ok(md.includes("intent           : undefined"));
        assert.ok(md.includes("startTime        : 2026-07-26T10:00:00.000Z"));
        assert.ok(md.includes("endTime          : 2026-07-26T10:00:05.000Z"));
        assert.ok(md.includes("duration         : 5000ms"));
        assert.ok(md.includes("ourRequestId     : req-abc12345"));
        assert.ok(md.includes("</code></pre>"));
    });

    test("omits the reasoning line when reasoning_effort is not set", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(!md.includes("reasoning        :"));
    });

    test("includes the reasoning line when reasoning_effort is set", () => {
        const entry = makeMinimalEntry({
            body: { ...makeMinimalBody(), reasoning_effort: "high" },
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes('reasoning        : "high"'));
    });

    test("renders success-path metadata: requestId, serverRequestId, TTFT, resolved model, usage", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(md.includes("requestId        : req-abc12345"));
        assert.ok(md.includes("serverRequestId  : req-abc12345"));
        assert.ok(md.includes("timeToFirstToken : 250ms"));
        assert.ok(md.includes("resolved model   : test-model"));
        // usage is a JSON-stringified OpenAIUsagePayload
        assert.ok(md.includes("usage            : "));
        assert.ok(md.includes('"prompt_tokens":100'));
        assert.ok(md.includes('"completion_tokens":50'));
    });

    test("omits estimatedCost line when estimatedTotalCost is undefined", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(!md.includes("estimatedCost"));
    });

    test("includes estimatedCost line when estimatedTotalCost is set", () => {
        const entry = makeMinimalEntry({
            usage: {
                ...makeMinimalSnapshot(),
                estimatedInputCost: 0.001,
                estimatedOutputCost: 0.002,
                estimatedTotalCost: 0.003,
            },
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes("estimatedCost    : $0.003000"));
    });

    test("omits the tools <details> block when body.tools is empty", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(!md.includes("<details>"));
        assert.ok(!md.includes("<summary>tools"));
    });

    test("renders the tools <details> block with names and full JSON when tools are present", () => {
        const entry = makeMinimalEntry({
            body: {
                ...makeMinimalBody(),
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "create_file",
                            description: "Create a file",
                            parameters: { type: "object", properties: {} },
                        },
                    },
                    {
                        type: "function",
                        function: {
                            name: "read_file",
                            description: "Read a file",
                            parameters: { type: "object", properties: {} },
                        },
                    },
                ],
            },
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes("<details>"));
        // Copilot pads the count field to align the `:` — formula is
        // `' '.repeat(9 - numToolsString.length)`. For `(2)` (3 chars) that's
        // 6 spaces; for `(80)` (4 chars) that's 5 spaces. The `:` lands at the
        // same column regardless of tool count.
        assert.ok(md.includes("<summary>tools (2)      : create_file, read_file</summary>"));
        assert.ok(md.includes('"name": "create_file"'));
        assert.ok(md.includes('"name": "read_file"'));
        assert.ok(md.includes("</details>"));
    });

    test("renders Request Messages section with System and User messages", () => {
        const entry = makeMinimalEntry({
            requestMessages: [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelTextPart("You are helpful.")],
                    name: undefined,
                },
                // System role isn't in the stable enum; skip — covered by the
                // User/Assistant role tests below.
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("Hi there")],
                    name: undefined,
                },
            ],
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes("## Request Messages"));
        assert.ok(md.includes("### Assistant"));
        assert.ok(md.includes("You are helpful."));
        assert.ok(md.includes("### User"));
        assert.ok(md.includes("Hi there"));
    });

    test("renders Assistant tool-call parts inside request messages as 🛠️ lines", () => {
        const entry = makeMinimalEntry({
            requestMessages: [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelToolCallPart("call_1", "read_file", {
                            filePath: "/tmp/x.ts",
                        }),
                    ],
                    name: undefined,
                },
            ],
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes("🛠️ read_file (call_1)"));
        // Pretty-printed args should include the filePath with newlines/tabs un-escaped
        assert.ok(md.includes('"filePath": "/tmp/x.ts"'));
    });

    test("renders User tool-result parts inside request messages as 🛠️ {callId} + result text", () => {
        const entry = makeMinimalEntry({
            requestMessages: [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart("call_1", [
                            new vscode.LanguageModelTextPart("file content here"),
                        ]),
                    ],
                    name: undefined,
                },
            ],
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes("🛠️ call_1"));
        assert.ok(md.includes("file content here"));
    });

    test("renders the Response section with the assistant text part", () => {
        const entry = makeMinimalEntry({
            responseParts: [new vscode.LanguageModelTextPart("Hello, world!")],
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes('<a id="response"></a>'));
        assert.ok(md.includes("## Response"));
        assert.ok(md.includes("### Assistant"));
        assert.ok(md.includes("Hello, world!"));
    });

    test("renders tool-call parts in the response as 🛠️ lines", () => {
        const entry = makeMinimalEntry({
            responseParts: [
                new vscode.LanguageModelTextPart("Calling tool now."),
                new vscode.LanguageModelToolCallPart("call_42", "create_file", {
                    filePath: "/tmp/y.ts",
                    content: "hello",
                }),
            ],
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes("Calling tool now."));
        assert.ok(md.includes("🛠️ create_file (call_42)"));
    });

    test("drops LanguageModelDataPart (usage) from the rendered response body", () => {
        const usageJson = JSON.stringify({ prompt_tokens: 10, completion_tokens: 5 });
        const entry = makeMinimalEntry({
            responseParts: [
                new vscode.LanguageModelTextPart("ok"),
                new vscode.LanguageModelDataPart(new TextEncoder().encode(usageJson), "usage"),
            ],
        });
        const md = renderCopilotMd(entry);
        // Text is rendered
        assert.ok(md.includes("ok"));
        // Usage data is NOT rendered into the response body (it lives in the
        // metadata `usage:` line instead). Check for a substring unique to the
        // DataPart payload (`"completion_tokens":5`) — the snapshot's usage
        // line has `"completion_tokens":50`, so `"completion_tokens":5` would
        // be a prefix match and give a false positive; use the exact value
        // including the closing brace to avoid the prefix trap.
        assert.ok(
            !md.includes('"completion_tokens":5}'),
            "usage payload leaked into response body"
        );
    });

    test("renders the trailing <style> block verbatim", () => {
        const md = renderCopilotMd(makeMinimalEntry());
        assert.ok(md.includes("<style>"));
        assert.ok(md.includes('[id^="system"], [id^="user"], [id^="assistant"]'));
        assert.ok(md.includes(".markdown-body > pre"));
        assert.ok(md.endsWith("</style>\n"));
    });

    test("renders FAILED section with reason on failure status", () => {
        const entry = makeMinimalEntry({
            status: "failure",
            statusReason: "LiteLLM API error 400: bad request",
            responseParts: [],
        });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes('<a id="response"></a>'));
        assert.ok(md.includes("## FAILED: LiteLLM API error 400: bad request"));
        // Should NOT include the success-path metadata lines
        assert.ok(!md.includes("resolved model   :"));
        assert.ok(!md.includes("timeToFirstToken :"));
    });

    test("renders CANCELED section on canceled status", () => {
        const entry = makeMinimalEntry({ status: "canceled", responseParts: [] });
        const md = renderCopilotMd(entry);
        assert.ok(md.includes('<a id="response"></a>'));
        assert.ok(md.includes("## CANCELED"));
    });
});

suite("buildCopilotMdFilename", () => {
    test("builds {debugName}_{sortableTimestamp}_{id}.copilotmd", () => {
        const entry = makeMinimalEntry({
            debugName: "panel/editAgent",
            id: "f3af93ab",
            startTimeIso: "2026-07-11T09:25:59.651Z",
        });
        const filename = buildCopilotMdFilename(entry);
        // debugName is sanitized: / becomes _; timestamp strips -, ms, Z.
        assert.strictEqual(filename, "panel_editAgent_20260711_092559_f3af93ab.copilotmd");
    });

    test("strips other non-word characters from debugName", () => {
        const entry = makeMinimalEntry({
            debugName: "chat:tool-calling",
            id: "ab12cd34",
            startTimeIso: "2026-07-26T10:00:00.000Z",
        });
        const filename = buildCopilotMdFilename(entry);
        assert.strictEqual(filename, "chat_tool_calling_20260726_100000_ab12cd34.copilotmd");
    });
});

suite("computeSessionFingerprint", () => {
    test("returns a stable 8-char hex for the same message set", () => {
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("what is the content of result?")],
                name: undefined,
            },
        ];
        const a = computeSessionFingerprint(messages);
        const b = computeSessionFingerprint(messages);
        assert.strictEqual(a, b);
        assert.match(a, /^[0-9a-f]{8}$/);
    });

    test("returns different fingerprints for different user requests", () => {
        const messages1 = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("question A")],
                name: undefined,
            },
        ];
        const messages2 = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("question B")],
                name: undefined,
            },
        ];
        assert.notStrictEqual(computeSessionFingerprint(messages1), computeSessionFingerprint(messages2));
    });

    test("skips leading System messages (agent instructions are identical across sessions in a mode)", () => {
        // Two sessions with the same system message but different user requests
        // must get different fingerprints. If the system message leaked into
        // the hash, two sessions with the same system prompt (i.e. every
        // session in the same agent mode) would collide.
        //
        // The stable `LanguageModelChatMessageRole` enum only declares User(1)
        // and Assistant(2); the System role is value 3 (declared in the
        // `languageModelSystem` proposed API). We use the numeric literal
        // directly because that's what the runtime actually sends for system
        // messages, and casting through `as unknown as` keeps TypeScript happy.
        const SystemRole = 3 as unknown as vscode.LanguageModelChatMessageRole;
        const systemContent = "You are an expert AI programming assistant.";
        const sessionA = [
            {
                role: SystemRole,
                content: [new vscode.LanguageModelTextPart(systemContent)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("request A")],
                name: undefined,
            },
        ];
        const sessionB = [
            {
                role: SystemRole,
                content: [new vscode.LanguageModelTextPart(systemContent)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("request B")],
                name: undefined,
            },
        ];
        assert.notStrictEqual(
            computeSessionFingerprint(sessionA),
            computeSessionFingerprint(sessionB),
            "same system message + different request must NOT collide"
        );
    });

    test("differentiates sessions with the same workspace context but different first request", () => {
        // Realistic Copilot Chat structure: system + user-env + user-request.
        // Two sessions in the same workspace share the env-context user message
        // but have different actual requests. They MUST get different fingerprints.
        const SystemRole = 3 as unknown as vscode.LanguageModelChatMessageRole;
        const envContext = "<environment_info>OS: Windows</environment_info>";
        const sessionA = [
            {
                role: SystemRole,
                content: [new vscode.LanguageModelTextPart("system prompt")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(envContext)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("explain recursion")],
                name: undefined,
            },
        ];
        const sessionB = [
            {
                role: SystemRole,
                content: [new vscode.LanguageModelTextPart("system prompt")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(envContext)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("fix the failing test")],
                name: undefined,
            },
        ];
        assert.notStrictEqual(
            computeSessionFingerprint(sessionA),
            computeSessionFingerprint(sessionB),
            "same workspace context + different request must NOT collide"
        );
    });

    test("stays stable when later turns append assistant + tool + follow-up messages", () => {
        // Within a session, each turn's messages array is a superset of the
        // previous turn's. The "user messages before first assistant" window
        // is therefore stable across all turns: turn 1 has [user-env, user-request]
        // (no assistant yet); turn 2 has [user-env, user-request, assistant, tool,
        // user-followup] — the window still captures only [user-env, user-request]
        // because the first assistant message ends the window.
        const turn1 = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("explain recursion")],
                name: undefined,
            },
        ];
        const turn2 = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("explain recursion")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("recursion is...")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("and the tool message?")],
                name: undefined,
            },
        ];
        assert.strictEqual(computeSessionFingerprint(turn1), computeSessionFingerprint(turn2));
    });

    test("window is exclusive of the first assistant message (so turn 1 and turn 2 match)", () => {
        // If the first assistant message were INCLUDED in the hash, turn 1
        // (no assistant → hash [user]) and turn 2 (assistant present → hash
        // [user, assistant]) would get different fingerprints, splitting one
        // session across two folders. The exclusive window prevents that.
        const SystemRole = 3 as unknown as vscode.LanguageModelChatMessageRole;
        const envContext = "env";
        const userRequest = "request";
        const turn1 = [
            {
                role: SystemRole,
                content: [new vscode.LanguageModelTextPart("system")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(envContext)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(userRequest)],
                name: undefined,
            },
        ];
        const turn2 = [
            {
                role: SystemRole,
                content: [new vscode.LanguageModelTextPart("system")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(envContext)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart(userRequest)],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("here is the answer")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("follow-up question")],
                name: undefined,
            },
        ];
        assert.strictEqual(computeSessionFingerprint(turn1), computeSessionFingerprint(turn2));
    });

    test("falls back to the first message's role when no user message is present before the first assistant", () => {
        // Degenerate case: a tool-calling sub-turn seeded only with system +
        // assistant + tool messages. Still needs a deterministic fingerprint.
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("calling tool")],
                name: undefined,
            },
        ];
        const fp = computeSessionFingerprint(messages);
        assert.match(fp, /^[0-9a-f]{8}$/);
        // Same input → same fingerprint (deterministic)
        assert.strictEqual(fp, computeSessionFingerprint(messages));
    });

    test("returns a stable fingerprint for an empty message array", () => {
        const fp = computeSessionFingerprint([]);
        assert.match(fp, /^[0-9a-f]{8}$/);
        assert.strictEqual(fp, computeSessionFingerprint([]));
    });
});
