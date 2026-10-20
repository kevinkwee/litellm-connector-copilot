import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import type { OpenAIChatCompletionRequest } from "../../types";
import {
    collectResponseText,
    collectToolCalls,
    createMockChatResponseOptions,
    createMockModel,
    createMockSecrets,
    createMockUserMessage,
    TEST_USER_AGENT,
} from "../../test/utils/testMocks";
import {
    chatFinishFrame,
    chatTextFrame,
    chatToolCallArgumentsFrame,
    chatToolCallHeaderFrame,
    createMockSSEStream,
    SSE_DONE_FRAME,
    SteppedSseStream,
} from "../../test/utils/testStreamUtils";

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const TASK_ARGUMENTS = { description: "verify logo", mode: "background" };
const STOP_ARGUMENTS = { shellId: "logo-verify-server" };

const MODEL = createMockModel({ maxOutputTokens: 4096, capabilities: { toolCalling: true, imageInput: false } });

function sessionLabelOf(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const firstPart = messages[0]?.content[0];
    if (!(firstPart instanceof vscode.LanguageModelTextPart)) {
        throw new Error("Expected the first request message to carry the session label");
    }
    return firstPart.value;
}

interface ProviderSeams {
    _configManager: { getConfig: () => Promise<unknown> };
    sendRequestWithRetry: (
        body: OpenAIChatCompletionRequest,
        messages: readonly vscode.LanguageModelChatRequestMessage[]
    ) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Runs chat requests from several sessions through one shared provider, the
 * way VS Code drives a single registered provider for every open session.
 * Each session's first upstream call streams its scripted body; any retry
 * gets an empty completed stream so a misclassified retry ends quickly.
 */
class ConcurrentSessionsHarness {
    private readonly provider = new LiteLLMChatProvider(createMockSecrets(), TEST_USER_AGENT);
    private readonly partsBySession = new Map<string, vscode.LanguageModelResponsePart[]>();
    private readonly upstreamCallsBySession = new Map<string, number>();

    constructor(sandbox: sinon.SinonSandbox, streamsBySession: Readonly<Record<string, SteppedSseStream>>) {
        const seams = this.provider as unknown as ProviderSeams;
        sandbox.stub(seams._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            inactivityTimeout: 60,
            emptyResponseRetryDelayMs: 1,
            networkRetryDelayMs: 1,
        });
        sandbox.stub(seams, "sendRequestWithRetry").callsFake(async (_body, messages) => {
            const label = sessionLabelOf(messages);
            const previousCalls = this.upstreamCallsBySession.get(label) ?? 0;
            this.upstreamCallsBySession.set(label, previousCalls + 1);
            return previousCalls === 0 ? streamsBySession[label].body : createMockSSEStream([]);
        });
    }

    start(label: string): Promise<void> {
        const parts: vscode.LanguageModelResponsePart[] = [];
        this.partsBySession.set(label, parts);
        return this.provider.provideLanguageModelChatResponse(
            MODEL,
            [createMockUserMessage(label)],
            createMockChatResponseOptions(),
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );
    }

    partsOf(label: string): readonly vscode.LanguageModelResponsePart[] {
        return this.partsBySession.get(label) ?? [];
    }

    upstreamCallsOf(label: string): number {
        return this.upstreamCallsBySession.get(label) ?? 0;
    }
}

