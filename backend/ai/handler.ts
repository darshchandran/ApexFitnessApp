// The AI API as standard Request → Response functions:
//   POST /ai/chat                       → AIService (model + tools; may propose one action)
//   POST /ai/actions/:id/confirm        → execute that action once, through the app's service
//   POST /ai/actions/:id/cancel         → cancel it
// Every failure is a structured, user-safe error; nothing here can touch the device's data directly.
import { randomUUID } from 'node:crypto';
import type { ApexData, ISODate } from '../../src/domain/types';
import { daysBetween } from '../../src/domain/util';
import { ACTIONS, ActionRejected, ActionStore, argumentsHash, clientAction, resultMessage, simulate, type ActionResult, type StoredAction } from './actions';
import { AIConfigError, authSecret, DEFAULT_LIMITS, loadAIConfig, type AILimits } from './config';
import { snapshotSource, type AthleteDataSource } from './data';
import { AIError, check, confirmSchema, ERRORS, requestSchema, S, type AIErrorCode, type AIMessageRequest, type Schema } from './schemas';
import { authenticate, consoleLogger, RateLimiter, type AILogger, type AuthUser } from './security';
import { AIService, ConversationStore, type ResponsesClient } from './service';

export interface ChatDeps {
  /** Token secret; undefined = the endpoints refuse everything. */
  secret: string | undefined;
  /** null = AI not configured (no key / model): authenticated callers get ai_unavailable. */
  ai: AIService | null;
  limiter: RateLimiter;
  /** Confirm/cancel don't call the model; their own, looser limit. */
  actionLimiter: RateLimiter;
  actions: ActionStore;
  data: AthleteDataSource;
  logger: AILogger;
  limits: AILimits;
  now?: () => Date;
}

export function createChatDeps(env: Record<string, string | undefined>, makeClient: (apiKey: string) => ResponsesClient, logger: AILogger = consoleLogger): ChatDeps {
  const actions = new ActionStore();
  let ai: AIService | null = null;
  try {
    const config = loadAIConfig(env);
    ai = new AIService({ client: makeClient(config.apiKey), config, logger, conversations: new ConversationStore(config.limits.historyTurns), actions });
  } catch (e) {
    if (!(e instanceof AIConfigError)) throw e;
    logger({ event: 'ai.config', problem: e.message }); // names the variable, never a value
  }
  const secret = authSecret(env);
  if (!secret) logger({ event: 'ai.config', problem: 'APEX_AUTH_SECRET is not set (min 32 characters)' });
  return {
    secret, ai, actions, data: snapshotSource, logger, limits: DEFAULT_LIMITS,
    limiter: new RateLimiter(DEFAULT_LIMITS.requestsPerWindow, DEFAULT_LIMITS.windowMs),
    actionLimiter: new RateLimiter(DEFAULT_LIMITS.requestsPerWindow * 3, DEFAULT_LIMITS.windowMs),
  };
}

const ACTION_PATH = /^\/ai\/actions\/([0-9a-f-]{36})\/(confirm|cancel)$/;

export async function route(req: Request, deps: ChatDeps): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === '/ai/chat') return handleChat(req, deps);
  const m = ACTION_PATH.exec(path);
  if (m) return handleAction(req, deps, m[1], m[2] as 'confirm' | 'cancel');
  return Response.json({ error: { code: 'not_found', message: ERRORS.not_found.message } }, { status: 404 });
}

// ---------- shared front door ----------

type Fail = (code: AIErrorCode, extra?: { detail?: string; action?: unknown }, headers?: Record<string, string>) => Response;
const utcDate = (d: Date) => d.toISOString().slice(0, 10);
/** The athlete's local date can only be the server's UTC date ± 1. */
const plausibleToday = (today: ISODate, now: Date) => Math.abs(daysBetween(utcDate(now), today)) <= 1;

function responder(deps: ChatDeps, log: (status: number, code?: string) => void): { reply: (status: number, body: unknown, headers?: Record<string, string>, code?: string) => Response; fail: Fail } {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}, code?: string) => {
    log(status, code);
    return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
  };
  const fail: Fail = (code, extra = {}, headers = {}) => reply(
    ERRORS[code].status,
    { error: { code, message: ERRORS[code].message, ...(extra.detail && { detail: extra.detail }) }, ...(extra.action !== undefined && { action: extra.action }) },
    headers,
    code,
  );
  return { reply, fail };
}

/** Method, secret, bearer token, rate limit, size, JSON, schema — in that order. */
async function admit(req: Request, deps: ChatDeps, limiter: RateLimiter, schema: Schema, fail: Fail, now: Date): Promise<{ user: AuthUser; body: unknown } | Response> {
  if (req.method !== 'POST') return fail('method_not_allowed', {}, { allow: 'POST' });
  if (!deps.secret) return fail('ai_unavailable');
  const user = authenticate(req, deps.secret, now.getTime());
  if (!user) return fail('unauthorized', {}, { 'www-authenticate': 'Bearer' });
  const wait = limiter.take(user.userId, now.getTime());
  if (wait) return fail('rate_limited', {}, { 'retry-after': String(Math.ceil(wait / 1000)) });
  if (Number(req.headers.get('content-length') ?? 0) > deps.limits.maxBodyBytes) return fail('payload_too_large');
  const raw = await req.text();
  if (raw.length > deps.limits.maxBodyBytes) return fail('payload_too_large');
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return fail('invalid_request', { detail: 'body is not JSON' });
    }
  }
  const problem = check(schema, body);
  return problem ? fail('invalid_request', { detail: problem }) : { user, body };
}

// ---------- POST /ai/chat ----------

