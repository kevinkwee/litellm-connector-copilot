import { LanguageModelChatMessageRole } from "vscode";

/**
 * Converts a LanguageModelChatMessageRole to its string representation.
 */
export function lmcr_toString(role: LanguageModelChatMessageRole): string {
    // Use string comparison if possible, or fall back to numeric comparison
    // User = 1, Assistant = 2, System = 3
    if (role === LanguageModelChatMessageRole.User || (role as number) === 1) {
        return "user";
    }
    if (role === LanguageModelChatMessageRole.Assistant || (role as number) === 2) {
        return "assistant";
    }

    // Check for System role (Proposed API: languageModelSystem)
    // We use the numeric value 3 as the primary check to avoid compiler errors
    // when the proposed enum member is missing from the stable vscode namespace.
    if ((role as number) === 3) {
        return "system";
    }

    // Default to system for everything else
    return "system";
}
