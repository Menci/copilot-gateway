// OpenAI Chat Completions type definitions (subset needed for translation)

export interface ChatCompletionsPayload {
  model: string;
  messages: Message[];
  max_tokens?: number | null;
  stop?: string | string[] | null;
  stream?: boolean | null;
  temperature?: number | null;
  top_p?: number | null;
  user?: string | null;
  tools?: Tool[] | null;
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null;
  /** Request usage stats in streaming responses */
  stream_options?: { include_usage: boolean } | null;
  /** Thinking budget for reasoning models */
  thinking_budget?: number;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Human-readable reasoning text (thinking content) */
  reasoning_text?: string | null;
  /** Opaque reasoning token/signature for round-tripping */
  reasoning_opaque?: string | null;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart = TextPart | ImagePart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
}

// Response types

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChoiceNonStreaming[];
  usage?: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChoiceStreaming[];
  usage?: Usage;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: {
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
}

export interface ChoiceNonStreaming {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
    reasoning_text?: string | null;
    reasoning_opaque?: string | null;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
}

export interface ChoiceStreaming {
  index: number;
  delta: Delta;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface Delta {
  content?: string | null;
  role?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
  /** Human-readable reasoning text delta */
  reasoning_text?: string | null;
  /** Opaque reasoning token/signature delta */
  reasoning_opaque?: string | null;
}