export async function handleChat(req: Request, deps: ChatDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  let model: string | undefined;
  let stats: { rounds?: number; tools?: number } = {};
  const { reply, fail } = responder(deps, (status, code) =>
    deps.logger({ event: 'ai.request', ok: status === 200, status, ...(code && { code }), ...(model && { model }), latencyMs: Date.now() - started, ...stats }));

  try {
    const gate = await admit(req, deps, deps.limiter, requestSchema(deps.limits), fail, now);
    if (gate instanceof Response) return gate;
    const r = gate.body as AIMessageRequest;
    const message = r.message.trim();
    if (!message) return fail('invalid_request', { detail: '$.message: empty' });
    const today = r.context?.today ?? utcDate(now);
    if (!plausibleToday(today, now)) return fail('invalid_request', { detail: '$.context.today: not today' });

    if (!deps.ai) return fail('ai_unavailable');
    const data = r.context?.athlete_data === undefined ? null : await deps.data.load(gate.user, r.context.athlete_data, now);
    if (r.context?.athlete_data !== undefined && !data) return fail('invalid_request', { detail: '$.context.athlete_data: not valid APEX data' });

    const mode = r.mode ?? 'default';
    model = deps.ai.model(mode);
    const { rounds, ...out } = await deps.ai.respond({ userId: gate.user.userId, conversationId: r.conversation_id ?? randomUUID(), message, mode, data, today });
    stats = { rounds, tools: out.tools_used.length };
    if (out.action) deps.logger({ event: 'ai.action', op: 'propose', type: out.action.type, ok: true });
    return reply(200, out);
  } catch (e) {
    return e instanceof AIError ? fail(e.code) : fail('internal');
  }
}

// ---------- POST /ai/actions/:id/confirm | cancel ----------

const CANCEL_SCHEMA = S.obj({});

interface ConfirmBody {
  arguments?: Record<string, unknown>;
  context: { today: ISODate; athlete_data: Record<string, unknown> };
}

/** Runs the stored action — never client-supplied arguments — through the app's service, and settles it for good. */
async function execute(a: StoredAction, data: Readonly<ApexData>, today: ISODate, deps: ChatDeps): Promise<ActionResult> {
  let r: ActionResult;
  try {
    const sim = await simulate(data, a.type, a.arguments, today, a.basis);
    r = { success: true, action_id: a.id, action_type: a.type, result: { ...sim.result, changes: sim.changes }, affected_entities: sim.affected, timestamp: new Date().toISOString() };
  } catch (e) {
    const message = e instanceof ActionRejected ? e.message : 'Something went wrong, so nothing was changed.';
    r = { success: false, action_id: a.id, action_type: a.type, error: { code: 'action_failed', message }, timestamp: new Date().toISOString() };
  }
  a.result = r;
  a.status = r.success ? 'executed' : 'failed';
  // the conversation learns the real outcome (text only), so "how did that affect today?" can follow
  deps.ai?.conversations.add(a.userId, a.conversationId, [{ role: 'assistant', content: resultMessage(a, r) }]);
  return r;
}

export async function handleAction(req: Request, deps: ChatDeps, id: string, op: 'confirm' | 'cancel'): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  let type: string | undefined;
  const { reply, fail } = responder(deps, (status, code) =>
    deps.logger({ event: 'ai.action', op, ...(type && { type }), ok: status < 300, status, ...(code && { code }), latencyMs: Date.now() - started }));

  try {
    const gate = await admit(req, deps, deps.actionLimiter, op === 'confirm' ? confirmSchema() : CANCEL_SCHEMA, fail, now);
    if (gate instanceof Response) return gate;
    // scoped to the caller: a forged id and another athlete's id both look like "not found"
    const a = deps.actions.find(id, gate.user.userId);
    if (!a) return fail('not_found');
    type = a.type;
    const view = () => clientAction(a);

    if (op === 'cancel') {
      if (a.status === 'pending') a.status = 'cancelled';
      return a.status === 'cancelled' ? reply(200, { action: view() }) : fail('action_not_pending', { action: view() });
    }

    const body = gate.body as ConfirmBody;
    // the client may echo what it showed; any difference voids the proposal
    if (body.arguments !== undefined && argumentsHash(a.type, body.arguments) !== a.argumentsHash) {
      if (a.status === 'pending') a.status = 'cancelled';
      return fail('arguments_changed', { action: view() });
    }
    if (a.status === 'pending') {
      if (!ACTIONS[a.type].enabled) {
        a.status = 'failed';
        return fail('action_not_allowed', { action: view() });
      }
      if (argumentsHash(a.type, a.arguments) !== a.argumentsHash) {
        a.status = 'failed';
        return fail('internal');
      }
      if (!plausibleToday(body.context.today, now)) return fail('invalid_request', { detail: '$.context.today: not today' });
      const data = await deps.data.load(gate.user, body.context.athlete_data, now);
      if (!data) return fail('invalid_request', { detail: '$.context.athlete_data: not valid APEX data' });
      // re-checked after the await, then claimed synchronously: only one confirm can start the execution
      deps.actions.expire(a);
      if (a.status === 'pending') {
        a.status = 'confirmed';
        a.execution = execute(a, data, body.context.today, deps);
      }
    }
    if (a.status === 'expired') return fail('action_expired', { action: view() });
    if (a.status === 'cancelled') return fail('action_cancelled', { action: view() });
    if (!a.execution) return fail('action_not_pending', { action: view() });

    // confirmed (in flight), executed or failed: every confirm gets the one and only result
    const result = await a.execution;
    const payload = { action: view(), result, message: resultMessage(a, result) };
    return result.success ? reply(200, payload) : reply(ERRORS.action_failed.status, { error: { code: 'action_failed', message: result.error.message }, ...payload }, {}, 'action_failed');
  } catch {
    return fail('internal');
  }
}
