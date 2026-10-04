// The AI API as standard Request → Response functions:
//   POST /ai/auth/register              → a new athlete identity for this install (tokens)
//   POST /ai/auth/refresh | revoke      → rotate / end a session
//   POST /ai/chat                       → AIService (model + tools; may propose one action)
//   POST /ai/actions/:id/confirm        → execute that action once, through the app's service
//   POST /ai/actions/:id/cancel         → cancel it
// The athlete is always the `sub` of a verified access token. Every failure is a structured,
// user-safe error carrying a request id; nothing here can touch the device's data directly.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ApexData, ISODate } from '../../src/domain/types';
import { daysBetween } from '../../src/domain/util';
import type { Db } from '../db/db';
import { ACTIONS, ActionRejected, resultMessage, simulate, type ActionResult } from './actions';
import { refreshSession, registerDevice, revokeSession } from './auth';
import { DEFAULT_LIMITS, type AILimits, type Environment, type ServerConfig } from './config';
import { snapshotSource, type AthleteDataSource } from './data';
import { AIError, check, confirmSchema, ERRORS, refreshSchema, requestSchema, S, type AIErrorCode, type AIMessageRequest, type Schema } from './schemas';
import { authenticate, consoleLogger, type AILogEvent, type AILogger, type AuthUser } from './security';
import { AIService, ConversationStore, type ResponsesClient } from './service';
import { ActionStore, argumentsHash, clientAction, RateLimits, type StoredAction } from './store';

export interface ChatDeps {
  env: Environment;
  /** Token secret; undefined = the endpoints refuse everything. */
  secret: string | undefined;
  /** null = AI not configured (development without a key): chat answers ai_unavailable. */
  ai: AIService | null;
  db: Db;
  actions: ActionStore;
  rate: RateLimits;
  registration: 'open' | 'closed';
  data: AthleteDataSource;
  logger: AILogger;
  limits: AILimits;
  now?: () => Date;
}

export function createDeps(config: ServerConfig, db: Db, makeClient: (apiKey: string) => ResponsesClient, logger: AILogger = consoleLogger): ChatDeps {
  const actions = new ActionStore(db);
  const ai = config.ai && new AIService({ client: makeClient(config.ai.apiKey), config: config.ai, logger, conversations: new ConversationStore(config.ai.limits.historyTurns), actions });
  if (!ai) logger({ event: 'ai.config', problem: 'OPENAI_API_KEY / APEX_AI_MODEL not set: chat is unavailable (development)' });
  return {
    env: config.env, secret: config.authSecret, ai, db, actions, rate: new RateLimits(db), registration: config.registration,
    data: snapshotSource, logger, limits: config.ai?.limits ?? DEFAULT_LIMITS,
  };
}

const ACTION_PATH = /^\/ai\/actions\/([0-9a-f-]{36})\/(confirm|cancel)$/;
const AUTH_PATH = /^\/ai\/auth\/(register|refresh|revoke)$/;

/** `clientIp`: the address the HTTP layer observed (never a client-supplied header unless a trusted proxy set it). */
export async function route(req: Request, deps: ChatDeps, opts: { clientIp?: string } = {}): Promise<Response> {
  const rid = randomBytes(6).toString('hex');
  const log: AILogger = (e) => deps.logger({ ...e, rid } as AILogEvent);
  const ctx = { rid, log, clientIp: opts.clientIp ?? 'unknown' };
  const path = new URL(req.url).pathname;
  let res: Response;
  if (path === '/ai/chat') res = await handleChat(req, deps, ctx);
  else if (ACTION_PATH.test(path)) {
    const [, id, op] = ACTION_PATH.exec(path)!;
    res = await handleAction(req, deps, id, op as 'confirm' | 'cancel', ctx);
  } else if (AUTH_PATH.test(path)) res = await handleAuth(req, deps, AUTH_PATH.exec(path)![1] as 'register' | 'refresh' | 'revoke', ctx);
  else res = Response.json({ error: { code: 'not_found', message: ERRORS.not_found.message } }, { status: 404 });
  res.headers.set('x-request-id', rid);
  return res;
}

