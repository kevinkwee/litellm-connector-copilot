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
import { PostHogHook } from "./observability/posthogHook";
import { TelemetryService } from "./telemetry/telemetryService";
import { LiteLLMTelemetry } from "./utils/telemetry";
import { setTelemetryService as setTokenUtilsTelemetryService } from "./adapters/tokenUtils";
import { EffortFallbackCache } from "./utils/reasoningEffortFallback";
import { registerOpenCopilotMdFolderCommand } from "./commands/openCopilotMdFolder";

let configManagerInstance: ConfigManager | undefined;
let telemetryServiceInstance: TelemetryService | undefined;
let activeChatProviderInstance: LiteLLMChatProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
    // Initialize telemetry first so logger can use it
    telemetryServiceInstance = new TelemetryService();
    const telemetryService = telemetryServiceInstance;
    telemetryService.initialize(context);
    context.subscriptions.push(telemetryService);

    Logger.initialize(context, telemetryService);
    Logger.info("Activating extension...");

    // Bridge to static telemetry class
    LiteLLMTelemetry.setTelemetryService(telemetryService);

    // Bridge to token utils
    setTokenUtilsTelemetryService(telemetryService);

    StructuredLogger.initialize(context);

    // Initialize the .copilotmd export manager. Reads
    // `litellm-connector.debug.copilotMdExport.*` settings on each export so
    // users can toggle the feature and adjust caps without reloading.
    CopilotMdManager.initialize(context);

    const postHogHook = new PostHogHook(telemetryService);
    postHogHook.initialize();
    context.subscriptions.push(postHogHook);

    // Scoped unhandled exception capture (Extension-specific)
    const uncaughtExceptionListener = (error: Error) => {
        if (error?.stack?.includes("litellm-connector-copilot") || error?.stack?.includes("litellm-connector")) {
            telemetryService.captureException(error, {
                caller: "uncaughtException",
                level: "error",
            });
        }
    };

    const unhandledRejectionListener = (reason: unknown) => {
        if (
            reason instanceof Error &&
            (reason?.stack?.includes("litellm-connector-copilot") || reason?.stack?.includes("litellm-connector"))
        ) {
            telemetryService.captureException(reason, {
                caller: "unhandledRejection",
                level: "error",
            });
        }
    };

    process.on("uncaughtException", uncaughtExceptionListener);
    process.on("unhandledRejection", unhandledRejectionListener);

    // Cleanup listeners on deactivation
    context.subscriptions.push({
        dispose: () => {
            process.off("uncaughtException", uncaughtExceptionListener);
            process.off("unhandledRejection", unhandledRejectionListener);
        },
    });

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

        // Capture activation
        telemetryService.captureExtensionActivated(extVersion, vscodeVersionStr);
    } catch (uaErr) {
        Logger.error("Failed to build UA", uaErr);
    }

    Logger.info(`UA: ${ua}`);

    configManagerInstance = new ConfigManager(context.secrets);
    const configManager = configManagerInstance;
    configManager.setTelemetryService(telemetryService);

    const effortFallbackCache = new EffortFallbackCache();

    // Track feature adoption
    telemetryService.captureFeatureAdoption("chat");
    telemetryService.captureFeatureAdoption("commit-generation");
    telemetryService.captureFeatureAdoption("model-picker");

    // Emit feature usage snapshot after config is loaded
    void configManager.getConfig().then((config) => {
        telemetryService.captureFeatureUsageSnapshot({
            "commit-message": !!(config.commitModelIdOverride && config.commitModelIdOverride.length > 0),
            caching: !config.disableCaching,
            "quota-tool-redaction": !config.disableQuotaToolRedaction,
        });
    });

    // VS Code 1.120+ uses the unified chat provider with per-group configuration support.

    const activeProvider = new LiteLLMChatProvider(context.secrets, ua, effortFallbackCache);
    activeChatProviderInstance = activeProvider; // Store for cleanup on deactivation
    activeProvider.setTelemetryService(telemetryService);

    // Commit message provider (version-agnostic)
    const commitProvider = new LiteLLMCommitMessageProvider(context.secrets, ua, effortFallbackCache);
    commitProvider.setTelemetryService(telemetryService);

    // Track active provider registration for hot-swap
    let chatProviderRegistration: vscode.Disposable | undefined;

    const registerProvider = () => {
        try {
            if (chatProviderRegistration) {
                Logger.info("Disposing existing LanguageModelChatProvider registration...");
                chatProviderRegistration.dispose();
                chatProviderRegistration = undefined;
            }

            Logger.info("Registering LanguageModelChatProvider...");
            chatProviderRegistration = vscode.lm.registerLanguageModelChatProvider(
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
    };

    // Register provider and commands immediately (do not await config)
    registerProvider();

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
        context.subscriptions.push(
            registerManageConfigCommand(context, configManager, activeProvider, telemetryService)
        );
        context.subscriptions.push(registerResetConfigurationCommand(context, configManager, telemetryService));
        context.subscriptions.push(registerShowModelsCommand(activeProvider, telemetryService));
        context.subscriptions.push(registerReloadModelsCommand(activeProvider, telemetryService));
        context.subscriptions.push(registerGenerateCommitMessageCommand(commitProvider, telemetryService));
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
    if (telemetryServiceInstance) {
        // Use shutdown() instead of dispose() for proper async cleanup
        await telemetryServiceInstance.shutdown();
        telemetryServiceInstance.dispose();
    }
}
