export const THINKING_PLACEHOLDER = "Thinking...";

export interface AnthropicMessagesPayload {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  metadata?: { user_id?: string };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
  };
  thinking?: { type: "enabled" | "adaptive"; budget_tokens?: number };
  output_config?: { effort?: "low" | "medium" | "high" | "max" };
  service_tier?: "auto" | "standard_only";
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock;

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicUserMessage {
  role: "user";
  content: string | AnthropicUserContentBlock[];
}

export interface AnthropicAssistantMessage {
  role: "assistant";
  content: string | AnthropicAssistantContentBlock[];
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicAssistantContentBlock[];
  model: string;
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: "standard" | "priority" | "batch";
  };
}

// Stream event types

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent;

export interface AnthropicMessageStartEvent {
  type: "message_start";
  message:
    & Omit<AnthropicResponse, "content" | "stop_reason" | "stop_sequence">
    & {
      content: [];
      stop_reason: null;
      stop_sequence: null;
    };
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
      input: Record<string, unknown>;
    })
    | { type: "thinking"; thinking: string }
    | { type: "redacted_thinking"; data: string };
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string };
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"];
    stop_sequence?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

export interface AnthropicPingEvent {
  type: "ping";
}

export interface AnthropicErrorEvent {
  type: "error";
  error: { type: string; message: string };
}

export interface AnthropicStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  contentBlockOpen: boolean;
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string;
      name: string;
      anthropicBlockIndex: number;
      consecutiveWhitespace: number;
    };
  };
  /** Set to true when infinite whitespace is detected in tool call arguments */
  aborted?: boolean;
  /** Whether a thinking block is currently open (for reasoning_text) */
  thinkingBlockOpen?: boolean;
  /** Whether any thinking content was emitted (via reasoning_text) */
  thinkingHasContent?: boolean;
  /** Whether a signature_delta was already emitted for the current thinking block */
  thinkingSignatureSent?: boolean;
  /** Accumulated reasoning_opaque when no thinking block was open to receive it */
  pendingReasoningOpaque?: string;
  /** Whether usage has already been sent in a message_delta event */
  usageSent?: boolean;
}
