/** Orchestrates login state, session reuse, PoW, upstream streaming, and persistence. */
import type { LoginManager } from "../browser/login.js";
import type { AppConfig } from "../config/env.js";
import { HttpError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { openCompletionStream } from "./completion.js";
import { consumeResponses, type MappedResponseResult, type ResponseEmitter } from "./mapResponses.js";
import { resolveModel, resolveSearch, resolveThinking } from "./models.js";
import { prepareCompletion } from "./pow.js";
import { buildDeepSeekPrompt } from "./promptBuild.js";
import type { MessageId, SessionStore } from "./sessionStore.js";
import {
  canonicalAssistantText,
  canonicalParsedAssistantText,
  parseToolCalls,
  parseToolCallsFromParts,
} from "./toolCalls.js";
import type { MessageTurn, ModelType, PublicModel, RequestBody } from "./types.js";
import { iterDeepSeekUpdates } from "./updates.js";

interface PreparedRun {
  upstream: Response;
  prompt: string;
  sessionId: string;
  parentMessageId: MessageId;
  modelType: ModelType;
  publicModel: PublicModel;
  thinking: boolean;
  search: boolean;
  reusedSession: boolean;
  convKey: string | null;
  requestTurns: MessageTurn[];
  instructionFingerprint: string;
  toolsFingerprint: string;
  hasTools: boolean;
}

export interface ChatStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: PublicModel;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: "stop" | "tool_calls" | null;
  }>;
  conversation?: string;
  previous_response_id?: string;
}

export class DeepSeekClient {
  constructor(
    private readonly config: AppConfig,
    private readonly login: LoginManager,
    private readonly sessions: SessionStore,
    private readonly logger: Logger,
  ) {}

  /** Bootstrap and validate the reusable Chrome login before the HTTP server listens. */
  async initialize(): Promise<void> {
    await this.login.ensureLoggedIn();
  }

  /** Execute a Responses request and optionally emit OpenAI-compatible SSE events. */
  async completeResponses(body: RequestBody, emit?: ResponseEmitter): Promise<MappedResponseResult> {
    const run = await this.prepare(body);
    const result = await consumeResponses({
      upstream: run.upstream,
      publicModel: run.publicModel,
      modelType: run.modelType,
      sessionId: run.sessionId,
      thinkingEnabled: run.thinking,
      searchEnabled: run.search,
      toolCompatibilityEnabled: run.hasTools,
      toolReasoning: this.config.toolReasoning,
      ...(emit ? { emit } : {}),
    });
    this.remember(run, result.responseMessageId, result.rawOutputText);
    result.response.metadata.reused_session = run.reusedSession;
    result.response.metadata.parent_message_id = run.parentMessageId;
    return result;
  }

  /** Stream Chat Completions deltas while keeping reasoning_content separate from content. */
  async streamChat(
    body: RequestBody,
    emit: (chunk: ChatStreamChunk) => void,
  ): Promise<void> {
    const run = await this.prepare(body);
    const id = `chatcmpl_${run.sessionId}`;
    const created = Math.floor(Date.now() / 1000);
    let responseText = "";
    let reasoningText = "";
    let responseMessageId: MessageId = null;
    let roleSent = false;
    let reasoningSent = false;

    const writeDelta = (delta: Record<string, unknown>): void => {
      const withRole = roleSent ? delta : { role: "assistant", ...delta };
      roleSent = true;
      emit(this.chatChunk(id, created, run.publicModel, withRole, null));
    };

    for await (const update of iterDeepSeekUpdates(run.upstream)) {
      if (update.type === "ready") {
        responseMessageId = update.responseMessageId ?? responseMessageId;
      } else if (update.type === "reasoning" && update.delta) {
        reasoningText += update.delta;
        if (!run.hasTools && responseText && reasoningSent) {
          writeDelta({ reasoning_content: update.delta });
        }
      } else if (update.type === "output" && update.delta) {
        responseText += update.delta;
        if (!run.hasTools) {
          if (!reasoningSent && reasoningText) {
            writeDelta({ reasoning_content: reasoningText });
            reasoningSent = true;
          }
          writeDelta({ content: update.delta });
        }
      }
    }

    let finishReason: "stop" | "tool_calls" = "stop";
    if (run.hasTools) {
      const parsed = parseToolCallsFromParts(responseText, reasoningText, id);
      if (parsed.toolCalls.length > 0) {
        finishReason = "tool_calls";
        if (this.config.toolReasoning === "clean") {
          const cleanedReason = parseToolCalls(reasoningText).content;
          if (cleanedReason) writeDelta({ reasoning_content: cleanedReason });
        }
        if (parsed.content) writeDelta({ content: parsed.content });
        writeDelta({
          tool_calls: parsed.toolCalls.map((call, index) => ({ index, ...call })),
        });
      } else {
        // DeepSeek often puts the final answer only in thinking; Pi shows content, not thinking.
        const content = responseText.trim() ? parsed.content : reasoningText;
        if (reasoningText && responseText.trim()) writeDelta({ reasoning_content: reasoningText });
        if (content) writeDelta({ content });
      }
      this.remember(
        run,
        responseMessageId,
        parsed.toolCalls.length > 0
          ? canonicalParsedAssistantText(parsed)
          : responseText.trim()
            ? parsed.content
            : reasoningText,
      );
    } else {
      const finalText = responseText.trim() ? responseText : reasoningText;
      if (!responseText.trim() && reasoningText) writeDelta({ content: reasoningText });
      this.remember(run, responseMessageId, finalText);
    }
    emit({
      ...this.chatChunk(id, created, run.publicModel, {}, finishReason),
      conversation: run.sessionId,
      previous_response_id: `resp_${run.sessionId}`,
    });
  }

