import * as vscode from "vscode";
import type { LiteLLMChatProvider } from "../providers";

/**
 * Registers the command that points users at VS Code's Language Models view,
 * where LiteLLM provider groups are configured.
 */
export function registerManageConfigCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.manage", async () => {
        const openLanguageModels = "Open Language Models";
        const choice = await vscode.window.showInformationMessage(
            "LiteLLM Connector is now configured through VS Code's Language Models view. " +
                'Use "Add Model..." to add or edit a LiteLLM provider.',
            openLanguageModels
        );

        if (choice !== openLanguageModels) {
            return;
        }

        try {
            await vscode.commands.executeCommand("workbench.action.chat.manage");
        } catch {
            // Fallback for builds where the chat management command is unavailable.
            await vscode.commands.executeCommand("workbench.action.openSettings", "@tag:language-model");
        }
    });
}

export function registerShowModelsCommand(
    listModels: () => Thenable<readonly vscode.LanguageModelChat[]>
): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.showModels", async () => {
        // Ask VS Code for its current list rather than replaying a cached one, so
        // the command cannot describe models VS Code no longer holds.
        const models = await listModels();
        if (!models.length) {
            vscode.window.showInformationMessage(
                "No LiteLLM models are available. Add a LiteLLM provider in the Language Models view, or run 'LiteLLM: Reload Models'."
            );
            return;
        }

        type ModelQuickPickItem = vscode.QuickPickItem & { modelId: string };

        const picked = await vscode.window.showQuickPick(
            models
                .slice()
                .sort((a: vscode.LanguageModelChat, b: vscode.LanguageModelChat) => a.id.localeCompare(b.id))
                .map((m) => ({
                    label: m.name,
                    description: m.id,
                    detail: m.family,
                    modelId: m.id,
                })) as ModelQuickPickItem[],
            {
                title: "LiteLLM: Available Models",
                placeHolder: "Select a model to copy its id to clipboard",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            return;
        }

        await vscode.env.clipboard.writeText(picked.modelId);
        vscode.window.showInformationMessage(`Copied model id: ${picked.modelId}`);
    });
}

export function registerReloadModelsCommand(provider: LiteLLMChatProvider): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.reloadModels", async () => {
        provider.reloadModels();
        vscode.window.showInformationMessage("LiteLLM: Reloading models...");
    });
}
