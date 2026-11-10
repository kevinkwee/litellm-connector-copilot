import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import type { OpenAIChatCompletionRequest } from "../../types";
import { TEST_USER_AGENT } from "../../test/utils/testMocks";
import {
    runChatRequest,
    stubCleanChatStream,
    stubConfigAndDiscovery,
    UUID_PATTERN,
} from "../../test/utils/chatProviderTestUtils";

suite("LiteLLM Chat Provider Request", () => {
    let sandbox: sinon.SinonSandbox;

    const userAgent = TEST_USER_AGENT;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("provideTokenCount handles string and message inputs", async () => {
        const provider = new LiteLLMChatProvider(userAgent);
        const tokenSource = new vscode.CancellationTokenSource();

        const stringCount = await provider.provideTokenCount(
            {
                id: "gpt-4",
                name: "gpt-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            "12345",
            tokenSource.token
        );

        // "12345" -> 1-2 tokens depending on tokenizer
        assert.ok(
            stringCount >= 1 && stringCount <= 2,
            `stringCount (${stringCount}) should be within expected range [1, 2]`
        );

        const message: vscode.LanguageModelChatRequestMessage = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("1234"), new vscode.LanguageModelTextPart("abc")],
        };

        const messageCount = await provider.provideTokenCount(
            {
                id: "gpt-4",
                name: "gpt-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            message,
            tokenSource.token
        );

        // "1234" (1) + "abc" (1) + overhead (3) = 5 (or 6 depending on role/message formatting)
        assert.ok(
            messageCount >= 2 && messageCount <= 6,
            `messageCount (${messageCount}) should be within expected range [2, 6]`
        );
    });

    test("sends the host conversation id as metadata.session_id", async () => {
        const provider = new LiteLLMChatProvider(userAgent);
        stubConfigAndDiscovery(sandbox, provider);
        const sent: OpenAIChatCompletionRequest[] = [];
        stubCleanChatStream(sandbox, sent);

        const hostConversationId = "3f8a2c94-1b7d-4e05-9c62-8d1f4a7b2e11";
        await runChatRequest(provider, [], undefined, { _conversationId: hostConversationId });

        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].metadata?.session_id, hostConversationId);
    });

    test("sends a stable fingerprint as metadata.session_id when the host sends no conversation id", async () => {
        const provider = new LiteLLMChatProvider(userAgent);
        stubConfigAndDiscovery(sandbox, provider);
        const sent: OpenAIChatCompletionRequest[] = [];
        stubCleanChatStream(sandbox, sent);

        await runChatRequest(provider, []);
        await runChatRequest(provider, []);

        assert.strictEqual(sent.length, 2);
        const firstSessionId = sent[0].metadata?.session_id;
        assert.match(String(firstSessionId), UUID_PATTERN);
        assert.strictEqual(sent[1].metadata?.session_id, firstSessionId);
    });
});