interface Ctx {
  rid: string;
  log: AILogger;
  clientIp: string;
}

// ---------- shared front door ----------

type Fail = (code: AIErrorCode, extra?: { detail?: string; action?: unknown }, headers?: Record<string, string>) => Response;
const utcDate = (d: Date) => d.toISOString().slice(0, 10);
/** The athlete's local date can only be the server's UTC date ± 1. */
const plausibleToday = (today: ISODate, now: Date) => Math.abs(daysBetween(utcDate(now), today)) <= 1;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function responder(log: (status: number, code?: string) => void): { reply: (status: number, body: unknown, headers?: Record<string, string>, code?: string) => Response; fail: Fail } {
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

/** Size, JSON (no prototype keys anywhere), schema. */
async function readBody(req: Request, deps: ChatDeps, schema: Schema, fail: Fail): Promise<{ body: unknown } | Response> {
  if (req.method !== 'POST') return fail('method_not_allowed', {}, { allow: 'POST' });
  if (Number(req.headers.get('content-length') ?? 0) > deps.limits.maxBodyBytes) return fail('payload_too_large');
  const raw = await req.text();
  if (raw.length > deps.limits.maxBodyBytes) return fail('payload_too_large');
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw, (k, v) => {
        if (FORBIDDEN_KEYS.has(k)) throw new SyntaxError('forbidden key');
        return v;
      });
    } catch (e) {
      return fail('invalid_request', { detail: (e as Error).message === 'forbidden key' ? 'forbidden key in body' : 'body is not JSON' });
    }
  }
  const problem = check(schema, body);
  return problem ? fail('invalid_request', { detail: problem }) : { body };
}

/** Method, secret, verified bearer token, per-athlete rate limit, then the body. */
async function admit(req: Request, deps: ChatDeps, kind: 'chat' | 'action', schema: Schema, fail: Fail, now: Date): Promise<{ user: AuthUser; body: unknown } | Response> {
  if (req.method !== 'POST') return fail('method_not_allowed', {}, { allow: 'POST' });
  if (!deps.secret) return fail('ai_unavailable');
  const user = authenticate(req, deps.secret, now.getTime(), { allowDev: deps.env === 'development' });
  if (!user) return fail('unauthorized', {}, { 'www-authenticate': 'Bearer' });
  const [max, windowMs] = kind === 'chat' ? [deps.limits.requestsPerWindow, deps.limits.windowMs] : [deps.limits.actionRequestsPerWindow, deps.limits.windowMs];
  const wait = await deps.rate.take(`${kind}:${user.userId}`, max, windowMs, now.getTime());
  if (wait) return fail('rate_limited', {}, { 'retry-after': String(Math.ceil(wait / 1000)) });
  const read = await readBody(req, deps, schema, fail);
  return read instanceof Response ? read : { user, body: read.body };
}

// ---------- POST /ai/auth/* ----------

