import { Logger } from "./logger";
import { StructuredLogger } from "../observability/structuredLogger";

/**
 * Maximum allowed length for tool function names in the Bedrock Converse API.
 *
 * AWS Bedrock enforces a 64-character limit on the toolUse.name field.
 * This constant is exposed for use at the outbound boundary where tool names
 * are emitted: the streaming interpreter.
 */
export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * Result of sanitizing a tool function name to comply with Bedrock's 64-char limit.
 *
 * Only locally named tools (caller-declared) should use this during the `tools`
 * schema conversion in `convertTools`.
 */
export interface SanitizedToolName {
    /**
     * The sanitized name, guaranteed to be ≤64 characters.
     */
    name: string;
    /**
     * Whether the name was actually changed due to exceeding the length limit.
     * True only when `originalLength > TOOL_NAME_MAX_LENGTH`.
     */
    wasTruncated: boolean;
}

/**
 * Sanitizes and truncates a tool function name to comply with AWS Bedrock's 64-character limit.
 *
 * This function is applied at the outbound boundary where tool names are emitted:
 * **streaming interpreter** (`src/adapters/streaming/liteLLMStreamInterpreter.ts`):
 *    - `state.toolCallBuffers` initialization (OpenAI format)
 *    - `state.responseToolCallBuffers` updates (output_item.delta)
 *    - `state.responseToolCallBuffers` updates (output_tool_call.*)
 *    - `state.anonymousResponseToolName` updates
 *
 * **Goal**: Prevent `litellm.BadRequestError` for Bedrock Converse API failures when
 *       a tool name exceeds the 64-character limit.
 *
 * **Side Effects**: Emits a structured warning log so that we can diagnose
 *       whether the long name originated from the model or from caller-declared `tools`.
 *
 * @param name - Tool function name to sanitize. Must be a string; non-string values
 *        are normalized to `"tool"` and treated as not truncated.
 * @returns A `SanitizedToolName` with the length-bounded name and an indicator
 *        of whether truncation actually occurred.
 *
 * **Logging**: When `name` is a string longer than 64 characters, a warning is emitted
 *       via `StructuredLogger.warn` with key `stream.tool_name_truncated` and a
 *       structured payload including `originalLength`, `sanitizedLength`, and `source`.
 */
export function sanitizeToolName(name: unknown): SanitizedToolName {
    if (typeof name !== "string" || !name) {
        return { name: "tool", wasTruncated: false };
    }

    const originalLength = name.length;
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = `tool_${sanitized}`;
    }
    sanitized = sanitized.replace(/_+/g, "_");

    // Always enforce the 64-char limit; the Bedrock Converse API will reject longer names.
    const matched = sanitized.match(/^.{1,64}$/);
    if (!matched) {
        // Name exceeds limit: truncate to exactly 64 characters.
        const truncated = sanitized.slice(0, TOOL_NAME_MAX_LENGTH);

        // Emit a structured warning with diagnostic context on truncation origin.
        logToolNameTruncationStructured({
            originalName: name,
            source: "unknown",
            data: {
                originalLength,
                sanitizedLength: truncated.length,
                endpoint: undefined,
            },
        });

        // Return a truncated result; the log above provides diagnostic context.
        return { name: truncated, wasTruncated: true };
    }

    // Name is within limit: no truncation needed.
    // Emit a trace-level log to confirm we passed through this boundary without issues.
    Logger.trace("[sanitizeToolName]", { name, length: originalLength });

    return { name: sanitized, wasTruncated: false };
}

/**
 * Structured logging for tool name truncation.
 *
 * Uses the `StructuredLogger.warn` API, which emits a JSONL entry with log key `stream.tool_name_truncated`
 * on the "LiteLLM Structured" output channel.
 */
export function logToolNameTruncationStructured(args: {
    originalName: string;
    /** Override/confirm the origin label recorded in the log payload */
    source: string;
    /** Optional: Additional context structure (recommended over arbitrary extra logs) */
    data?: {
        originalLength: number;
        sanitizedLength: number;
        endpoint?: string;
    };
}): void {
    if (!args.data) {
        args.data = {
            originalLength: args.originalName.length,
            sanitizedLength: 0,
            endpoint: undefined,
        };
    }

    StructuredLogger.warn("stream.tool_name_truncated", {
        name: args.originalName,
        source: args.source,
        ...args.data,
    });
}
