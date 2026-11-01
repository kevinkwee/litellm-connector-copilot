import type {
    LiteLLMResponsesToolChoice,
    OpenAIChatCompletionRequest,
    OpenAIChatToolChoice,
    LiteLLMResponsesRequest,
    LiteLLMResponseInputItem,
    LiteLLMResponseTool,
    OpenAIChatMessageContentItem,
} from "../types";
import { normalizeToolCallId } from "../utils";
import { Logger } from "../utils/logger";

/**
 * Wraps an image as a Responses user or assistant message item.
 *
 * LiteLLM's Responses-to-chat transform recognizes images in message content
 * only as `input_image` (see `_transform_input_image_item_to_image_item`). An
 * `image_url` item carries no `text` field, so the transform skips it as an
 * empty text block and the image never reaches the model.
 *
 * The content must be an array: LiteLLM rejects a bare content object.
 */
function toResponsesImageMessage(role: "user" | "assistant", imageUrl: string): LiteLLMResponseInputItem {
    return {
        type: "message",
        role,
        content: [{ type: "input_image", image_url: imageUrl }],
    } as unknown as LiteLLMResponseInputItem;
}

/**
 * Flattens tool message content into the string the Responses tool output
 * carries.
 *
 * Array content only reaches this path when a caller bypasses the image mode
 * decision, so image parts are logged and dropped instead of being serialized
 * into `output` as raw bytes.
 */
function toToolOutputText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        const items = content as OpenAIChatMessageContentItem[];
        if (items.some((item) => item.type === "image_url")) {
            Logger.warn(
                "[responsesAdapter] Tool message carried image parts; sending its text only. Responses requests move tool images into a user message."
            );
        }
        return items
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("");
    }
    if (content === undefined || content === null) {
        return "";
    }
    try {
        return JSON.stringify(content) ?? "";
    } catch {
        return String(content);
    }
}

/**
 * Flattens a system message's content into the text the Responses request
 * carries.
 *
 * The text items of one message are separated by a blank line, because the
 * content parts are distinct instructions rather than words of one sentence.
 */
function systemMessageText(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return (content as OpenAIChatMessageContentItem[])
        .filter(
            (item): item is OpenAIChatMessageContentItem & { type: "text"; text: string } =>
                item.type === "text" && typeof item.text === "string"
        )
        .map((item) => item.text)
        .join("\n\n")
        .trim();
}

/**
 * Translates a chat-completions `tool_choice` into the `/responses` shape,
 * where a named tool carries `name` at the top level instead of nesting under
 * `function`. A named tool the sent tools array does not carry is dropped,
 * because the endpoint rejects a choice that points at a missing tool.
 */
function toResponsesToolChoice(
    toolChoice: OpenAIChatToolChoice,
    tools: readonly LiteLLMResponseTool[]
): LiteLLMResponsesToolChoice | undefined {
    if (typeof toolChoice === "string") {
        return toolChoice;
    }
    const name = toolChoice.function.name;
    if (!tools.some((tool) => tool.name === name)) {
        Logger.warn(`[responsesAdapter] Dropping tool_choice for tool ${name}, which is not in the request tools`);
        return undefined;
    }
    return { type: "function", name };
}

/**
 * Translates a chat/completions request body into the Responses request shape,
 * where the conversation travels as an `input` array instead of `messages` and a
 * function tool carries `name` at the top level instead of nesting under
 * `function`.
 */