export async function handleAuth(req: Request, deps: ChatDeps, op: 'register' | 'refresh' | 'revoke', ctx: Ctx): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  const { reply, fail } = responder((status, code) => ctx.log({ event: 'ai.auth', op, ok: status < 300, status, ...(code && { code }), latencyMs: Date.now() - started }));
  try {
    if (!deps.secret) return fail('ai_unavailable');
    const read = await readBody(req, deps, op === 'register' ? S.obj({}) : refreshSchema(), fail);
    if (read instanceof Response) return read;
    const limited = (wait: number) => fail('rate_limited', {}, { 'retry-after': String(Math.ceil(wait / 1000)) });

    if (op === 'register') {
      if (deps.registration !== 'open') return fail('registration_closed');
      const hour = 3_600_000;
      const perIp = await deps.rate.take(`register-ip:${ctx.clientIp}`, deps.limits.registrationsPerIpPerHour, hour, now.getTime());
      if (perIp) return limited(perIp);
      const global = await deps.rate.take('register', deps.limits.registrationsPerHour, hour, now.getTime());
      if (global) return limited(global);
      return reply(201, await registerDevice(deps.db, deps.secret, now));
    }
    const token = (read.body as { refresh_token: string }).refresh_token;
    const wait = await deps.rate.take(`refresh-ip:${ctx.clientIp}`, deps.limits.refreshesPerWindow, deps.limits.windowMs, now.getTime());
    if (wait) return limited(wait);
    if (op === 'revoke') {
      await revokeSession(deps.db, token, now);
      return reply(200, { ok: true });
    }
    const pair = await refreshSession(deps.db, deps.secret, token, now);
    return pair ? reply(200, pair) : fail('unauthorized');
  } catch {
    ctx.log({ event: 'ai.error', where: `auth.${op}`, category: 'internal' });
    return fail('internal');
  }
}

// ---------- POST /ai/chat ----------

export async function handleChat(req: Request, deps: ChatDeps, ctx: Ctx = { rid: '', log: deps.logger, clientIp: 'unknown' }): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  let model: string | undefined;
  let stats: { rounds?: number; tools?: number } = {};
  const { reply, fail } = responder((status, code) =>
    ctx.log({ event: 'ai.request', ok: status === 200, status, ...(code && { code }), ...(model && { model }), latencyMs: Date.now() - started, ...stats }));

  try {
    const gate = await admit(req, deps, 'chat', requestSchema(deps.limits), fail, now);
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
    const { rounds, ...out } = await deps.ai.respond({ userId: gate.user.userId, conversationId: r.conversation_id ?? randomUUID(), message, mode, data, today, log: ctx.log });
    stats = { rounds, tools: out.tools_used.length };
    if (out.action) ctx.log({ event: 'ai.action', op: 'propose', type: out.action.type, ok: true });
    return reply(200, out);
  } catch (e) {
    if (e instanceof AIError) return fail(e.code);
    ctx.log({ event: 'ai.error', where: 'chat', category: 'internal' });
    return fail('internal');
  }
}

// ---------- POST /ai/actions/:id/confirm | cancel ----------

interface ConfirmBody {
  arguments?: Record<string, unknown>;
  context: { today: ISODate; athlete_data: Record<string, unknown> };
}

const failure = (a: StoredAction, code: string, message: string): ActionResult =>
  ({ success: false, action_id: a.id, action_type: a.type, error: { code, message }, timestamp: new Date().toISOString() });

/** Runs the stored action — never client-supplied arguments — through the app's service on a private copy. */
async function execute(a: StoredAction, data: Readonly<ApexData>, today: ISODate): Promise<ActionResult> {
  try {
    const sim = await simulate(data, a.type, a.arguments, today, a.basis);
    return { success: true, action_id: a.id, action_type: a.type, result: { ...sim.result, changes: sim.changes }, affected_entities: sim.affected, timestamp: new Date().toISOString() };
  } catch (e) {
    return failure(a, 'action_failed', e instanceof ActionRejected ? e.message : 'Something went wrong, so nothing was changed.');
  }
}

