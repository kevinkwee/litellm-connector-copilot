/**
 * Prefix that marks text the connector writes into a response itself, such as a
 * failure explanation or a stop notice. It keeps those messages distinguishable
 * from model output, so a consumer that treats response text as data (commit
 * message generation) never mistakes a notice for generated content.
 *
 * A notice that follows model output must start a new block: append it as
 * `"\n\n" + formatConnectorNotice(...)`. `splitConnectorNotice` recognises the
 * prefix only at the start of the response or after a blank line, because model
 * text may legitimately mention the prefix mid-sentence.
 */
export const CONNECTOR_NOTICE_PREFIX = "[litellm-connector]";

export function formatConnectorNotice(message: string): string {
    return `${CONNECTOR_NOTICE_PREFIX} ${message}`;
}

export interface SplitConnectorNotice {
    /** Response text before the first notice. */
    readonly modelText: string;
    /** Notice text after the prefix, or undefined when the response has none. */
    readonly notice?: string;
}

/**
 * Splits response text at the first connector notice. A notice can follow model
 * output (a failure or a stop reason after a partial answer), so callers that
 * treat the text as data must scan the whole value, not just its start.
 *
 * A notice always begins the response or a new block, so the prefix only counts
 * at the start or after a blank line; text that merely mentions the prefix
 * mid-sentence stays model output.
 */
export function splitConnectorNotice(text: string): SplitConnectorNotice {
    const afterBlankLine = text.indexOf(`\n\n${CONNECTOR_NOTICE_PREFIX}`);
    const atStart = text.startsWith(CONNECTOR_NOTICE_PREFIX);
    if (!atStart && afterBlankLine < 0) {
        return { modelText: text };
    }
    const index = atStart ? 0 : afterBlankLine + 2;
    return {
        modelText: text.slice(0, index).trimEnd(),
        notice: text.slice(index + CONNECTOR_NOTICE_PREFIX.length).trim(),
    };
}
