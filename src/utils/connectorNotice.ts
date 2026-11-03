import type { DroppedToolCall } from "../types";

/**
 * Prefix that marks text the connector writes into a response itself, such as a
 * failure explanation or a stop notice. It keeps those messages distinguishable
 * from model output.
 */
export const CONNECTOR_NOTICE_PREFIX = "[litellm-connector]";

/**
 * Returns the prefixed notice without a leading blank line. A caller that appends
 * it to streamed text prepends `"\n\n"` so the notice starts its own block instead
 * of reading as part of the model's sentence.
 */
export function formatConnectorNotice(message: string): string {
    return `${CONNECTOR_NOTICE_PREFIX} ${message}`;
}

/**
 * Returns the notice that explains tool calls the connector dropped because their
 * arguments could not be parsed. The notice already starts with the blank line that
 * puts it in its own block, so a caller must not prepend another.
 */
export function describeDroppedToolCalls(calls: readonly DroppedToolCall[]): string {
    const names = [...new Set(calls.map((call) => call.name))];
    const subject =
        names.length === 1 ? `the "${names[0]}" tool` : `the ${names.map((name) => `"${name}"`).join(", ")} tools`;
    const outcome = names.length === 1 ? "was not run" : "were not run";
    const count = calls.length === 1 ? "a tool call" : `${calls.length} tool calls`;
    return (
        "\n\n" +
        formatConnectorNotice(
            `The model returned ${count} whose arguments could not be read, so ${subject} ${outcome}.`
        )
    );
}

/**
 * Returns the finish reason and the notice that explains an incomplete answer, or
 * `undefined` for a reason that needs none. The notice already starts with the
 * blank line that puts it in its own block, so a caller must not prepend another.
 */
export function describeStoppedEarly(reason: string | undefined): { reason: string; notice: string } | undefined {
    if (reason === "length") {
        return {
            reason,
            notice:
                "\n\n" +
                formatConnectorNotice(
                    "The response stopped at the model's output token limit, so it is incomplete. " +
                        "Raise the model's max output tokens, or ask it to continue."
                ),
        };
    }
    if (reason === "content_filter") {
        return {
            reason,
            notice:
                "\n\n" +
                formatConnectorNotice(
                    "The provider's content filter ended the response early; part of the answer was withheld."
                ),
        };
    }
    return undefined;
}
