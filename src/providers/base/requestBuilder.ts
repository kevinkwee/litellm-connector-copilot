import type * as vscode from "vscode";
import { convertMessages, convertTools, validateRequest } from "../../utils";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, OpenAIFunctionToolDef } from "../../types";
import { DEFAULT_ANTHROPIC_PROMPT_CACHING, resolveAnthropicCacheControl } from "../../utils/promptCaching";
import { isDeepSeekModel, resolveToolResultImageMode, resolveToolResultTextMode } from "../../utils/modelUtils";
import type { ToolNameMapping } from "../../utils/toolNameUtils";
import type { RequestBuilderDeps } from "./types";

export class RequestBuilder {
    private readonly configManager: RequestBuilderDeps["configManager"];
    private readonly getReasoningEffort: RequestBuilderDeps["getReasoningEffort"];
    private readonly stripUnsupportedParametersFromRequest: RequestBuilderDeps["stripUnsupportedParametersFromRequest"];
    private readonly isParameterSupported: RequestBuilderDeps["isParameterSupported"];
    private readonly getUnsupportedParameters: RequestBuilderDeps["getUnsupportedParameters"];
    private readonly getTelemetryOptions: RequestBuilderDeps["getTelemetryOptions"];
    private readonly usageOptOutModels: RequestBuilderDeps["usageOptOutModels"];
    private readonly extractRawModelName: RequestBuilderDeps["extractRawModelName"];

    constructor(deps: RequestBuilderDeps) {
        this.configManager = deps.configManager;
        this.getReasoningEffort = deps.getReasoningEffort;
        this.stripUnsupportedParametersFromRequest = deps.stripUnsupportedParametersFromRequest;
        this.isParameterSupported = deps.isParameterSupported;
        this.getUnsupportedParameters = deps.getUnsupportedParameters;
        this.getTelemetryOptions = deps.getTelemetryOptions;
        this.usageOptOutModels = deps.usageOptOutModels;
        this.extractRawModelName = deps.extractRawModelName;
    }

    /**
     * Builds the chat-completions body for one request.
     *
     * Returns the body with the tool-name mapping it advertised, because the
     * response path and history replay both need to agree with exactly the tool
     * list this build sent.
     */
    public async buildOpenAIChatRequest(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        _caller?: string
    ): Promise<{ request: OpenAIChatCompletionRequest; toolNames: ToolNameMapping }> {
        const config = await this.configManager.getConfig();

        // `model.id` is the namespaced `<routing>/<raw>` form VS Code hands
        // us at response time. The LiteLLM request body, the capability
        // lookup, the parameter-supported probes, and the usage-opt-out
        // set all need the RAW model name (the part after the first `/`).
        const rawModelId = this.extractRawModelName(model.id);

        const toolConfig = convertTools(options);
        const toolNames = toolConfig.toolNames;
        const openaiMessages = convertMessages(messages, {
            toolResultImageMode: resolveToolResultImageMode(modelInfo),
            toolResultTextMode: resolveToolResultTextMode(modelInfo),
            wireToolNames: toolNames.declaredToWire,
            ensureReasoningContentInActiveTurn:
                (toolConfig.tools?.length ?? 0) > 0 && isDeepSeekModel(rawModelId, modelInfo),
        });
        validateRequest(messages);

        const reasoningEffort = this.getReasoningEffort(options);
        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        const requestBody: OpenAIChatCompletionRequest = {
            model: rawModelId,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof mo.max_tokens === "number"
                    ? Math.min(mo.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            ...(this.isParameterSupported("reasoning_effort", modelInfo, rawModelId) && reasoningEffort
                ? { reasoning_effort: reasoningEffort }
                : {}),
        };

        if (!this.usageOptOutModels.has(rawModelId)) {
            requestBody.stream_options = { include_usage: true } as { include_usage?: boolean };
        }

        if (this.isParameterSupported("temperature", modelInfo, rawModelId)) {
            // Per-model config (`chatLanguageModels.json` settings, e.g.
            // `{"temperature": 0.2}`) is the user's choice for this model.
            // A caller-provided `modelOptions.temperature` (explicit
            // per-request value) wins, mirroring Copilot's own BYOK
            // precedence. Unset means provider default: do not invent a
            // temperature the user never configured.
            const configuredTemp = this.getTelemetryOptions(options).modelConfiguration?.temperature;
            const temp =
                typeof mo.temperature === "number"
                    ? mo.temperature
                    : typeof configuredTemp === "number"
                      ? configuredTemp
                      : undefined;
            requestBody.temperature = temp;
        }
        if (this.isParameterSupported("top_p", modelInfo, rawModelId) && typeof mo.top_p === "number") {
            requestBody.top_p = mo.top_p;
        }

        // Anthropic prompt caching: LiteLLM forwards a top-level `cache_control`
        // directive to the Claude API for automatic prompt caching. Gated on the
        // workspace TTL setting, provider support, and what a previous request
        // learned live about the model's acceptance of the marker.
        const cacheControl = resolveAnthropicCacheControl({
            mode: config.anthropicPromptCaching ?? DEFAULT_ANTHROPIC_PROMPT_CACHING,
            modelId: rawModelId,
            modelInfo,
        });
        if (
            cacheControl &&
            this.isParameterSupported("cache_control", modelInfo, rawModelId) &&
            !this.getUnsupportedParameters(rawModelId).has("cache_control")
        ) {
            requestBody.cache_control = cacheControl;
        }

        if (toolConfig.tools) {
            requestBody.tools = toolConfig.tools as unknown as OpenAIFunctionToolDef[];
        }

        // Only include tool_choice when:
        // 1. Model supports tool_choice (per isParameterSupported), AND
        // 2. Tools are present, AND
        //    a. Explicitly required by toolMode (toolConfig.tool_choice is set), OR
        //    b. Model supports it, so default to "auto" for backward compatibility
        if (toolConfig.tools && toolConfig.tools.length > 0) {
            if (this.isParameterSupported("tool_choice", modelInfo, rawModelId)) {
                if (toolConfig.tool_choice) {
                    // Explicitly required tool (toolMode === Required)
                    requestBody.tool_choice = toolConfig.tool_choice;
                } else {
                    // Model supports tool_choice, tools present, but no explicit required mode
                    // Default to "auto" for backward compatibility
                    requestBody.tool_choice = "auto";
                }
            }
            // If model doesn't support tool_choice, omit it entirely
        }

        this.stripUnsupportedParametersFromRequest(
            requestBody as unknown as Record<string, unknown>,
            modelInfo,
            rawModelId
        );
        return { request: requestBody, toolNames };
    }
}
