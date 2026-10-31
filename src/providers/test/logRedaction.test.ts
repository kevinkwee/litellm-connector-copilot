import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMApiError, LiteLLMClient } from "../../adapters/litellmClient";
import { StructuredLogger } from "../../observability/structuredLogger";
import { Logger } from "../../utils/logger";
import {
    collectResponseText,
    createMockChatResponseOptions,
    createMockModel,
    createMockSecrets,
    createMockUserMessage,
    TEST_USER_AGENT,
} from "../../test/utils/testMocks";
import { chatFinishFrame, chatTextFrame, SSE_DONE_FRAME, SteppedSseStream } from "../../test/utils/testStreamUtils";

const SENTINEL = "SECRET_PROMPT_TEXT";
const MODEL = createMockModel({ maxOutputTokens: 4096, capabilities: { toolCalling: true, imageInput: false } });

interface ProviderSeams {
    _configManager: { getConfig: () => Promise<unknown> };
    sendRequestWithRetry: () => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Records every argument of every Logger and StructuredLogger call, so a
 * sentinel can be searched for in everything the connector would have written.
 * An Error renders the way the output channel renders it, message and stack,
 * so a log site that passes one cannot slip past the search.
 */
function spyOnEveryLogMethod(sandbox: sinon.SinonSandbox): string[] {
    const written: string[] = [];
    const render = (arg: unknown): string => {
        if (typeof arg === "string") {
            return arg;
        }
        if (arg instanceof Error) {
            return `${arg.message} ${arg.stack ?? ""}`;
        }
        return JSON.stringify(arg) ?? String(arg);
    };
    const record = (...args: unknown[]): void => {
        written.push(args.map(render).join(" "));
    };
    for (const method of ["info", "warn", "error", "debug", "trace"] as const) {
        sandbox.stub(Logger, method).callsFake(record);
        sandbox.stub(StructuredLogger, method).callsFake(record);
    }
    return written;
}

function createProvider(sandbox: sinon.SinonSandbox): { provider: LiteLLMChatProvider; seams: ProviderSeams } {
    const provider = new LiteLLMChatProvider(createMockSecrets(), TEST_USER_AGENT);
    const seams = provider as unknown as ProviderSeams;
    sandbox.stub(seams._configManager, "getConfig").resolves({
        url: "http://localhost:4000",
        inactivityTimeout: 60,
        networkRetryDelayMs: 1,
    });
    return { provider, seams };
}

async function runTurn(provider: LiteLLMChatProvider): Promise<string> {
    const parts: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(
        MODEL,
        [createMockUserMessage("hi")],
        createMockChatResponseOptions(),
        { report: (part) => parts.push(part) },
        new vscode.CancellationTokenSource().token
    );
    return collectResponseText(parts);
}

suite("Upstream error text stays out of the logs", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("a rejected request keeps its body in the notice and out of every log", async () => {
        const { provider } = createProvider(sandbox);
        const body = JSON.stringify({ error: { message: SENTINEL, type: "invalid_request_error" } });
        sandbox
            .stub(LiteLLMClient.prototype, "chat")
            .rejects(new LiteLLMApiError(400, body, `LiteLLM API error: 400 Bad Request\n${body}`));
        const written = spyOnEveryLogMethod(sandbox);

        const text = await runTurn(provider);

        assert.ok(text.includes(SENTINEL), "the user still sees the proxy's reason");
        assert.ok(!written.some((line) => line.includes(SENTINEL)), "no log level may carry the body");
        const failed = written.filter((line) => line.includes("request.failed"));
        assert.strictEqual(failed.length, 1);
        assert.ok(failed[0].includes('"status":400'), "the status is the diagnostic that survives");
        assert.ok(failed[0].includes("invalid_request_error"), "the upstream type is the diagnostic that survives");
    });

    test("a stream error frame keeps its detail in the notice and out of every log", async () => {
        const { provider, seams } = createProvider(sandbox);
        const errorFrame = JSON.stringify({
            error: { message: SENTINEL, type: "invalid_request_error", code: 400 },
        });
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .resolves(new SteppedSseStream([errorFrame, SSE_DONE_FRAME], []).body);
        const written = spyOnEveryLogMethod(sandbox);

        const text = await runTurn(provider);

        assert.ok(text.includes(SENTINEL), "the user still sees the upstream detail");
        assert.ok(!written.some((line) => line.includes(SENTINEL)), "no log level may carry the detail");
        assert.ok(
            written.some((line) => line.includes("stream.attempt_failed")),
            "the attempt log still runs"
        );
    });

    test("a retried transient error frame logs identifiers, not the detail", async () => {
        const { provider, seams } = createProvider(sandbox);
        const overloadedFrame = JSON.stringify({
            error: { message: SENTINEL, type: "overloaded_error", code: 529 },
        });
        sandbox
            .stub(seams, "sendRequestWithRetry")
            .onFirstCall()
            .resolves(new SteppedSseStream([overloadedFrame, SSE_DONE_FRAME], []).body)
            .onSecondCall()
            .resolves(
                new SteppedSseStream([chatTextFrame("answer"), chatFinishFrame("stop"), SSE_DONE_FRAME], []).body
            );
        const written = spyOnEveryLogMethod(sandbox);

        await runTurn(provider);

        const retries = written.filter((line) => line.includes("request.transport_retry"));
        assert.strictEqual(retries.length, 1, "the transient frame resumes the request");
        assert.ok(retries[0].includes("529"), "the status is logged");
        assert.ok(!written.some((line) => line.includes(SENTINEL)), "no log level may carry the detail");
    });

    test("a network failure logs its message and its cause", async () => {
        const { provider } = createProvider(sandbox);
        sandbox
            .stub(LiteLLMClient.prototype, "chat")
            .rejects(new Error("fetch failed", { cause: new Error("ECONNREFUSED") }));
        const written = spyOnEveryLogMethod(sandbox);

        await runTurn(provider);

        const failed = written.filter((line) => line.includes("request.failed"));
        assert.strictEqual(failed.length, 1);
        assert.ok(failed[0].includes("fetch failed"), "the connector's own error message is diagnostic");
        assert.ok(failed[0].includes("ECONNREFUSED"), "the wrapped cause is the actionable part");
    });
});