function usagePartCountOf(parts: readonly vscode.LanguageModelResponsePart[]): number {
    return parts.filter((part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage").length;
}

/**
 * Both sessions stream a tool call at index 0 and their argument deltas
 * interleave, and B finishes while A's call is still open.
 */
async function runSameIndexToolCallSessions(sandbox: sinon.SinonSandbox): Promise<ConcurrentSessionsHarness> {
    const streamA = new SteppedSseStream(
        [
            chatToolCallHeaderFrame("toolu_a", "task"),
            chatToolCallArgumentsFrame(JSON.stringify(TASK_ARGUMENTS)),
            chatFinishFrame("tool_calls"),
            SSE_DONE_FRAME,
        ],
        [1, 2]
    );
    const streamB = new SteppedSseStream(
        [
            chatToolCallHeaderFrame("toolu_b", "stop_powershell"),
            chatToolCallArgumentsFrame(JSON.stringify(STOP_ARGUMENTS)),
            chatFinishFrame("tool_calls"),
            SSE_DONE_FRAME,
        ],
        [1]
    );
    const harness = new ConcurrentSessionsHarness(sandbox, { [SESSION_A]: streamA, [SESSION_B]: streamB });

    const requestA = harness.start(SESSION_A);
    await streamA.reached(1);
    const requestB = harness.start(SESSION_B);
    await streamB.reached(1);
    streamA.release(1);
    await streamA.reached(2);
    streamB.release(1);
    await requestB;
    streamA.release(2);
    await requestA;
    return harness;
}

suite("LiteLLMChatProvider concurrent requests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("delivers a tool call while another request streams the same tool-call index", async () => {
        const harness = await runSameIndexToolCallSessions(sandbox);

        assert.deepStrictEqual(collectToolCalls(harness.partsOf(SESSION_A)), [{ name: "task", input: TASK_ARGUMENTS }]);
    });

    test("keeps tool call arguments separate across concurrent requests", async () => {
        const harness = await runSameIndexToolCallSessions(sandbox);

        assert.deepStrictEqual(collectToolCalls(harness.partsOf(SESSION_B)), [
            { name: "stop_powershell", input: STOP_ARGUMENTS },
        ]);
    });

    test("does not retry a request as reasoning-only when another request finishes first", async () => {
        const harness = await runSameIndexToolCallSessions(sandbox);

        assert.strictEqual(harness.upstreamCallsOf(SESSION_A), 1);
    });

    test("never reports a buffered tool call on another request's progress", async () => {
        const streamA = new SteppedSseStream(
            [
                chatToolCallHeaderFrame("toolu_a", "task"),
                chatToolCallArgumentsFrame(JSON.stringify(TASK_ARGUMENTS)),
                chatFinishFrame("tool_calls"),
                SSE_DONE_FRAME,
            ],
            [2]
        );
        const streamB = new SteppedSseStream(
            [chatTextFrame("B is answering"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            [1]
        );
        const harness = new ConcurrentSessionsHarness(sandbox, { [SESSION_A]: streamA, [SESSION_B]: streamB });

        const requestB = harness.start(SESSION_B);
        await streamB.reached(1);
        const requestA = harness.start(SESSION_A);
        await streamA.reached(2);
        streamB.release(1);
        await requestB;
        streamA.release(2);
        await requestA;

        assert.deepStrictEqual(collectToolCalls(harness.partsOf(SESSION_B)), []);
    });

    test("never emits another request's text on the wrong progress", async () => {
        const streamA = new SteppedSseStream(
            [chatTextFrame("A starts "), chatTextFrame("A ends"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            [1]
        );
        const streamB = new SteppedSseStream(
            [chatTextFrame("B starts "), chatTextFrame("B ends"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            [1]
        );
        const harness = new ConcurrentSessionsHarness(sandbox, { [SESSION_A]: streamA, [SESSION_B]: streamB });

        const requestB = harness.start(SESSION_B);
        await streamB.reached(1);
        const requestA = harness.start(SESSION_A);
        await streamA.reached(1);
        streamB.release(1);
        await requestB;
        streamA.release(1);
        await requestA;

        assert.strictEqual(collectResponseText(harness.partsOf(SESSION_A)), "A starts A ends");
        assert.strictEqual(collectResponseText(harness.partsOf(SESSION_B)), "B starts B ends");
    });

    test("reports usage once on each concurrent request's own progress", async () => {
        const streamA = new SteppedSseStream(
            [chatTextFrame("A answers"), chatFinishFrame("stop"), SSE_DONE_FRAME],
            [1]
        );
        const streamB = new SteppedSseStream([chatTextFrame("B answers"), chatFinishFrame("stop"), SSE_DONE_FRAME], []);
        const harness = new ConcurrentSessionsHarness(sandbox, { [SESSION_A]: streamA, [SESSION_B]: streamB });

        const requestA = harness.start(SESSION_A);
        await streamA.reached(1);
        await harness.start(SESSION_B);
        streamA.release(1);
        await requestA;

        assert.deepStrictEqual(
            [usagePartCountOf(harness.partsOf(SESSION_A)), usagePartCountOf(harness.partsOf(SESSION_B))],
            [1, 1]
        );
    });
});
