import * as assert from "assert";
import * as sinon from "sinon";

import { Logger } from "../../utils/logger";
import { logFinalUsageEnvelope } from "../finalUsageEnvelope";

/**
 * Tests for the final usage envelope log line. The field names are the contract:
 * they are what a support reader greps for when a request's token totals or cost
 * look wrong, so a rename has to fail here.
 */
suite("logFinalUsageEnvelope", () => {
    let sandbox: sinon.SinonSandbox;
    let debug: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        debug = sandbox.stub(Logger, "debug");
    });

    teardown(() => {
        sandbox.restore();
    });

    const lastMessage = (): string => String(debug.lastCall?.args[0]);

    test("logs every counter, budget, and cost it was given", () => {
        logFinalUsageEnvelope("req-1", "gpt-5.4", "panel/editAgent", {
            tokensIn: 1200,
            tokensOut: 340,
            cachedTokens: 800,
            cacheCreationInputTokens: 120,
            reasoningTokens: 90,
            toolTokens: 12,
            acceptedPredictionTokens: 7,
            rejectedPredictionTokens: 3,
            systemPromptTokens: 500,
            reservedOutputTokens: 4096,
            totalTokenMax: 128000,
            sawUsageDataPart: true,
            estimatedInputCost: 0.0012,
            estimatedOutputCost: 0.0034,
            estimatedTotalCost: 0.0046,
        });

        const message = lastMessage();
        assert.ok(message.includes("request_id=req-1"));
        assert.ok(message.includes("model=gpt-5.4"));
        assert.ok(message.includes("caller=panel/editAgent"));
        assert.ok(message.includes("tokens_in=1200"));
        assert.ok(message.includes("tokens_out=340"));
        assert.ok(message.includes("cached_tokens=800"));
        assert.ok(message.includes("cache_creation_input_tokens=120"));
        assert.ok(message.includes("reasoning_tokens=90"));
        assert.ok(message.includes("tool_tokens=12"));
        assert.ok(message.includes("accepted_prediction_tokens=7"));
        assert.ok(message.includes("rejected_prediction_tokens=3"));
        assert.ok(message.includes("system_prompt_tokens=500"));
        assert.ok(message.includes("reserved_output_tokens=4096"));
        assert.ok(message.includes("total_token_max=128000"));
        assert.ok(message.includes("streamed_usage=true"));
        assert.ok(message.includes("estimated_input_cost=0.0012"));
        assert.ok(message.includes("estimated_output_cost=0.0034"));
        assert.ok(message.includes("estimated_total_cost=0.0046"));
    });

    test("prints n/a for counters the gateway did not send", () => {
        logFinalUsageEnvelope("req-2", "gpt-5.4", "chat", { sawUsageDataPart: false });

        const message = lastMessage();
        assert.ok(message.includes("tokens_in=n/a"));
        assert.ok(message.includes("cached_tokens=n/a"));
        assert.ok(message.includes("estimated_total_cost=n/a"));
        assert.ok(message.includes("streamed_usage=false"));
    });
});
