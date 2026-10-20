import * as vscode from "vscode";
import type { LiteLLMCommitMessageProvider } from "../providers/liteLLMCommitProvider";
import { deriveCapabilitiesFromModelInfo } from "../utils/modelCapabilities";
import { GitUtils } from "../utils/gitUtils";
import { Logger } from "../utils/logger";
import { showModelPicker } from "./modelPicker";
import { calculateAvailableContext } from "../adapters/tokenUtils";
import { COMMIT_MESSAGE_PROMPT, COMMIT_SYSTEM_PROMPT } from "../utils/prompts";
import { stripMarkdownCodeBlocks } from "../utils";
import { splitConnectorNotice } from "../utils/connectorNotice";

async function tryGenerateViaVSCodeModelRequest(
    modelId: string,
    diff: string,
    token: vscode.CancellationToken,
    onProgress: (chunk: string) => void
): Promise<string | undefined> {
    // Route commit generation through VS Code's model request API first.
    // This forces VS Code to call our registered chat provider with the
    // provider-group configuration payload (`options.configuration`) attached.
    const models = await vscode.lm.selectChatModels({ id: modelId });
    const selectedModel = models[0];
    if (!selectedModel) {
        return undefined;
    }

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(COMMIT_SYSTEM_PROMPT),
        vscode.LanguageModelChatMessage.User(`${COMMIT_MESSAGE_PROMPT}\n\nHere is the diff:\n\n${diff}`),
    ];

    const response = await selectedModel.sendRequest(
        messages,
        {
            justification: "Generate a concise git commit message from staged changes.",
            // Commit prompts are one-shot messages with no reusable prefix, so
            // the cache-write premium could never pay off for this caller.
            modelOptions: { promptCaching: false },
        },
        token
    );

    let accumulated = "";
    let forwardedChars = 0;
    for await (const chunk of response.stream) {
        if (token.isCancellationRequested) {
            break;
        }

        if (chunk instanceof vscode.LanguageModelTextPart) {
            accumulated += chunk.value;
            // A notice can follow partial model text (a stop reason or a failure
            // after a partial answer), so scan the whole response. A notice that
            // starts a block means the response is not a commit message.
            const { modelText, notice } = splitConnectorNotice(accumulated);
            if (notice !== undefined) {
                throw new Error(notice || "The model returned a connector notice instead of a commit message.");
            }
            if (modelText.length > forwardedChars) {
                const safeChunk = modelText.slice(forwardedChars);
                forwardedChars = modelText.length;
                onProgress(safeChunk);
            }
        }
    }

    return stripMarkdownCodeBlocks(splitConnectorNotice(accumulated).modelText);
}

/**
 * Registers the command to generate a git commit message.
 */
