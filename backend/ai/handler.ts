// POST /ai/chat as a standard Request → Response function: authenticate, limit, validate, answer.
// Every failure is a structured, user-safe error; nothing here can affect the app's own training data.
import { randomUUID } from 'node:crypto';
import { daysBetween } from '../../src/domain/util';
import { AIConfigError, authSecret, DEFAULT_LIMITS, loadAIConfig, type AILimits } from './config';
import { snapshotSource, type AthleteDataSource } from './data';
import { AIError, check, ERRORS, requestSchema, type AIErrorBody, type AIErrorCode, type AIMessageRequest } from './schemas';
import { authenticate, consoleLogger, RateLimiter, type AILogger } from './security';
import { AIService, ConversationStore, type ResponsesClient } from './service';

export interface ChatDeps {
  /** Token secret; undefined = the endpoint refuses everything. */
  secret: string | undefined;
  /** null = AI not configured (no key / model): authenticated callers get ai_unavailable. */
  ai: AIService | null;
  limiter: RateLimiter;
  data: AthleteDataSource;
  logger: AILogger;
  limits: AILimits;
  now?: () => Date;
}

export function createChatDeps(env: Record<string, string | undefined>, makeClient: (apiKey: string) => ResponsesClient, logger: AILogger = consoleLogger): ChatDeps {
  let ai: AIService | null = null;
  try {
    const config = loadAIConfig(env);
    ai = new AIService({ client: makeClient(config.apiKey), config, logger, conversations: new ConversationStore(config.limits.historyTurns) });
  } catch (e) {
    if (!(e instanceof AIConfigError)) throw e;
    logger({ event: 'ai.config', problem: e.message }); // names the variable, never a value
  }
  const secret = authSecret(env);
  if (!secret) logger({ event: 'ai.config', problem: 'APEX_AUTH_SECRET is not set (min 32 characters)' });
  return { secret, ai, limiter: new RateLimiter(DEFAULT_LIMITS.requestsPerWindow, DEFAULT_LIMITS.windowMs), data: snapshotSource, logger, limits: DEFAULT_LIMITS };
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10);

export async function handleChat(req: Request, deps: ChatDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  let model: string | undefined;

  const reply = (status: number, body: unknown, extra: { code?: string; rounds?: number; tools?: number; headers?: Record<string, string> } = {}) => {
    deps.logger({ event: 'ai.request', ok: status === 200, status, ...(extra.code && { code: extra.code }), ...(model && { model }), latencyMs: Date.now() - started, rounds: extra.rounds, tools: extra.tools });
    return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra.headers } });
  };
  const fail = (code: AIErrorCode, opts: { detail?: string; headers?: Record<string, string> } = {}) => {
    const body: AIErrorBody = { error: { code, message: ERRORS[code].message, ...(opts.detail && { detail: opts.detail }) } };
    return reply(ERRORS[code].status, body, { code, headers: opts.headers });
  };

  try {
    if (req.method !== 'POST') return fail('method_not_allowed', { headers: { allow: 'POST' } });
    if (!deps.secret) return fail('ai_unavailable');
    const user = authenticate(req, deps.secret, now.getTime());
    if (!user) return fail('unauthorized', { headers: { 'www-authenticate': 'Bearer' } });
    const wait = deps.limiter.take(user.userId, now.getTime());
    if (wait) return fail('rate_limited', { headers: { 'retry-after': String(Math.ceil(wait / 1000)) } });

    if (Number(req.headers.get('content-length') ?? 0) > deps.limits.maxBodyBytes) return fail('payload_too_large');
    const raw = await req.text();
    if (raw.length > deps.limits.maxBodyBytes) return fail('payload_too_large');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail('invalid_request', { detail: 'body is not JSON' });
    }
    const problem = check(requestSchema(deps.limits), body);
    if (problem) return fail('invalid_request', { detail: problem });
    const r = body as AIMessageRequest;
    const message = r.message.trim();
    if (!message) return fail('invalid_request', { detail: '$.message: empty' });
    // the athlete's local date can only be the server's UTC date ± 1
    const today = r.context?.today ?? utcDate(now);
    if (Math.abs(daysBetween(utcDate(now), today)) > 1) return fail('invalid_request', { detail: '$.context.today: not today' });

    if (!deps.ai) return fail('ai_unavailable');
    const data = r.context?.athlete_data === undefined ? null : await deps.data.load(user, r.context.athlete_data, now);
    if (r.context?.athlete_data !== undefined && !data) return fail('invalid_request', { detail: '$.context.athlete_data: not valid APEX data' });

    const mode = r.mode ?? 'default';
    model = deps.ai.model(mode);
    const { rounds, ...out } = await deps.ai.respond({ userId: user.userId, conversationId: r.conversation_id ?? randomUUID(), message, mode, data, today });
    return reply(200, out, { rounds, tools: out.tools_used.length });
  } catch (e) {
    return e instanceof AIError ? fail(e.code) : fail('internal');
  }
}
