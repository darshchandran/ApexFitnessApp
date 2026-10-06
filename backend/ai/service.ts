// AIService: one athlete message → a Responses API loop with APEX's controlled tools → a structured
// answer. Bounded: a deadline, a cap on tool rounds and calls, and every failure mapped to a safe error.
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { ApexData, ISODate } from '../../src/domain/types';
import { clientAction, type ActionStore } from './store';
import type { AIConfig, ModelMode } from './config';
import { INSTRUCTIONS, PROMPT_VERSION } from './prompts';
import { AIError, type AIMessageResponse } from './schemas';
import { consoleLogger, safetyId, type AILogger } from './security';
import { runTool, toolDefinitions, TOOLS, type ToolContext } from './tools';

/** The slice of the OpenAI SDK the service uses — the real client, or a fake in tests. */
export interface ResponsesClient {
  responses: { create(body: ResponseCreateParamsNonStreaming, options?: { signal?: AbortSignal; timeout?: number }): Promise<ModelResponse> };
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Recent turns per (user, conversation): text only — never tool output, never athlete facts.
 * Structured athlete state lives in the app's profile; nothing said in chat is written there.
 * ponytail: in-process memory with a TTL — a database table if conversations must survive restarts.
 */
export class ConversationStore {
  private map = new Map<string, { at: number; turns: Turn[] }>();
  constructor(private maxTurns = 8, private ttlMs = 2 * 3_600_000, private maxConversations = 5000) {}
  private key = (userId: string, id: string) => `${userId}\u0000${id}`;

  get(userId: string, id: string, now = Date.now()): Turn[] {
    const e = this.map.get(this.key(userId, id));
    return e && now - e.at <= this.ttlMs ? e.turns : [];
  }

  add(userId: string, id: string, turns: Turn[], now = Date.now()) {
    const k = this.key(userId, id);
    const prev = this.get(userId, id, now);
    this.map.delete(k);
    this.map.set(k, { at: now, turns: [...prev, ...turns].slice(-this.maxTurns) });
    if (this.map.size > this.maxConversations) this.map.delete(this.map.keys().next().value!);
  }
}

export interface ChatInput {
  userId: string;
  conversationId: string;
  message: string;
  mode: ModelMode;
  data: Readonly<ApexData> | null;
  today: ISODate;
  /** Request-scoped logger (carries the request id). */
  log?: AILogger;
}

export interface ChatResult extends AIMessageResponse {
  rounds: number;
}

const isCall = (o: ModelResponse['output'][number]): o is ResponseFunctionToolCall => o?.type === 'function_call';
const wellFormed = (c: ResponseFunctionToolCall) => typeof c.call_id === 'string' && typeof c.name === 'string' && typeof c.arguments === 'string';
const TOOL_DEFS = toolDefinitions();
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** The assistant's text from message items (or a refusal). */
function textOf(res: ModelResponse) {
  return res.output
    .flatMap((o) => (o?.type === 'message' && Array.isArray(o.content) ? o.content : []))
    .map((c) => (c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : ''))
    .join('')
    .trim();
}

/**
 * What OpenAI said, for operators: HTTP status, its error code (an identifier, e.g.
 * rate_limit_exceeded) and the account's published limits — never the message, which can carry
 * account details.
 */
function upstreamFacts(e: unknown) {
  const x = e as { status?: unknown; code?: unknown; type?: unknown; headers?: { get?: (k: string) => string | null } };
  const id = [x.code, x.type].find((v): v is string => typeof v === 'string' && /^[a-z_]{1,40}$/.test(v));
  const header = (k: string) => (typeof x.headers?.get === 'function' ? x.headers.get(k)?.match(/^\d{1,12}$/)?.[0] : undefined);
  return { status: typeof x.status === 'number' ? x.status : undefined, code: id, limitRequests: header('x-ratelimit-limit-requests'), limitTokens: header('x-ratelimit-limit-tokens') };
}

/** Upstream failures → a log category and the code the client sees. */
function classify(e: unknown): AIError {
  const status = (e as { status?: unknown })?.status;
  const name = (e as { name?: unknown })?.name;
  if (name === 'APIConnectionTimeoutError') return new AIError('timeout', 'upstream_timeout');
  if (status === 401 || status === 403) return new AIError('ai_unavailable', 'upstream_auth');
  // OpenAI answers 429 both for rate limits and for an account without credit: operators need to tell them apart
  if (status === 429) return new AIError('ai_unavailable', ['insufficient_quota', 'credit_balance_exhausted'].includes(String((e as { code?: unknown })?.code)) ? 'upstream_quota' : 'upstream_rate_limit');
  if (typeof status === 'number' && status >= 500) return new AIError('ai_unavailable', 'upstream_unavailable');
  if (typeof status === 'number') return new AIError('model_error', 'upstream_rejected');
  if (name === 'APIConnectionError') return new AIError('ai_unavailable', 'upstream_network');
  return new AIError('model_error', 'unexpected');
}

export class AIService {
  private log: AILogger;
  readonly conversations: ConversationStore;
  readonly actions: ActionStore;

