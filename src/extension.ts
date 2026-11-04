import * as vscode from "vscode";
import { LiteLLMChatProvider } from "./providers";
import { ActiveRequestRegistry } from "./providers/activeRequests";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
} from "./commands/manageConfig";
import { Logger } from "./utils/logger";
import { StructuredLogger, CopilotMdManager } from "./observability";
import { EffortFallbackCache } from "./utils/reasoningEffortFallback";
import { registerOpenCopilotMdFolderCommand } from "./commands/openCopilotMdFolder";
import { registerCancelActiveRequestCommand } from "./commands/cancelActiveRequest";

/** Vendor id this extension registers and lists its models under. */
export const LITELLM_VENDOR = "litellm-connector";

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

    const effortFallbackCache = new EffortFallbackCache();
    const activeRequests = new ActiveRequestRegistry();

    const activeProvider = new LiteLLMChatProvider(ua, effortFallbackCache, activeRequests);
    activeChatProviderInstance = activeProvider; // Store for cleanup on deactivation

    // Register provider immediately (do not await config)
    try {
        Logger.info("Registering LanguageModelChatProvider...");
        const chatProviderRegistration = vscode.lm.registerLanguageModelChatProvider(
            LITELLM_VENDOR,
            activeProvider as unknown as vscode.LanguageModelChatProvider
        );
        if (chatProviderRegistration) {
            context.subscriptions.push(chatProviderRegistration);
            // Pushed after the registration so VS Code disposes the registration
            // before the provider that serves it, since subscriptions dispose in
            // insertion order.
            context.subscriptions.push(activeProvider);
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
    // registration causes VS Code to eagerly re-query the provider, this time with the correct
    // per-group options.configuration values, so reasoning capabilities populate on first load.
    setImmediate(() => {
        Logger.info("Post-registration: nudging VS Code to refresh model information...");
        activeProvider.refreshModelInformation();
    });

    // Re-query models when a workspace setting that shapes discovery changes, so the
    // picker reflects it without the user running Reload Models. Only those settings
    // are watched. Anything else would clear the response cache and re-fetch every
    // backend for nothing.
    const discoveryShapingSettings = [
        "litellm-connector.modelOverrides",
        "litellm-connector.enableModelOverrides",
        "litellm-connector.modelCapabilitiesOverrides",
        "litellm-connector.displayPricingInPicker",
        "litellm-connector.forceResponsesEndpoint",
    ];
    let refreshModelsTimer: NodeJS.Timeout | undefined;
    const refreshModelInformation = () => {
        if (refreshModelsTimer) {
            clearTimeout(refreshModelsTimer);
        }
        refreshModelsTimer = setTimeout(() => {
            refreshModelsTimer = undefined;
            Logger.info("Configuration changed; refreshing model information...");
            activeProvider.reloadModelDiscovery();
        }, 250);
    };
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (discoveryShapingSettings.some((setting) => e.affectsConfiguration(setting))) {
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
        context.subscriptions.push(registerManageConfigCommand());
        context.subscriptions.push(
            registerShowModelsCommand(() => vscode.lm.selectChatModels({ vendor: LITELLM_VENDOR }))
        );
        context.subscriptions.push(registerReloadModelsCommand(activeProvider));
        context.subscriptions.push(registerOpenCopilotMdFolderCommand());
        context.subscriptions.push(registerCancelActiveRequestCommand(activeRequests));
        Logger.info("Config command registered.");
    } catch (cmdErr) {
        Logger.error("Failed to register commands", cmdErr);
    }
}

export async function deactivate(): Promise<void> {
    if (activeChatProviderInstance) {
        activeChatProviderInstance.clearSessionCaches();
    }
}
