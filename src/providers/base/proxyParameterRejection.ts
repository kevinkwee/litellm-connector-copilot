import { isUnsupportedParameterError, findRejectedParameter } from "../../adapters/litellmClient";

/**
 * Wordings a provider uses when it refuses the reasoning-effort input it was sent.
 *
 * The name-anchored phrases bind the refusal to the name, and each comes from a
 * message the LiteLLM fork produces: Azure's "does not support reasoning_effort='none'"
 * (`llms/azure/chat/gpt_5_transformation.py`), Bedrock Nova 2's "Invalid
 * reasoning_effort value" (`llms/bedrock/chat/converse_transformation.py`), Gemini's
 * "Invalid reasoning effort: max"
 * (`llms/vertex_ai/gemini/vertex_and_google_ai_studio_gemini.py`), and the Anthropic
 * map's "Unmapped reasoning effort: ..."
 * (`llms/anthropic/chat/transformation.py`).
 *
 * `is not supported` and `unsupported value` are the generic refusal text Anthropic
 * and OpenAI use for any rejected input. They do not bind the refusal to the name, so
 * a body that echoes both can still qualify; see `isReasoningEffortRejection`.
 */
const EFFORT_REFUSAL_PHRASES: readonly string[] = [
    "does not support reasoning_effort",
    "invalid reasoning_effort",
    "invalid reasoning effort",
    "unmapped reasoning effort",
    "is not supported",
    "unsupported value",
];

/** Spellings a rejection body uses for the reasoning-effort input. */
const EFFORT_INPUT_NAMES: readonly string[] = [
    "reasoning_effort",
    "reasoning effort",
    "reasoning.effort",
    "effort='",
    "reasoningeffort",
];

/**
 * True when a rejection body both names the reasoning-effort input and says it
 * refused an input.
 *
 * The name alone is not enough: a rejection body can echo the prompt, and a
 * conversation about the connector or the proxy config mentions
 * `reasoning_effort` routinely. The two halves are matched independently in the
 * body, so a body that echoes the effort name beside a rejection of a different
 * parameter also qualifies here; `describeTurnFailure` prefers the specific
 * parameter when `findRejectedParameter` names one that is not an effort spelling.
 *
 * The spellings are the ones providers actually produce: flat
 * (`reasoning_effort`) on chat completions, `reasoning.effort` on `/responses`,
 * `reasoningEffort` on the providers that take camelCase (lowercased before
 * matching), `effort='x'` in the Anthropic transformation's own message, and
 * "reasoning effort" in LiteLLM's Anthropic map when it cannot map a level.
 */
export function isReasoningEffortRejection(bodyText: string): boolean {
    const lowered = bodyText.toLowerCase();
    if (!lowered) {
        return false;
    }
    const namesEffort = EFFORT_INPUT_NAMES.some((name) => lowered.includes(name));
    if (!namesEffort) {
        return false;
    }
    return isUnsupportedParameterError(lowered) || EFFORT_REFUSAL_PHRASES.some((phrase) => lowered.includes(phrase));
}

/**
 * True when a rejection refuses the reasoning-effort parameter itself rather than
 * one level of it. No level change fixes that, and every request carrying
 * `reasoning_effort` is refused, so the model has to stop declaring reasoning and
 * stop declaring effort levels.
 */
export function rejectsReasoningEffortParameter(bodyText: string): boolean {
    const named = findRejectedParameter(bodyText);
    return named !== undefined && EFFORT_INPUT_NAMES.some((name) => named.toLowerCase().includes(name));
}
