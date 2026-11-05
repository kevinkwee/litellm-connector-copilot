import * as assert from "assert";

import { isReasoningEffortRejection, rejectsReasoningEffortParameter } from "../proxyParameterRejection";

suite("isReasoningEffortRejection", () => {
    test("recognizes the Anthropic unmapped-effort message", () => {
        assert.ok(
            isReasoningEffortRejection(
                "Unmapped reasoning effort: 'ultra'. Must be one of: 'minimal', 'low', 'medium', 'high'."
            )
        );
    });

    test("recognizes the Anthropic effort='level' refusal", () => {
        assert.ok(
            isReasoningEffortRejection("effort='xhigh' is not supported by this model. Got model: claude-opus-5")
        );
    });

    test("recognizes the Responses spelling", () => {
        assert.ok(isReasoningEffortRejection("Unsupported value: 'xhigh' for 'reasoning.effort'"));
    });

    test("recognizes the flat parameter rejection", () => {
        assert.ok(isReasoningEffortRejection("Unsupported parameter: reasoning_effort"));
    });

    test("recognizes Azure's does-not-support-effort wording", () => {
        // litellm/llms/azure/chat/gpt_5_transformation.py
        assert.ok(
            isReasoningEffortRejection(
                "Azure OpenAI does not support reasoning_effort='none' for this model. Supported values are: 'low', 'medium', and 'high'."
            )
        );
    });

    test("recognizes Bedrock Nova's invalid-effort wording", () => {
        // litellm/llms/bedrock/chat/converse_transformation.py
        assert.ok(isReasoningEffortRejection("Invalid reasoning_effort value 'xhigh' for Nova 2 models."));
    });

    test("recognizes Gemini's invalid-effort wording", () => {
        // litellm/llms/vertex_ai/gemini/vertex_and_google_ai_studio_gemini.py
        assert.ok(isReasoningEffortRejection("Invalid reasoning effort: max"));
    });

    test("recognizes the flat OpenAI wording", () => {
        assert.ok(isReasoningEffortRejection("reasoning_effort=xhigh is not supported for this model."));
    });

    test("recognizes the camelCase spelling", () => {
        assert.ok(isReasoningEffortRejection("Unsupported value: 'xhigh' for parameter reasoningEffort"));
    });

    test("rejects a body that names the effort without refusing an input", () => {
        // A rejection body can echo the prompt, and a conversation about the proxy
        // config mentions `reasoning_effort` routinely.
        assert.strictEqual(
            isReasoningEffortRejection(
                '{"error":{"message":"maximum context length exceeded"},"echo":{"prompt":"what does reasoning_effort do?"}}'
            ),
            false
        );
    });

    test("rejects a refusal of reasoning_content", () => {
        assert.strictEqual(
            isReasoningEffortRejection("Invalid parameter: reasoning_content must be passed back to the API"),
            false
        );
    });

    test("rejects a refusal of reasoning items", () => {
        assert.strictEqual(isReasoningEffortRejection("Unsupported parameter: reasoning items"), false);
    });

    test("rejects an empty body", () => {
        assert.strictEqual(isReasoningEffortRejection(""), false);
    });
});

suite("rejectsReasoningEffortParameter", () => {
    test("treats a refused reasoning_effort parameter as a whole-parameter rejection", () => {
        assert.strictEqual(rejectsReasoningEffortParameter("Unsupported parameter: reasoning_effort"), true);
    });

    test("does not treat a refused reasoning.effort value as a whole-parameter rejection", () => {
        assert.strictEqual(rejectsReasoningEffortParameter("Unsupported value: 'xhigh' for 'reasoning.effort'"), false);
    });
});