export function transformToResponsesFormat(requestBody: OpenAIChatCompletionRequest): LiteLLMResponsesRequest {
    const messages = requestBody.messages;
    const inputArray: (OpenAIChatMessageContentItem | LiteLLMResponseInputItem)[] = [];
    let instructions: string | undefined;

    const toolCallIdMap = new Map<string, string>();

    for (const msg of messages) {
        if (msg.role === "assistant" && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                const normalizedId = normalizeToolCallId(tc.id);
                toolCallIdMap.set(tc.id, normalizedId);
                Logger.trace(`[responsesAdapter] Mapped tool call ID: ${tc.id} -> ${normalizedId}`);
            }
        }
        if (msg.tool_call_id) {
            const normalizedId = normalizeToolCallId(msg.tool_call_id);
            toolCallIdMap.set(msg.tool_call_id, normalizedId);
            Logger.trace(`[responsesAdapter] Mapped tool result ID: ${msg.tool_call_id} -> ${normalizedId}`);
        }
    }

    let sawNonSystemMessage = false;
    for (const msg of messages) {
        if (msg.role === "system") {
            const text = systemMessageText(msg.content);
            if (!text) {
                continue;
            }
            if (!sawNonSystemMessage) {
                // The endpoint has one `instructions` slot, so consecutive leading
                // system messages are joined into it.
                instructions = instructions === undefined ? text : `${instructions}\n\n${text}`;
                continue;
            }
            // A system message after the conversation started keeps its position,
            // which LiteLLM's Responses-to-chat bridge
            // (`_transform_responses_api_input_item_to_chat_completion_message`)
            // passes through as a system turn.
            inputArray.push({ type: "message", role: "system", content: text });
            continue;
        }
        sawNonSystemMessage = true;

        if (msg.role === "user") {
            if (typeof msg.content === "string" && msg.content.trim()) {
                inputArray.push({ type: "message", role: "user", content: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const contentItem of msg.content) {
                    if (contentItem.type === "text" && typeof contentItem.text === "string") {
                        inputArray.push({
                            type: "message",
                            role: "user",
                            content: contentItem.text,
                        });
                    } else if (contentItem.type === "image_url" && contentItem.image_url?.url) {
                        Logger.debug("[responsesAdapter] Adding user image message item");
                        inputArray.push(toResponsesImageMessage("user", contentItem.image_url.url));
                    }
                }
            }
        } else if (msg.role === "assistant") {
            // An assistant turn may carry text, tool calls, or both; each becomes its
            // own input item in the same order.
            if (typeof msg.content === "string" && msg.content.trim()) {
                inputArray.push({ type: "message", role: "assistant", content: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const contentItem of msg.content) {
                    if (contentItem.type === "text" && typeof contentItem.text === "string") {
                        inputArray.push({
                            type: "message",
                            role: "assistant",
                            content: contentItem.text,
                        });
                    } else if (contentItem.type === "image_url" && contentItem.image_url?.url) {
                        Logger.debug("[responsesAdapter] Adding assistant image message item");
                        inputArray.push(toResponsesImageMessage("assistant", contentItem.image_url.url));
                    }
                }
            }
            const thinkingBlocks = (msg as { thinking_blocks?: unknown[] }).thinking_blocks;
            if (Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0) {
                // A signed block carries Anthropic's signature for that reasoning and a
                // redacted block carries opaque reasoning. The Responses endpoint has no
                // field for either, LiteLLM's Responses-to-chat bridge drops every input
                // item that has no content, and replaying a signature as
                // `encrypted_content` would present Anthropic data under an OpenAI field.
                Logger.trace(
                    `[responsesAdapter] Dropping ${thinkingBlocks.length} thinking block(s) for the /responses endpoint`
                );
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const normalizedId = toolCallIdMap.get(tc.id) || normalizeToolCallId(tc.id);
                    Logger.debug(`[responsesAdapter] Adding function_call: ${tc.function.name} (id: ${normalizedId})`);
                    inputArray.push({
                        type: "function_call",
                        id: normalizedId,
                        call_id: normalizedId,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
        } else if (msg.role === "tool") {
            const toolCallId = msg.tool_call_id;
            if (toolCallId) {
                const normalizedId = toolCallIdMap.get(toolCallId) || normalizeToolCallId(toolCallId);
                Logger.debug(`[responsesAdapter] Adding function_call_output (id: ${normalizedId})`);
                inputArray.push({
                    type: "function_call_output",
                    call_id: normalizedId,
                    output: toToolOutputText(msg.content) || "Success",
                });
            }
        }
    }

    // The endpoint requires every function_call_output to be preceded by its
    // function_call, in the order the two were produced.
    const finalInputArray: (OpenAIChatMessageContentItem | LiteLLMResponseInputItem)[] = [];
    const seenCallIds = new Set<string>();

    for (const item of inputArray) {
        if (item.type === "function_call") {
            const id = item.id;
            seenCallIds.add(id);
            Logger.trace(`[responsesAdapter] function_call id: ${id}`);
            finalInputArray.push({
                ...item,
                id: id,
                call_id: id,
            });
        } else if (item.type === "function_call_output") {
            const call_id = item.call_id;
            if (!seenCallIds.has(call_id)) {
                // An output with no call before it cannot be attributed to a tool the
                // model invoked, and inventing a call would fabricate history the model
                // never produced. Dropping it keeps the sequence valid.
                Logger.warn("[responsesAdapter] Dropping function_call_output with no matching function_call", {
                    callId: call_id,
                });
                continue;
            }
            finalInputArray.push({
                ...item,
                id: call_id,
                call_id: call_id,
            });
        } else {
            finalInputArray.push(item);
        }
    }

    const responsesBody: LiteLLMResponsesRequest = {
        model: requestBody.model,
        input: finalInputArray,
        stream: requestBody.stream,
        instructions,
        max_output_tokens: requestBody.max_tokens,
        temperature: requestBody.temperature,
        top_p: requestBody.top_p,
        // LiteLLM /responses also accepts the flat `reasoning_effort` key. We pass it
        // through unchanged so reasoning effort works identically across endpoints
        // and the connector keeps a single canonical request shape.
        reasoning_effort: requestBody.reasoning_effort,
        stream_options: requestBody.stream_options,
        // Propagate LiteLLM proxy metadata (notably `session_id` →
        // `litellm_session_id` for per-session spend tracking) so the
        // `/responses` endpoint gets the same session grouping as
        // `/chat/completions`. See `OpenAIChatCompletionRequest.metadata`.
        metadata: requestBody.metadata,
    };

    if (requestBody.tools) {
        responsesBody.tools = requestBody.tools
            .map((tool) => {
                const func = tool.function;
                if (!func.name) {
                    Logger.warn(`[responsesAdapter] Dropping a tool with no name`);
                    return null;
                }
                return {
                    type: "function" as const,
                    name: func.name,
                    description: func.description || "", // Allow empty description
                    parameters: func.parameters,
                    // The Responses request schema requires `strict` and documents
                    // true as its default, while LiteLLM's bridge reads a missing value
                    // as false. The connector forwards the caller's schema unchanged, so
                    // it states false explicitly instead of relying on either default.
                    strict: false,
                };
            })
            .filter((t): t is LiteLLMResponseTool => t !== null);
    }

    if (requestBody.tool_choice && responsesBody.tools) {
        responsesBody.tool_choice = toResponsesToolChoice(requestBody.tool_choice, responsesBody.tools);
    }

    return responsesBody;
}
