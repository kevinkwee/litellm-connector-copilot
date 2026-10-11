import * as vscode from "vscode";
import { LiteLLMChatProvider } from "./providers";
import { ConfigManager } from "./config/configManager";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerResetConfigurationCommand,
    registerShowModelsCommand,
} from "./commands/manageConfig";
import { registerGenerateCommitMessageCommand } from "./commands/generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "./providers/liteLLMCommitProvider";
import { Logger } from "./utils/logger";
import { StructuredLogger, CopilotMdManager } from "./observability";
import { EffortFallbackCache } from "./utils/reasoningEffortFallback";
import { registerOpenCopilotMdFolderCommand } from "./commands/openCopilotMdFolder";

let configManagerInstance: ConfigManager | undefined;
let activeChatProviderInstance: LiteLLMChatProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
    Logger.initialize(context);
    Logger.info("Activating extension...");

    StructuredLogger.initialize(context);

    // Initialize the .copilotmd export manager. Reads
    // `litellm-connector.debug.copilotMdExport.*` settings on each export so
    // users can toggle the feature and adjust caps without reloading.
    CopilotMdManager.initialize(context);

    let ua = "litellm-vscode-chat/unknown VSCode/unknown";
    try {
        // Build a descriptive User-Agent to help quantify API usage
        const ext = vscode.extensions.getExtension("GethNet.litellm-connector-copilot");
        Logger.debug(`Extension object found: ${!!ext}`);
        // Safely extract version with proper type guard
        let extVersion = "unknown";
        if (ext && typeof ext.packageJSON === "object" && ext.packageJSON !== null && "version" in ext.packageJSON) {
            const v = (ext.packageJSON as Record<string, unknown>).version;
            extVersion = typeof v === "string" ? v : "unknown";
        }
        // Keep UA minimal: only extension version and VS Code version
        const vscodeVersionStr = typeof vscode.version === "string" ? vscode.version : "unknown";
        ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersionStr}`;
    } catch (uaErr) {
        Logger.error("Failed to build UA", uaErr);
    }

    Logger.info(`UA: ${ua}`);

    configManagerInstance = new ConfigManager(context.secrets);
    const configManager = configManagerInstance;

    const effortFallbackCache = new EffortFallbackCache();

    // VS Code 1.120+ uses the unified chat provider with per-group configuration support.

    const activeProvider = new LiteLLMChatProvider(context.secrets, ua, effortFallbackCache);
    activeChatProviderInstance = activeProvider; // Store for cleanup on deactivation

    // Commit message provider (version-agnostic)
    const commitProvider = new LiteLLMCommitMessageProvider(context.secrets, ua, effortFallbackCache);

    // Register provider immediately (do not await config)
    try {
        Logger.info("Registering LanguageModelChatProvider...");
        const chatProviderRegistration = vscode.lm.registerLanguageModelChatProvider(
            "litellm-connector",
            activeProvider as unknown as vscode.LanguageModelChatProvider
        );
        if (chatProviderRegistration) {
            context.subscriptions.push(chatProviderRegistration);
            Logger.info("Provider registered successfully.");
        } else {
            Logger.error("registerLanguageModelChatProvider returned undefined/null");
        }
    } catch (err) {
        Logger.error("Failed to register provider", err);
    }

    // Proactively nudge VS Code to call provideLanguageModelChatInformation immediately after
    // registration.  Without this, model discovery (and reasoning-effort schema population) is
    // deferred until the user first opens the model picker.  Firing the change event right after
    // registration causes VS Code to eagerly re-query the provider — this time with the correct
    // per-group options.configuration values, so reasoning capabilities populate on first load.
    setImmediate(() => {
        Logger.info("Post-registration: nudging VS Code to refresh model information...");
        activeProvider.refreshModelInformation();
    });

    // Re-query models after settings updates so newly completed Language Models provider
    // configuration flows are reflected without requiring a reload.
    let refreshModelsTimer: NodeJS.Timeout | undefined;
    const refreshModelInformation = () => {
        if (refreshModelsTimer) {
            clearTimeout(refreshModelsTimer);
        }
        refreshModelsTimer = setTimeout(() => {
            refreshModelsTimer = undefined;
            Logger.info("Configuration changed; refreshing model information...");
            activeProvider.refreshModelInformation();
        }, 250);
    };
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            // Only refresh when LiteLM-specific settings change, not generic provider config
            // (e.affectsConfiguration) returns true for the top-level "litellm-connector.*" path
            if (
                e.affectsConfiguration("litellm-connector.modelOverrides") ||
                e.affectsConfiguration("litellm-connector.backendGroups")
            ) {
                refreshModelInformation();
            }
        })
    );
    context.subscriptions.push({
        dispose: () => {
            if (refreshModelsTimer) {
                clearTimeout(refreshModelsTimer);
                refreshModelsTimer = undefined;
            }
        },
    });

    try {
        context.subscriptions.push(registerManageConfigCommand(context, configManager, activeProvider));
        context.subscriptions.push(registerResetConfigurationCommand(context, configManager));
        context.subscriptions.push(registerShowModelsCommand(activeProvider));
        context.subscriptions.push(registerReloadModelsCommand(activeProvider));
        context.subscriptions.push(registerGenerateCommitMessageCommand(commitProvider));
        context.subscriptions.push(registerOpenCopilotMdFolderCommand());
        Logger.info("Config command registered.");
    } catch (cmdErr) {
        Logger.error("Failed to register commands", cmdErr);
    }
}

export async function deactivate(): Promise<void> {
    // Clean up session-scoped caches to free memory
    if (activeChatProviderInstance) {
        activeChatProviderInstance.clearSessionCaches();
    }

    if (configManagerInstance) {
        await configManagerInstance.dispose();
    }
}
