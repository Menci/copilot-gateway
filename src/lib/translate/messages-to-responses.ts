import {
  MESSAGES_THINKING_PLACEHOLDER,
  type MessagesAssistantContentBlock,
  type MessagesAssistantMessage,
  type MessagesClientTool,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesResponse,
  type MessagesTextBlock,
  type MessagesToolResultBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
} from "../messages-types.ts";
import {
  getMessagesRequestedReasoningEffort,
  makeResponsesReasoningId,
} from "../reasoning.ts";
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseTool,
  ResponseToolChoice,
} from "../responses-types.ts";

const flushPendingContent = (
  pending: ResponseInputContent[],
  input: ResponseInputItem[],
  role: "user" | "assistant",
): void => {
  if (pending.length === 0) return;
  input.push({ type: "message", role, content: [...pending] });
  pending.length = 0;
};

const translateUserContentBlock = (
  block: MessagesUserContentBlock,
): ResponseInputContent | undefined => {
  if (block.type === "text") return { type: "input_text", text: block.text };
  if (block.type !== "image") return undefined;

  return {
    type: "input_image",
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    detail: "auto",
  };
};

const toResponsesToolResultOutput = (
  content: MessagesToolResultBlock["content"],
): string => {
  if (typeof content === "string") {
    return content;
  }

  const textBlocks = content.filter((block): block is MessagesTextBlock =>
    block.type === "text"
  );
  if (textBlocks.length === content.length) {
    return textBlocks.map((block) => block.text).join("\n\n");
  }

  return JSON.stringify(content);
};

const getClientTools = (
  tools?: MessagesPayload["tools"],
): MessagesClientTool[] | undefined => {
  if (!tools || tools.length === 0) return undefined;

  const clientTools = tools.filter((tool): tool is MessagesClientTool =>
    tool.type === undefined || tool.type === "custom"
  );
  return clientTools.length > 0 ? clientTools : undefined;
};

const translateUserMessage = (
  message: MessagesUserMessage,
): ResponseInputItem[] => {
  if (typeof message.content === "string") {
    return [{ type: "message", role: "user", content: message.content }];
  }

  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushPendingContent(pendingContent, input, "user");
      input.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: toResponsesToolResultOutput(block.content),
        status: block.is_error ? "incomplete" : "completed",
      });
      continue;
    }

    const content = translateUserContentBlock(block);
    if (content) pendingContent.push(content);
  }

  flushPendingContent(pendingContent, input, "user");
  return input;
};

const translateAssistantMessage = (
  message: MessagesAssistantMessage,
): ResponseInputItem[] => {
  if (typeof message.content === "string") {
    return [{ type: "message", role: "assistant", content: message.content }];
  }

  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];
  const preservedUnsupportedHistory = message.content.filter((block) =>
    block.type === "server_tool_use" || block.type === "web_search_tool_result"
  );

  if (preservedUnsupportedHistory.length > 0) {
    pendingContent.push({
      type: "output_text",
      text: JSON.stringify(preservedUnsupportedHistory),
    });
  }

  for (const block of message.content) {
    if (block.type === "tool_use") {
      flushPendingContent(pendingContent, input, "assistant");
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: "completed",
      });
      continue;
    }

    if (block.type === "thinking") {
      flushPendingContent(pendingContent, input, "assistant");
      const summaryText = block.thinking === MESSAGES_THINKING_PLACEHOLDER
        ? ""
        : block.thinking;

      input.push({
        type: "reasoning",
        id: makeResponsesReasoningId(input.length),
        summary: summaryText
          ? [{ type: "summary_text", text: summaryText }]
          : [],
        encrypted_content: block.signature ?? "",
      });
      continue;
    }

    if (block.type === "text") {
      pendingContent.push({ type: "output_text", text: block.text });
    }
  }

  flushPendingContent(pendingContent, input, "assistant");
  return input;
};

const translateMessagesInput = (
  messages: MessagesMessage[],
): ResponseInputItem[] =>
  messages.flatMap((message) =>
    message.role === "user"
      ? translateUserMessage(message)
      : translateAssistantMessage(message)
  );

const translateSystemPrompt = (
  system: string | MessagesTextBlock[] | undefined,
): string | null => {
  if (typeof system === "string") return system;
  if (!system) return null;

  const text = system.map((block) => block.text).join(" ");
  return text.length > 0 ? text : null;
};

