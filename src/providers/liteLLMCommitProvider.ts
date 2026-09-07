import type * as vscode from "vscode";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import type { EffortFallbackCache } from "../utils/reasoningEffortFallback";

/**
 * Provider backing the git commit-message command.
 *
 * The command itself routes generation through VS Code's model request API
 * (`vscode.lm.selectChatModels` -> `sendRequest`), which calls back into the
 * registered chat provider with the per-group configuration attached. This
 * class therefore carries no request logic of its own: it exists so the
 * command can read the commit-model override, registry-backed model info,
 * and config through the shared base instead of reaching around it.
 */
export class LiteLLMCommitMessageProvider extends LiteLLMProviderBase {
    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }
}
