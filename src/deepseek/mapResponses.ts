/** Maps normalized DeepSeek updates to OpenAI Responses objects and SSE events. */
import type { ToolReasoningMode } from "../config/env.js";
import type { MessageId } from "./sessionStore.js";
import { canonicalParsedAssistantText, parseToolCalls, parseToolCallsFromParts } from "./toolCalls.js";
import type { ModelType, PublicModel } from "./types.js";
import { iterDeepSeekUpdates } from "./updates.js";
export interface ResponseMetadata extends Record<string, unknown> {
  chat_session_id: string;
  source: "chat.deepseek.com";
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  model_type?: ModelType;
}
export interface OpenAIResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed";
  model: PublicModel;
  output: Array<Record<string, unknown>>;
  output_text?: string;
  title?: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  metadata: ResponseMetadata;
}
export interface MappedResponseResult {
  response: OpenAIResponse;
  requestMessageId: MessageId;
  responseMessageId: MessageId;
  rawOutputText: string;
}
export type ResponseEmitter = (event: string, data: Record<string, unknown>) => void;
function responseBase(
  id: string,
  publicModel: PublicModel,
  sessionId: string,
  createdAt: number,
): OpenAIResponse {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: publicModel,
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    metadata: { chat_session_id: sessionId, source: "chat.deepseek.com" },
  };
}
/** Consume one upstream stream while building both live events and the final response. */
export async function consumeResponses(input: {
  upstream: Response;
  publicModel: PublicModel;
  modelType: ModelType;
  sessionId: string;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
  toolCompatibilityEnabled: boolean;
  toolReasoning: ToolReasoningMode;
  emit?: ResponseEmitter;
}): Promise<MappedResponseResult> {
  const id = `resp_${input.sessionId}`;
  const reasoningId = `${id}_reasoning`;
  const messageId = `${id}_message`;
  const createdAt = Math.floor(Date.now() / 1000);
  const inProgress = responseBase(id, input.publicModel, input.sessionId, createdAt);
  let sequence = 0;
  const emit = (event: string, data: Record<string, unknown>): void => {
    input.emit?.(event, { ...data, sequence_number: sequence++ });
  };
  emit("response.created", { type: "response.created", response: inProgress });
  emit("response.in_progress", { type: "response.in_progress", response: inProgress });
  let reasoning = "";
  let outputText = "";
  let title: string | null = null;
  let tokens = 0;
  let reasoningOpened = false;
  let messageOpened = false;
  let requestMessageId: MessageId = null;
  let responseMessageId: MessageId = null;
  const ensureReasoning = (): void => {
    if (reasoningOpened) return;
    reasoningOpened = true;
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: reasoningId, summary: [], content: [] },
    });
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: reasoningId,
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    });
  };
  const emitReasoningDelta = (delta: string): void => {
    ensureReasoning();
    // Pi consumes raw and summary deltas, so one family prevents duplicate live thinking.
    emit("response.reasoning_text.delta", {
      type: "response.reasoning_text.delta",
      item_id: reasoningId,
      output_index: 0,
      content_index: 0,
      delta,
    });
  };
  const ensureMessage = (): void => {
    if (messageOpened) return;
    messageOpened = true;
    const outputIndex = reasoningOpened ? 1 : 0;
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
  };
  const emitOutputDelta = (delta: string): void => {
    ensureMessage();
    emit("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: reasoningOpened ? 1 : 0,
      content_index: 0,
      delta,
    });
  };
  for await (const update of iterDeepSeekUpdates(input.upstream)) {
    if (update.type === "ready") {
      requestMessageId = update.requestMessageId ?? requestMessageId;
      responseMessageId = update.responseMessageId ?? responseMessageId;
    } else if (update.type === "title") title = update.title;
    else if (update.type === "tokens") tokens = update.value;
    else if (update.type === "reasoning" && update.delta) {
      reasoning += update.delta;
      if (!input.toolCompatibilityEnabled && messageOpened && reasoningOpened) {
        emitReasoningDelta(update.delta);
      }
    } else if (update.type === "output" && update.delta) {
      outputText += update.delta;
      if (!input.toolCompatibilityEnabled) {
        if (!messageOpened && reasoning) emitReasoningDelta(reasoning);
        emitOutputDelta(update.delta);
      }
    }
  }
  const parsed = input.toolCompatibilityEnabled
    ? parseToolCallsFromParts(outputText, reasoning, id)
    : { content: outputText, toolCalls: [] };
  const hasToolCalls = parsed.toolCalls.length > 0;
  const hasResponseText = outputText.trim().length > 0;
  const visibleText = hasResponseText || hasToolCalls ? parsed.content : reasoning;
  const reasoningVisible = hasToolCalls
    ? input.toolReasoning === "clean"
      ? parseToolCalls(reasoning).content
      : ""
    : hasResponseText
      ? reasoning
      : "";
  const shouldIncludeMessage = !hasToolCalls || visibleText.length > 0;
  if (reasoningVisible && !reasoningOpened) emitReasoningDelta(reasoningVisible);
  if (shouldIncludeMessage && !messageOpened) {
    ensureMessage();
    if (visibleText) emitOutputDelta(visibleText);
  }
  const output: Array<Record<string, unknown>> = [];
  if (reasoningOpened) {
    emit("response.reasoning_text.done", {
      type: "response.reasoning_text.done",
      item_id: reasoningId,
      output_index: 0,
      content_index: 0,
      text: reasoningVisible,
    });
    const item = {
      type: "reasoning",
      id: reasoningId,
      summary: [{ type: "summary_text", text: reasoningVisible }],
      content: [{ type: "reasoning_text", text: reasoningVisible }],
    };
    output.push(item);
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
  }
  if (messageOpened) {
    const outputIndex = output.length;
    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      text: visibleText,
    });
    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: visibleText },
    });
    const item = {
      type: "message",
      id: messageId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: visibleText }],
    };
    output.push(item);
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
  }
  for (const call of parsed.toolCalls) {
    const item = {
      type: "function_call",
      id: `fc_${call.id.slice(5)}`,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: "completed",
    };
    const outputIndex = output.length;
    output.push(item);
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, arguments: "", status: "in_progress" },
    });
    emit("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments,
    });
    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: outputIndex,
      arguments: item.arguments,
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
  }
  const final: OpenAIResponse = {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model: input.publicModel,
    output,
    output_text: visibleText,
    ...(title ? { title } : {}),
    usage: { input_tokens: 0, output_tokens: tokens, total_tokens: tokens },
    metadata: {
      chat_session_id: input.sessionId,
      source: "chat.deepseek.com",
      title,
      thinking_enabled: input.thinkingEnabled,
      search_enabled: input.searchEnabled,
      model_type: input.modelType,
      request_message_id: requestMessageId,
      response_message_id: responseMessageId,
      thinking_levels_supported: false,
      tool_compatibility: input.toolCompatibilityEnabled,
      ...(input.modelType === "expert"
        ? { search_note: "expert mode does not support search on web" }
        : {}),
    },
  };
  emit("response.completed", { type: "response.completed", response: final });
  const rawForSession = hasToolCalls ? canonicalParsedAssistantText(parsed) : visibleText;
  return { response: final, requestMessageId, responseMessageId, rawOutputText: rawForSession };
}