const translateTools = (
  tools: MessagesClientTool[] | undefined,
): ResponseTool[] | null => {
  if (!tools || tools.length === 0) return null;

  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    parameters: tool.input_schema,
    strict: tool.strict ?? false,
    ...(tool.description ? { description: tool.description } : {}),
  }));
};

const translateToolChoice = (
  toolChoice: MessagesPayload["tool_choice"],
  tools?: MessagesClientTool[],
): ResponseToolChoice => {
  if (!toolChoice || !tools || tools.length === 0) return "auto";

  const toolNames = new Set(tools.map((tool) => tool.name));

  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return toolChoice.name && toolNames.has(toolChoice.name)
        ? { type: "function", name: toolChoice.name }
        : "auto";
    case "none":
      return "none";
    default:
      return "auto";
  }
};

const mapMessagesStatusToResponsesStatus = (
  response: MessagesResponse,
): ResponsesResult["status"] =>
  response.stop_reason === "max_tokens" ? "incomplete" : "completed";

export const translateMessagesToResponses = (
  payload: MessagesPayload,
): ResponsesPayload => {
  // Preserve the source `output_config.effort` value as-is, even if the chosen
  // Responses upstream may reject it. Translation stays pairwise and leaves
  // target-side validation to the selected upstream endpoint.
  const effort = getMessagesRequestedReasoningEffort(payload);
  const reasoning = effort
    ? { effort, summary: "detailed" as const }
    : undefined;
  const clientTools = getClientTools(payload.tools);

  return {
    model: payload.model,
    input: payload.messages.length === 0
      ? []
      : translateMessagesInput(payload.messages),
    instructions: translateSystemPrompt(payload.system),
    temperature: 1,
    top_p: payload.top_p ?? null,
    max_output_tokens: payload.max_tokens,
    tools: translateTools(clientTools),
    tool_choice: translateToolChoice(payload.tool_choice, clientTools),
    metadata: payload.metadata ? { ...payload.metadata } : null,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    ...(reasoning
      ? { reasoning, include: ["reasoning.encrypted_content"] }
      : {}),
  };
};

export const translateMessagesToResponsesResult = (
  response: MessagesResponse,
): ResponsesResult => {
  const output: ResponseOutputItem[] = [];
  const textParts: string[] = [];
  const preservedUnsupportedHistory: MessagesAssistantContentBlock[] = [];

  for (const block of response.content) {
    switch (block.type) {
      case "thinking": {
        const summaryText = block.thinking === MESSAGES_THINKING_PLACEHOLDER
          ? ""
          : block.thinking;

        output.push({
          type: "reasoning",
          id: makeResponsesReasoningId(output.length),
          summary: summaryText
            ? [{ type: "summary_text", text: summaryText }]
            : [],
          encrypted_content: block.signature || undefined,
        } as ResponseOutputReasoning);
        break;
      }
      case "text":
        textParts.push(block.text);
        break;
      case "tool_use":
        output.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: "completed",
        } as ResponseOutputFunctionCall);
        break;
      case "server_tool_use":
      case "web_search_tool_result":
        preservedUnsupportedHistory.push(block);
        break;
    }
  }

  const outputText = [
    preservedUnsupportedHistory.length > 0
      ? JSON.stringify(preservedUnsupportedHistory)
      : "",
    textParts.join(""),
  ].filter((part) => part.length > 0).join("\n\n");

  if (outputText.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: outputText }],
    } as ResponseOutputMessage);
  }

  const inputTokens = response.usage.input_tokens +
    (response.usage.cache_read_input_tokens ?? 0) +
    (response.usage.cache_creation_input_tokens ?? 0);

  return {
    id: response.id,
    object: "response",
    model: response.model,
    output,
    output_text: outputText,
    status: mapMessagesStatusToResponsesStatus(response),
    ...(response.stop_reason === "max_tokens"
      ? { incomplete_details: { reason: "max_output_tokens" as const } }
      : {}),
    usage: {
      input_tokens: inputTokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: inputTokens + response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens !== undefined
        ? {
          input_tokens_details: {
            cached_tokens: response.usage.cache_read_input_tokens,
          },
        }
        : {}),
    },
  };
};
