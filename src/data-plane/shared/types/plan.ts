import type { CopilotFetchOptions } from "../../../lib/copilot.ts";
import type { ResponsesReasoningEffort } from "../../../lib/reasoning.ts";

export type MessagesPlan =
  | {
    source: "messages";
    target: "messages";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
    rawBeta?: string;
  }
  | {
    source: "messages";
    target: "responses";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
    reasoningEffort: ResponsesReasoningEffort | null;
  }
  | {
    source: "messages";
    target: "chat-completions";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
  };

export type ResponsesPlan =
  | {
    source: "responses";
    target: "responses";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
  }
  | {
    source: "responses";
    target: "messages";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
  };

export type ChatPlan =
  | {
    source: "chat-completions";
    target: "messages";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
  }
  | {
    source: "chat-completions";
    target: "responses";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
    reasoningEffort: ResponsesReasoningEffort | null;
  }
  | {
    source: "chat-completions";
    target: "chat-completions";
    wantsStream: boolean;
    fetchOptions: CopilotFetchOptions;
  };