export function registerGenerateCommitMessageCommand(_provider: LiteLLMCommitMessageProvider): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.generateCommitMessage", async (scm: unknown) => {
        try {
            // Check if model is configured, if not, show picker
            const config = await _provider.getConfigManager().getConfig();
            const modelId = config.commitModelIdOverride;

            if (!modelId) {
                const result = await vscode.window.showInformationMessage(
                    "No model configured for commit message generation. Would you like to select one?",
                    "Select Model"
                );
                if (result === "Select Model") {
                    await showModelPicker(_provider, {
                        title: "Select Commit Message Model",
                        settingKey: "commitModelIdOverride",
                    });
                }
                return;
            }

            // Get staged diff — extract rootUri from SCM context to select the correct repository
            const scmContext = scm as { rootUri?: vscode.Uri } | undefined;
            const targetRootUri = scmContext?.rootUri;
            const diff = await GitUtils.getStagedDiff(targetRootUri);
            if (diff === undefined) {
                vscode.window.showErrorMessage(
                    "No staged changes found. Please stage your changes before generating a commit message."
                );
                return;
            }
            if (diff === "") {
                vscode.window.showInformationMessage("No staged changes found.");
                return;
            }

            // Check diff size with precise context calculation
            const modelInfo = _provider.getModelInfo(modelId);
            const capabilities = deriveCapabilitiesFromModelInfo(modelId, modelInfo);

            // Calculate precise budget: MaxInput - MaxOutput - Static Prompts
            const availableTokens = calculateAvailableContext(
                capabilities.maxInputTokens,
                modelInfo?.max_output_tokens || 2000, // Reserve space for the commit message
                [COMMIT_SYSTEM_PROMPT, COMMIT_MESSAGE_PROMPT, "Here is the diff:\n\n"],
                modelId,
                modelInfo
            );

            const estimatedDiffTokens = diff.length / 4;
            let processedDiff = diff;
            let isTruncated = false;

            if (estimatedDiffTokens > availableTokens) {
                // Try to compact the diff first before hard truncation
                processedDiff = GitUtils.compactDiff(diff, availableTokens);

                // If still too large, it was already truncated within compactDiff if needed,
                // but we check if it's different from original to show warning.
                if (processedDiff.length < diff.length) {
                    isTruncated = true;
                    Logger.warn(
                        `Diff compacted/truncated for ${modelId}. Available: ${availableTokens}, Original Estimated: ${estimatedDiffTokens}`
                    );
                }
            }

            if (isTruncated) {
                vscode.window.showWarningMessage("The diff was truncated to fit within the model's context window.");
            }

            // Find the SCM input box — prefer the repository matching the SCM context
            const api = await GitUtils.getGitAPI();
            if (!api || api.repositories.length === 0) {
                return;
            }

            // Match the correct repository from SCM context, or fall back to first
            const matchedRepo = targetRootUri ? GitUtils.findRepositoryByRootUri(api, targetRootUri) : undefined;
            const repo = matchedRepo ?? api.repositories[0];

            const scmAny = scm as { inputBox?: { value: string; placeholder: string; enabled: boolean } };
            const repoAny = repo as { inputBox?: { value: string; placeholder: string; enabled: boolean } };
            const inputBox = repoAny.inputBox || (scmAny && scmAny.inputBox);

            if (!inputBox) {
                Logger.error("Could not find SCM input box");
                return;
            }

            // Keep the draft, so a failed or cancelled generation does not throw
            // away what the user had typed.
            const previousValue = inputBox.value;
            inputBox.value = "";
            const originalPlaceholder = inputBox.placeholder;
            inputBox.placeholder = "Generating commit message...";
            inputBox.enabled = false;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.SourceControl,
                    title: "Generating commit message...",
                    cancellable: true,
                },
                async (progress, token) => {
                    let succeeded = false;
                    try {
                        let accumulatedText = "";
                        let generatedMessage: string | undefined;

                        try {
                            generatedMessage = await tryGenerateViaVSCodeModelRequest(
                                modelId,
                                processedDiff,
                                token,
                                (chunk) => {
                                    accumulatedText += chunk;
                                    const filtered = accumulatedText.replace(/^```(?:\w+)?\s*/, "").replace(/```$/, "");
                                    inputBox.value = filtered;
                                }
                            );
                        } catch (vscodeRouteErr) {
                            if (token.isCancellationRequested) {
                                Logger.info("Commit message generation cancelled; restoring the previous message");
                                return;
                            }
                            Logger.error("VS Code model request route failed", vscodeRouteErr);
                            vscode.window.showErrorMessage(
                                "Failed to generate commit message: " +
                                    (vscodeRouteErr instanceof Error ? vscodeRouteErr.message : String(vscodeRouteErr))
                            );
                            return;
                        }

                        if (generatedMessage === undefined) {
                            vscode.window.showErrorMessage(
                                "Failed to generate commit message: no response from the selected model."
                            );
                            return;
                        }

                        // A cancelled generation must not replace what the user
                        // typed with a partial message.
                        if (token.isCancellationRequested) {
                            Logger.info("Commit message generation cancelled; restoring the previous message");
                            return;
                        }

                        inputBox.value = generatedMessage;
                        succeeded = true;
                    } catch (err) {
                        if (!token.isCancellationRequested) {
                            Logger.error("Failed to generate commit message", err);
                            vscode.window.showErrorMessage(
                                "Failed to generate commit message: " +
                                    (err instanceof Error ? err.message : String(err))
                            );
                        }
                    } finally {
                        inputBox.placeholder = originalPlaceholder;
                        inputBox.enabled = true;
                        if (!succeeded) {
                            inputBox.value = previousValue;
                        }
                    }
                }
            );
        } catch (err) {
            Logger.error("Error in generateCommitMessage command", err);
        }
    });
}