  constructor(private deps: { client: ResponsesClient; config: AIConfig; actions: ActionStore; logger?: AILogger; conversations?: ConversationStore; now?: () => number }) {
    this.log = deps.logger ?? consoleLogger;
    this.conversations = deps.conversations ?? new ConversationStore(deps.config.limits.historyTurns);
    this.actions = deps.actions;
  }

  model(mode: ModelMode) {
    return this.deps.config.models[mode];
  }

  async respond(chat: ChatInput): Promise<ChatResult> {
    const { limits } = this.deps.config;
    const log = chat.log ?? this.log;
    const now = this.deps.now ?? Date.now;
    const model = this.model(chat.mode);
    const input: ResponseInputItem[] = [
      ...this.conversations.get(chat.userId, chat.conversationId, now()).map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: chat.message },
    ];
    const ctx: ToolContext = { data: chat.data, today: chat.today, proposals: [] };
    const used = new Set<string>();
    const abort = new AbortController();
    const deadline = now() + limits.timeoutMs;
    const timer = setTimeout(() => abort.abort(), limits.timeoutMs);

    try {
      for (let rounds = 0; ; rounds++) {
        const res = await this.call(model, input, abort, deadline - now(), chat.userId, log);
        const calls = res.output.filter(isCall);
        if (!calls.length) {
          const text = textOf(res);
          if (!text) throw new AIError('model_error', res.status === 'incomplete' ? 'incomplete_output' : 'empty_output');
          this.conversations.add(chat.userId, chat.conversationId, [{ role: 'user', content: chat.message }, { role: 'assistant', content: text }], now());
          // only a proposal from a turn that finished is kept — it waits for the athlete, bound to them
          const draft = ctx.proposals.at(-1);
          const action = draft ? await this.actions.create(draft, chat.userId, chat.conversationId) : undefined;
          return {
            conversation_id: chat.conversationId, message: text, model, prompt_version: PROMPT_VERSION,
            tools_used: [...used], action_required: !!action, action: action ? clientAction(action) : null, rounds,
          };
        }
        if (rounds >= limits.maxToolRounds) throw new AIError('tool_limit');
        if (!calls.every(wellFormed)) throw this.malformed(model, log);
        try {
          input.push(...toResponseInputItems(res.output));
        } catch {
          throw this.malformed(model, log); // an output item the SDK can't replay
        }
        for (const [k, call] of calls.entries()) {
          const t0 = now();
          const result = k < limits.maxToolCallsPerRound ? await runTool(call.name, call.arguments, ctx) : { ok: false as const, error: 'call_limit' };
          const known = TOOL_NAMES.has(call.name);
          if (known) used.add(call.name);
          log({ event: 'ai.tool', tool: known ? call.name : 'unknown', ok: result.ok, ...(!result.ok && { error: result.error }), ms: now() - t0 });
          input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result.ok ? result.output : { error: result.error, ...('detail' in result && { detail: result.detail }) }) });
        }
        if (abort.signal.aborted) throw new AIError('timeout');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(model: string, input: ResponseInputItem[], abort: AbortController, remainingMs: number, userId: string, log: AILogger): Promise<ModelResponse> {
    if (remainingMs <= 0 || abort.signal.aborted) throw new AIError('timeout');
    let res: ModelResponse;
    try {
      res = await this.deps.client.responses.create(
        {
          model,
          instructions: INSTRUCTIONS,
          input,
          tools: TOOL_DEFS,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          store: false, // no athlete conversation kept at OpenAI; reasoning items come back encrypted for replay
          max_output_tokens: this.deps.config.limits.maxOutputTokens,
          safety_identifier: safetyId(userId),
        },
        { signal: abort.signal, timeout: remainingMs },
      );
    } catch (e) {
      const err = abort.signal.aborted ? new AIError('timeout') : classify(e);
      log({ event: 'ai.model_error', category: err.category, model, ...(!abort.signal.aborted && { upstream: upstreamFacts(e) }) });
      throw err;
    }
    if (!res || !Array.isArray(res.output) || res.status === 'failed') throw this.malformed(model, log);
    return res;
  }

  private malformed(model: string, log: AILogger) {
    log({ event: 'ai.model_error', category: 'malformed_response', model });
    return new AIError('model_error', 'malformed_response');
  }
}
