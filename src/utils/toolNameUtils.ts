import { Logger } from "./logger";
import { StructuredLogger } from "../observability/structuredLogger";

/**
 * Maximum length of a tool function name on the wire.
 *
 * AWS Bedrock enforces a 64-character limit on the `toolUse.name` field, so
 * every name this module produces fits within it.
 */
export const TOOL_NAME_MAX_LENGTH = 64;

/** Names the wire accepts unchanged: a letter, then up to 63 letters, digits, hyphens, or underscores. */
const VALID_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * How the declared tool names relate to the names the request advertises.
 *
 * A request advertises sanitized, deduplicated names, so a model's call carries
 * a wire name while VS Code resolves the call by the name it declared. The
 * response path needs wire to declared, and history replay needs declared to wire.
 * Both directions come from one list so they cannot disagree.
 */
export interface ToolNameMapping {
    /** The advertised name of every declared tool, in declaration order. */
    readonly wireNames: readonly string[];
    /** Wire names that differ from the declared spelling, keyed by wire name. */
    readonly wireToDeclared: ReadonlyMap<string, string>;
    /** Every declared name that travels under a different wire name. */
    readonly declaredToWire: ReadonlyMap<string, string>;
}

export const EMPTY_TOOL_NAME_MAPPING: ToolNameMapping = {
    wireNames: [],
    wireToDeclared: new Map(),
    declaredToWire: new Map(),
};

/**
 * Sanitizes a tool function name so every endpoint accepts it.
 *
 * A name the wire already accepts passes through unchanged, which keeps names
 * such as `github__create_issue` distinct from `github_create_issue`. Any other
 * name has its invalid characters replaced with `_`, gains a `tool_` prefix when
 * it does not start with a letter, and is truncated to the Bedrock Converse API
 * limit of 64 characters. Repeated underscores are preserved: collapsing them
 * would merge two declared tools into one name.
 *
 * Applied wherever a declared or model-supplied name becomes a wire name: the
 * `tools` schema conversion, the streaming interpreter's read of a model's call,
 * and the replay of a tool call the map does not name.
 *
 * @param name Tool function name to sanitize. Non-string values and the empty
 *        string become `"tool"`.
 */
export function sanitizeToolName(name: unknown): string {
    if (typeof name !== "string" || !name) {
        return "tool";
    }

    if (VALID_TOOL_NAME.test(name)) {
        Logger.trace("[sanitizeToolName]", { name, length: name.length });
        return name;
    }

    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = `tool_${sanitized}`;
    }

    if (sanitized.length > TOOL_NAME_MAX_LENGTH) {
        const truncated = sanitized.slice(0, TOOL_NAME_MAX_LENGTH);
        StructuredLogger.warn("stream.tool_name_truncated", {
            name,
            originalLength: name.length,
            sanitizedLength: truncated.length,
        });
        return truncated;
    }

    Logger.trace("[sanitizeToolName]", { name, sanitized, length: name.length });
    return sanitized;
}

/**
 * Derives the advertised name of every declared tool, in declaration order.
 *
 * Two declared names can sanitize to the same wire name, either because their
 * differing characters were both replaced or because both truncate to the same
 * 64 characters. A duplicate would let a model call resolve to whichever tool
 * came last, so the later tool receives a numeric suffix and the collision is
 * logged.
 */
export function deriveWireToolNames(declaredTools: readonly { name: string }[]): string[] {
    const used = new Set<string>();
    const wireNames: string[] = [];
    for (const tool of declaredTools) {
        const sanitized = sanitizeToolName(tool.name);
        let candidate = sanitized;
        let suffix = 2;
        while (used.has(candidate)) {
            const suffixText = `_${suffix}`;
            candidate = `${sanitized.slice(0, TOOL_NAME_MAX_LENGTH - suffixText.length)}${suffixText}`;
            suffix += 1;
        }
        if (candidate !== sanitized) {
            StructuredLogger.warn("tools.name_collision", { wireName: candidate, sanitizedName: sanitized });
        }
        used.add(candidate);
        wireNames.push(candidate);
    }
    return wireNames;
}

/**
 * Builds both directions of the declared-to-wire mapping for one request.
 *
 * Only names the sanitation or the dedupe changed are recorded, so a lookup
 * falls through to the model's own spelling for every ordinary tool.
 */
export function buildToolNameMapping(declaredTools: readonly { name: string }[]): ToolNameMapping {
    const wireNames = deriveWireToolNames(declaredTools);
    const wireToDeclared = new Map<string, string>();
    const declaredToWire = new Map<string, string>();
    declaredTools.forEach((tool, index) => {
        const wireName = wireNames[index];
        if (wireName !== tool.name) {
            wireToDeclared.set(wireName, tool.name);
            declaredToWire.set(tool.name, wireName);
        }
    });
    return { wireNames, wireToDeclared, declaredToWire };
}