  /** Resolve all trusted request options before making any upstream mutation. */
  private async prepare(body: RequestBody): Promise<PreparedRun> {
    const { modelType, publicModel } = resolveModel(body);
    const thinking = resolveThinking(body);
    const search = resolveSearch(body, modelType);
    const conversation = this.sessions.resolve(body);
    // Unknown client-provided IDs are not sent upstream; only persisted sessions are trusted.
    const reusedSession = Boolean(conversation.sessionId && this.sessions.has(conversation.sessionId));
    const previous = reusedSession && conversation.sessionId
      ? this.sessions.get(conversation.sessionId)
      : undefined;
    const built = buildDeepSeekPrompt(body, {
      reusedSession,
      ...(previous ? { previous } : {}),
    });
    const prompt = built.prompt.trim();
    if (!prompt) throw new HttpError(400, "empty input");

    const auth = await this.login.dumpCurrent();
    const page = await this.login.page();
    const prepared = await prepareCompletion({
      page,
      powWorkerUrl: this.config.powWorkerUrl,
      modelType,
      fallbackToken: auth.token,
      sessionId: reusedSession ? conversation.sessionId : null,
      reuseSession: reusedSession,
    });
    // The last DeepSeek response message is the required parent for a continuous turn.
    const parentMessageId = reusedSession
      ? conversation.parentMessageId ?? this.sessions.get(prepared.sessionId)?.lastResponseMessageId ?? null
      : null;
    const currentAuth = await this.login.dumpCurrent();
    const upstream = await openCompletionStream(this.config.baseUrl, currentAuth, {
      token: prepared.token,
      powHeader: prepared.powHeader,
      sessionId: prepared.sessionId,
      modelType,
      prompt,
      thinking,
      search,
      parentMessageId,
    });
    this.logger.debug("DeepSeek completion prepared", {
      sessionId: prepared.sessionId,
      reusedSession,
      modelType,
      thinking,
      search,
      parentMessageId,
    });
    return {
      upstream,
      prompt,
      sessionId: prepared.sessionId,
      parentMessageId,
      modelType,
      publicModel,
      thinking,
      search,
      reusedSession,
      convKey: conversation.key ?? conversation.pendingFingerprint ?? null,
      requestTurns: built.requestTurns,
      instructionFingerprint: built.instructionFingerprint,
      toolsFingerprint: built.toolsFingerprint,
      hasTools: built.hasTools,
    };
  }

  private remember(run: PreparedRun, responseMessageId: MessageId, responseText: string): void {
    this.sessions.remember({
      sessionId: run.sessionId,
      modelType: run.modelType,
      responseMessageId,
      convKey: run.convKey,
      prompt: run.prompt,
      responseText: canonicalAssistantText(responseText),
      requestTurns: run.requestTurns,
      instructionFingerprint: run.instructionFingerprint,
      toolsFingerprint: run.toolsFingerprint,
    });
  }

  private chatChunk(
    id: string,
    created: number,
    model: PublicModel,
    delta: Record<string, unknown>,
    finishReason: "stop" | "tool_calls" | null,
  ): ChatStreamChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}
