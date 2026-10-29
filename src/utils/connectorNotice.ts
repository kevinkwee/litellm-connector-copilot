/**
 * Prefix that marks text the connector writes into a response itself, such as a
 * failure explanation or a stop notice. It keeps those messages distinguishable
 * from model output.
 *
 * A notice that follows model output must start a new block. Append it as
 * `"\n\n" + formatConnectorNotice(...)` so the notice never reads as part of
 * the model's sentence.
 */
export const CONNECTOR_NOTICE_PREFIX = "[litellm-connector]";

export function formatConnectorNotice(message: string): string {
    return `${CONNECTOR_NOTICE_PREFIX} ${message}`;
}
