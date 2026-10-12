// AIService: one athlete message → a Chat Completions tool loop (Groq, or OpenAI) with APEX's
// controlled tools → a structured answer. Bounded: a deadline, a cap on tool rounds and calls, and
// every failure mapped to a safe error.
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import type { ApexData, ISODate } from '../../src/domain/types';
import { clientAction, type ActionStore } from './store';
import type { AIConfig, ModelMode } from './config';
import { INSTRUCTIONS, PROMPT_VERSION } from './prompts';
import { AIError, type AIMessageResponse } from './schemas';
import { consoleLogger, safetyId, type AILogger } from './security';
import { runTool, toolDefinitions, TOOLS, type ToolContext } from './tools';

/** The slice of the OpenAI SDK the service uses (pointed at Groq or OpenAI) — or a fake in tests. */
export interface ChatClient {
  chat: { completions: { create(body: ChatCompletionCreateParamsNonStreaming, options?: { signal?: AbortSignal; timeout?: number }): Promise<ChatCompletion> } };
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

type ToolCall = Extract<ChatCompletionMessageToolCall, { type: 'function' }>;
const wellFormed = (c: ChatCompletionMessageToolCall): c is ToolCall =>
  c?.type === 'function' && typeof c.id === 'string' && typeof c.function?.name === 'string' && typeof c.function?.arguments === 'string';
const TOOL_DEFS = toolDefinitions();
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * What the provider said, for operators: HTTP status, its error code (an identifier, e.g.
 * rate_limit_exceeded) and the account's published limits — never the message, which can carry
 * account details or the model's output.
 */
function upstreamFacts(e: unknown) {
  const x = e as { status?: unknown; code?: unknown; type?: unknown; headers?: { get?: (k: string) => string | null } };
  const id = [x.code, x.type].find((v): v is string => typeof v === 'string' && /^[a-z_]{1,40}$/.test(v));
  const header = (k: string) => (typeof x.headers?.get === 'function' ? x.headers.get(k)?.match(/^\d{1,12}$/)?.[0] : undefined);
  return { status: typeof x.status === 'number' ? x.status : undefined, code: id, limitRequests: header('x-ratelimit-limit-requests'), limitTokens: header('x-ratelimit-limit-tokens') };
}

const upstreamCode = (e: unknown) => String((e as { code?: unknown })?.code ?? '');

/** Seconds to wait from the provider's retry-after (bounded), for the client. */
function retryAfter(e: unknown) {
  const h = (e as { headers?: { get?: (k: string) => string | null } })?.headers;
  const s = Number(typeof h?.get === 'function' ? h.get('retry-after') : NaN);
  return Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s), 300) : 60;
}

/** Upstream failures → a log category and the code the client sees. */
function classify(e: unknown): AIError {
  const status = (e as { status?: unknown })?.status;
  const name = (e as { name?: unknown })?.name;
  if (name === 'APIConnectionTimeoutError') return new AIError('timeout', 'upstream_timeout');
  if (status === 401 || status === 403) return new AIError('ai_unavailable', 'upstream_auth');
  if (status === 429) {
    // an account without credit won't recover by waiting; a rate limit (Groq's free tier) will
    if (['insufficient_quota', 'credit_balance_exhausted'].includes(upstreamCode(e))) return new AIError('ai_unavailable', 'upstream_quota');
    return Object.assign(new AIError('ai_busy', 'upstream_rate_limit'), { retryAfter: retryAfter(e) });
  }
  if (status === 413) return new AIError('ai_unavailable', 'upstream_request_too_large'); // e.g. over the tokens-per-minute limit
  if (status === 498 || (typeof status === 'number' && status >= 500)) return new AIError('ai_unavailable', 'upstream_unavailable');
  if (upstreamCode(e) === 'tool_use_failed') return new AIError('model_error', 'upstream_tool_call_failed');
  if (typeof status === 'number') return new AIError('model_error', 'upstream_rejected');
  if (name === 'APIConnectionError') return new AIError('ai_unavailable', 'upstream_network');
  return new AIError('model_error', 'unexpected');
}

export class AIService {
  private log: AILogger;
  readonly conversations: ConversationStore;
  readonly actions: ActionStore;

  constructor(private deps: { client: ChatClient; config: AIConfig; actions: ActionStore; logger?: AILogger; conversations?: ConversationStore; now?: () => number }) {
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
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: INSTRUCTIONS },
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
        const choice = (await this.call(model, messages, abort, () => deadline - now(), chat.userId, log)).choices[0];
        const calls = choice.message.tool_calls ?? [];
        if (!calls.length) {
          const text = (choice.message.content ?? choice.message.refusal ?? '').trim();
          if (!text) throw new AIError('model_error', choice.finish_reason === 'length' ? 'incomplete_output' : 'empty_output');
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
        // the model's calls go back verbatim (ids, names, arguments) — never its reasoning text
        messages.push({ role: 'assistant', content: choice.message.content ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })) });
        for (const [k, call] of calls.entries()) {
          const t0 = now();
          const result = k < limits.maxToolCallsPerRound ? await runTool(call.function.name, call.function.arguments, ctx) : { ok: false as const, error: 'call_limit' };
          const known = TOOL_NAMES.has(call.function.name);
          if (known) used.add(call.function.name);
          log({ event: 'ai.tool', tool: known ? call.function.name : 'unknown', ok: result.ok, ...(!result.ok && { error: result.error }), ms: now() - t0 });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.ok ? result.output : { error: result.error, ...('detail' in result && { detail: result.detail }) }) });
        }
        if (abort.signal.aborted) throw new AIError('timeout');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** One model request. Groq's "tool_use_failed" (the model wrote an unparseable tool call) is sampled once more. */
  private async call(model: string, messages: ChatCompletionMessageParam[], abort: AbortController, remaining: () => number, userId: string, log: AILogger): Promise<ChatCompletion> {
    const { provider, limits } = this.deps.config;
    for (let attempt = 0; ; attempt++) {
      if (remaining() <= 0 || abort.signal.aborted) throw new AIError('timeout');
      let res: ChatCompletion;
      try {
        res = await this.deps.client.chat.completions.create(
          {
            model,
            messages,
            tools: TOOL_DEFS,
            tool_choice: 'auto',
            max_completion_tokens: limits.maxOutputTokens,
            // OpenAI only (Groq doesn't take these): nothing stored at OpenAI; an opaque per-athlete id for abuse monitoring
            ...(provider === 'openai' && { store: false, safety_identifier: safetyId(userId) }),
            // gpt-oss: little reasoning — answers come from APEX's tools, and Groq's free tier counts every token
            ...(/gpt-oss/.test(model) && { reasoning_effort: 'low' as const }),
          },
          { signal: abort.signal, timeout: remaining() },
        );
      } catch (e) {
        const err = abort.signal.aborted ? new AIError('timeout') : classify(e);
        log({ event: 'ai.model_error', category: err.category, model, ...(!abort.signal.aborted && { upstream: upstreamFacts(e) }) });
        if (err.category === 'upstream_tool_call_failed' && attempt === 0) continue;
        throw err;
      }
      if (!res || !Array.isArray(res.choices) || !res.choices[0]?.message) throw this.malformed(model, log);
      return res;
    }
  }

  private malformed(model: string, log: AILogger) {
    log({ event: 'ai.model_error', category: 'malformed_response', model });
    return new AIError('model_error', 'malformed_response');
  }
}