export async function handleAction(req: Request, deps: ChatDeps, id: string, op: 'confirm' | 'cancel', ctx: Ctx = { rid: '', log: deps.logger, clientIp: 'unknown' }): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  let type: string | undefined;
  let replay = false;
  const { reply, fail } = responder((status, code) =>
    ctx.log({ event: 'ai.action', op, ...(type && { type }), ok: status < 300, status, ...(code && { code }), latencyMs: Date.now() - started, ...(replay && { replay }) }));

  /** The response for an action that is no longer pending: the one recorded result, or why not. */
  const outcome = async (a: StoredAction | undefined): Promise<Response> => {
    if (!a) return fail('not_found');
    if (a.status === 'confirmed') a = (await deps.actions.settled(a.id, a.userId)) ?? a;
    if (a.status === 'expired') return fail('action_expired', { action: clientAction(a) });
    if (a.status === 'cancelled') return fail('action_cancelled', { action: clientAction(a) });
    if (a.status === 'pending' || a.status === 'confirmed' || !a.result) return fail('action_in_progress', { action: clientAction(a) });
    const result = a.result;
    if (result.success) return reply(200, { action: clientAction(a), result, message: resultMessage(a, result) });
    if (result.error.code === 'action_not_allowed') return fail('action_not_allowed', { action: clientAction(a) });
    return reply(ERRORS.action_failed.status, { error: { code: 'action_failed', message: result.error.message }, action: clientAction(a), result, message: resultMessage(a, result) }, {}, 'action_failed');
  };

  try {
    const gate = await admit(req, deps, 'action', op === 'confirm' ? confirmSchema() : S.obj({}), fail, now);
    if (gate instanceof Response) return gate;
    const user = gate.user.userId;
    // scoped to the caller: a forged id and another athlete's id both look like "not found"
    const a = await deps.actions.get(id, user);
    if (!a) return fail('not_found');
    type = a.type;

    if (op === 'cancel') {
      const now2 = a.status === 'pending' ? await deps.actions.cancel(id, user) : a;
      return now2?.status === 'cancelled' ? reply(200, { action: clientAction(now2) }) : fail('action_not_pending', { action: now2 && clientAction(now2) });
    }

    const body = gate.body as ConfirmBody;
    // the client may echo what it showed; any difference voids the proposal
    if (body.arguments !== undefined && argumentsHash(a.type, body.arguments) !== a.argumentsHash) {
      const voided = a.status === 'pending' ? await deps.actions.cancel(id, user) : a;
      return fail('arguments_changed', { action: voided && clientAction(voided) });
    }
    // pending, or confirmed by a request that may have died mid-execution (claim() takes it over only after its lease)
    if (a.status !== 'pending' && a.status !== 'confirmed') {
      replay = a.status === 'executed' || a.status === 'failed';
      return outcome(a);
    }
    if (!ACTIONS[a.type]?.enabled) {
      await deps.actions.fail(id, user, failure(a, 'action_not_allowed', ERRORS.action_not_allowed.message));
      return fail('action_not_allowed', { action: clientAction({ ...a, status: 'failed' }) });
    }
    if (argumentsHash(a.type, a.arguments) !== a.argumentsHash) {
      await deps.actions.fail(id, user, failure(a, 'integrity', 'This request couldn’t be verified.'));
      ctx.log({ event: 'ai.error', where: 'confirm', category: 'integrity' });
      return fail('internal');
    }
    if (!plausibleToday(body.context.today, now)) return fail('invalid_request', { detail: '$.context.today: not today' });
    const data = await deps.data.load(gate.user, body.context.athlete_data, now);
    if (!data) return fail('invalid_request', { detail: '$.context.athlete_data: not valid APEX data' });

    // exactly one confirm wins the claim (in the database); every other one gets the recorded outcome
    const claim = await deps.actions.claim(id, user);
    if (!claim) return outcome(await deps.actions.get(id, user));
    const result = await execute(claim.action, data, body.context.today);
    const recorded = await deps.actions.finish(claim, result);
    if (recorded.result?.timestamp === result.timestamp) {
      // the conversation learns the real outcome (text only), so "how did that affect today?" can follow
      deps.ai?.conversations.add(user, recorded.conversationId, [{ role: 'assistant', content: resultMessage(recorded, result) }]);
    }
    return outcome(recorded);
  } catch {
    ctx.log({ event: 'ai.error', where: op, category: 'internal' });
    return fail('internal');
  }
}
