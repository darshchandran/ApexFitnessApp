// End to end over real HTTP: test client → APEX AI server (backend/http.ts) → official OpenAI SDK →
// a local mock of the Responses API → APEX tools/actions → the device's own service.
// No real OpenAI key or network: everything listens on 127.0.0.1.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { todayOverview, type ActionChanges } from '../../../src/services/apex';
import type { ApexData, WorkoutInstance } from '../../../src/domain/types';
import { bball } from '../../../src/test-utils';
import { createAIServer } from '../../http';
import { loadAIConfig, loadServerConfig } from '../config';
import { createDeps, type ChatDeps } from '../handler';
import type { AILogEvent } from '../security';
import { AIService, type ResponsesClient } from '../service';
import { RateLimits, type ActionStore, type ClientAction } from '../store';
import { device, NOW, SECRET, snapshot, testClock, TODAY, token, week, lazyDb, testActions } from '../test-utils';

/**
 * fetch over node:http. jest-expo swaps the global fetch for Expo's native-backed one, which makes
 * no network calls under jest; this keeps every hop a real HTTP request.
 */
async function nodeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(await new Response(init.body).arrayBuffer());
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
        status: res.statusCode, headers: Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)] as [string, string]])),
      })));
    });
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
    req.end(body);
  });
}

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

// ---------- a local stand-in for POST /v1/responses ----------

type Item = Record<string, unknown>;
const seen: { auth?: string; body: { model: string; store: boolean; tools: unknown[]; input: Item[] } }[] = [];
const msg = (text: string) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (name: string, args: object, n = 1) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${name}_${n}`, name, arguments: JSON.stringify(args), status: 'completed' });

/** Scripted model: picks a tool from the athlete's words; after tool results, answers from them. */
function model(input: Item[]) {
  const last = input.at(-1)!;
  if (last.role === 'user') {
    const text = String(last.content);
    if (text.startsWith('Log basketball')) return [call('propose_log_basketball', { duration_min: 90, rpe: 8, session_type: null, lower_body_fatigue: null, date: null })];
    if (text.startsWith('Can you reduce')) return [call('propose_adapt_today_workout', { session: 'gym', choice: 'adapt' })];
    if (text.startsWith('How did that')) return [call('get_recent_sessions', { days: 1 }, 1), call('get_current_adaptation', {}, 2)];
    return [msg('Hello.')];
  }
  const userAt = input.map((i) => i.role).lastIndexOf('user');
  const outputs = input.slice(userAt).filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(String(i.output)));
  const proposal = outputs.find((o) => o.status);
  if (proposal) return [msg(proposal.status === 'awaiting_confirmation' ? `${proposal.summary} Confirm it in the app.` : `I can’t: ${proposal.reason}`)];
  const recent = outputs.find((o) => o.days);
  const adaptation = outputs.find((o) => o.sessions);
  return [msg(`Logged today: ${recent.days.flatMap((d: { sessions: { name: string }[] }) => d.sessions.map((s) => s.name)).join(', ')}. ${adaptation.sessions[0].headline}`)];
}

const mockOpenAI = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push({ auth: req.headers.authorization, body });
    const output = req.url === '/v1/responses' ? model(body.input) : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `resp_${seen.length}`, object: 'response', created_at: 0, status: 'completed', model: body.model, output }));
  });
});

// ---------- the APEX AI server, wired exactly like backend/server.ts ----------

const API_KEY = 'sk-mock-not-a-real-key';
let openaiUrl = '';
const logs: AILogEvent[] = [];
// development: the model is a local mock (production refuses mock endpoints and non-OpenAI keys)
const env = () => ({ APEX_ENV: 'development', OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'mock-model', APEX_AUTH_SECRET: SECRET });
const makeClient = (apiKey: string) => new OpenAI({ apiKey, baseURL: `${openaiUrl}/v1`, maxRetries: 0, fetch: nodeFetch }) as unknown as ResponsesClient;

let instances = 0;
/** A fresh server process on the shared database, as after a restart. `actions` swaps in a store with a test clock. */
async function startApex(actions?: ActionStore) {
  const deps: ChatDeps = createDeps(loadServerConfig(env()), lazyDb(), makeClient, (e) => logs.push(e));
  deps.rate = new RateLimits(deps.db, `it-${Date.now()}-${instances++}:`);
  if (actions) {
    deps.actions = actions;
    deps.ai = new AIService({ client: makeClient(API_KEY), config: loadAIConfig(env()), logger: (e) => logs.push(e), actions });
  }
  deps.now = () => NOW; // fixtures live on Wed 7 Oct 2026
  const server = createAIServer(deps);
  const url = await listen(server);
  return { server, url, deps };
}

type Reply = { status: number; json: any };
async function post(base: string, path: string, body: unknown, user: string | null = 'athlete_1'): Promise<Reply> {
  const r = await nodeFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user && { authorization: `Bearer ${token(user)}` }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

type Device = Awaited<ReturnType<typeof device>>;
const chat = (base: string, app: Device, message: string, user = 'athlete_1', conversation_id = 'conv-1') =>
  post(base, '/ai/chat', { message, conversation_id, context: { today: TODAY, athlete_data: snapshot(app) } }, user);
const confirm = (base: string, id: string, app: Device, extra: { user?: string; arguments?: object } = {}) =>
  post(base, `/ai/actions/${id}/confirm`, { context: { today: TODAY, athlete_data: snapshot(app) }, ...(extra.arguments && { arguments: extra.arguments }) }, extra.user ?? 'athlete_1');
const cancel = (base: string, id: string, user = 'athlete_1') => post(base, `/ai/actions/${id}/cancel`, {}, user);
const proposeBasketball = async (base: string, app: Device, user = 'athlete_1') => (await chat(base, app, 'Log basketball for 90 minutes at RPE 8.', user)).json.action as ClientAction;
const changes = (r: Reply) => r.json.result.result.changes as ActionChanges;
const gym = (d: ApexData) => todayOverview(d, TODAY).gym as WorkoutInstance;
/** Everything an action must never touch. */
const protectedParts = (d: ApexData) => JSON.stringify({
  user: d.user, profile: d.profile, settings: d.settings, plan: d.plan, templates: d.templates, plyoTemplates: d.plyoTemplates,
  recovery: d.recovery, bodyMetrics: d.bodyMetrics, performance: d.performance, records: d.records,
  history: d.instances.filter((i) => i.status === 'completed' || i.date < TODAY),
});

let apex: Awaited<ReturnType<typeof startApex>>;

beforeAll(async () => {
  openaiUrl = await listen(mockOpenAI);
  apex = await startApex();
});
afterAll(async () => {
  await close(apex.server);
  await close(mockOpenAI);
});

describe('over HTTP: propose → confirm → execute → store → retrieve', () => {
  it('logs basketball once, through the real SDK and servers, and the next turn sees it', async () => {
    const app = await device();
    const before = snapshot(app);
    seen.length = 0;

    // 1. chat → auth → SDK → mock Responses API → propose tool → pending action
    const proposed = await chat(apex.url, app, 'Log basketball for 90 minutes at RPE 8.');
    expect(proposed.status).toBe(200);
    expect(proposed.json).toMatchObject({ action_required: true, model: 'mock-model', tools_used: ['propose_log_basketball'], message: 'Log basketball — 90 min at RPE 8, today. Confirm it in the app.' });
    const action = proposed.json.action as ClientAction;
    expect(action).toMatchObject({ type: 'log_basketball', status: 'pending', requires_confirmation: true, arguments: { date: TODAY, duration_min: 90, rpe: 8 } });
    expect(seen).toHaveLength(2);
    expect(seen[0].auth).toBe(`Bearer ${API_KEY}`); // the server's key goes to OpenAI…
    expect(seen.every((s) => s.body.store === false && s.body.tools.length === 14)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(SECRET); // …the athlete's token never does
    expect(snapshot(app)).toEqual(before); // proposing changed nothing

    // 2. confirm → validation → execution through the app's service → ActionChanges
    const confirmed = await confirm(apex.url, action.id, app);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.result).toMatchObject({ success: true, action_id: action.id, action_type: 'log_basketball' });
    expect(confirmed.json.message).toMatch(/^Basketball logged\. /);
    const [session] = confirmed.json.result.result.basketball_sessions;
    expect(seen).toHaveLength(2); // confirming never calls the model

    // 3. the device stores it; exactly the intended record, nothing protected touched
    expect(app.applyActionChanges(changes(confirmed))).toBe(2);
    const after = snapshot(app);
    expect(after.basketball).toEqual([expect.objectContaining({ id: session.id, date: TODAY, durationMin: 90, rpe: 8, sport: 'basketball' })]);
    expect(protectedParts(after)).toBe(protectedParts(before));
    expect(after.instances.map((i) => i.id)).toEqual(before.instances.map((i) => i.id));
    expect(todayOverview(after, TODAY).load.basketball).toBeGreaterThan(0);

    // 4. the next turn: the conversation knows the outcome; tools retrieve the new session from the device's data
    const followUp = await chat(apex.url, app, 'How did that affect today’s workout?');
    expect(followUp.status).toBe(200);
    expect(followUp.json.message).toBe(`Logged today: Basketball 90 min @ RPE 8. ${gym(after).decision.headline}`);
    expect(seen[2].body.input.slice(0, 4)).toEqual([
      { role: 'user', content: 'Log basketball for 90 minutes at RPE 8.' },
      { role: 'assistant', content: proposed.json.message },
      { role: 'assistant', content: confirmed.json.message },
      { role: 'user', content: 'How did that affect today’s workout?' },
    ]);
  });
});

describe('idempotency over HTTP', () => {
  it('confirm twice, two at once, a retry, and re-applying → one basketball session', async () => {
    const app = await device();
    const a = await proposeBasketball(apex.url, app);
    const [x, y] = await Promise.all([confirm(apex.url, a.id, app), confirm(apex.url, a.id, app)]);
    const again = await confirm(apex.url, a.id, app);
    const retry = await confirm(apex.url, a.id, app);
    for (const r of [x, y, again, retry]) expect([r.status, r.json.result]).toEqual([200, x.json.result]);
    expect(app.applyActionChanges(changes(x))).toBe(2);
    for (const r of [y, again, retry]) expect(app.applyActionChanges(changes(r))).toBe(0);
    expect(snapshot(app).basketball).toHaveLength(1);
  });

  it('an adaptation confirmed twice is applied once, uses the engine, and leaves the template alone', async () => {
    const app = await device({ ...week(), basketball: [bball({ durationMin: 100, rpe: 9, date: TODAY, jumping: 3, lowerFatigue: 3 })] });
    app.setPlanMode(gym(snapshot(app)).id, 'kept');
    const templates = JSON.stringify(snapshot(app).templates);
    const reference = await device({ ...week(), basketball: snapshot(app).basketball });
    const engine = gym(snapshot(reference)); // the engine's own adaptation of the same day

    const { json } = await chat(apex.url, app, 'Can you reduce today’s legs?');
    const first = await confirm(apex.url, json.action.id, app);
    const second = await confirm(apex.url, json.action.id, app);
    expect(second.json.result).toEqual(first.json.result);
    expect(app.applyActionChanges(changes(first))).toBe(1);
    expect(app.applyActionChanges(changes(second))).toBe(0);
    const after = gym(snapshot(app));
    expect(after.plan).toBe('adapted');
    expect(after.exercises.map((e) => [e.exerciseId, e.prescribed.sets])).toEqual(engine.exercises.map((e) => [e.exerciseId, e.prescribed.sets]));
    expect(JSON.stringify(snapshot(app).templates)).toBe(templates);
    expect(snapshot(app).instances.filter((i) => i.date === TODAY && i.kind === 'gym')).toHaveLength(1);
  });
});

describe('security over HTTP', () => {
  it('missing authentication is refused on every route', async () => {
    const app = await device();
    const a = await proposeBasketball(apex.url, app);
    expect((await post(apex.url, '/ai/chat', { message: 'hi' }, null)).status).toBe(401);
    expect((await post(apex.url, `/ai/actions/${a.id}/confirm`, { context: { today: TODAY, athlete_data: snapshot(app) } }, null)).status).toBe(401);
    expect((await post(apex.url, `/ai/actions/${a.id}/cancel`, {}, null)).status).toBe(401);
    expect((await confirm(apex.url, a.id, app)).status).toBe(200); // untouched by the failed attempts
  });

  it('another athlete gets "not found" for someone else’s action', async () => {
    const app = await device();
    const a = await proposeBasketball(apex.url, app, 'alice');
    expect((await confirm(apex.url, a.id, app, { user: 'bob' })).json.error.code).toBe('not_found');
    expect((await cancel(apex.url, a.id, 'bob')).status).toBe(404);
    expect((await confirm(apex.url, a.id, app, { user: 'alice' })).status).toBe(200);
  });

  it('cancellation and altered arguments stop execution for good', async () => {
    const app = await device();
    const a = await proposeBasketball(apex.url, app);
    expect((await cancel(apex.url, a.id)).json.action.status).toBe('cancelled');
    expect((await confirm(apex.url, a.id, app)).json.error.code).toBe('action_cancelled');
    const b = await proposeBasketball(apex.url, app);
    const altered = await confirm(apex.url, b.id, app, { arguments: { ...b.arguments, duration_min: 300 } });
    expect([altered.status, altered.json.error.code, altered.json.action.status]).toEqual([409, 'arguments_changed', 'cancelled']);
    expect((await confirm(apex.url, b.id, app)).status).toBe(409);
    expect(snapshot(app).basketball).toHaveLength(0);
  });

  it('malformed requests are refused and the action stays pending', async () => {
    const app = await device();
    const a = await proposeBasketball(apex.url, app);
    for (const body of ['{oops', {}, { context: { today: TODAY } }, { context: { today: TODAY, athlete_data: snapshot(app) }, rpe: 10 }]) {
      const r = await post(apex.url, `/ai/actions/${a.id}/confirm`, body);
      expect([r.status, r.json.error.code]).toEqual([400, 'invalid_request']);
    }
    expect((await post(apex.url, '/ai/chat', '{oops')).status).toBe(400);
    expect((await post(apex.url, '/ai/actions/not-an-id/confirm', {})).status).toBe(404);
    expect((await confirm(apex.url, a.id, app)).status).toBe(200);
  });

  it('a disabled action type can’t execute', async () => {
    const app = await device();
    const stored = await apex.deps.actions.create({ type: 'update_athlete_profile', arguments: { field: 'goal', value: 'muscle' }, summary: 'x', preview: [] }, 'athlete_1', 'conv-1');
    const r = await confirm(apex.url, stored.id, app);
    expect([r.status, r.json.error.code]).toEqual([403, 'action_not_allowed']);
    expect(snapshot(app).profile.goal).toBe('performance');
  });

  it('a change to today’s plan after the proposal fails safely', async () => {
    const app = await device({ ...week(), basketball: [bball({ durationMin: 100, rpe: 9, date: TODAY, jumping: 3, lowerFatigue: 3 })] });
    app.setPlanMode(gym(snapshot(app)).id, 'kept');
    const { json } = await chat(apex.url, app, 'Can you reduce today’s legs?');
    app.startInstance(gym(snapshot(app)).id);
    const r = await confirm(apex.url, json.action.id, app);
    expect([r.status, r.json.error.code, r.json.result.success]).toEqual([422, 'action_failed', false]);
    expect(r.json.message).toMatch(/^Nothing was changed: /);
    expect(r.json.result.result).toBeUndefined();
  });

  it('an expired action can’t execute', async () => {
    const clock = testClock();
    const own = await startApex(testActions({ clock: clock.now }));
    try {
      const app = await device();
      const a = await proposeBasketball(own.url, app);
      clock.advance(5 * 60_000);
      const r = await confirm(own.url, a.id, app);
      expect([r.status, r.json.error.code, r.json.action.status]).toEqual([410, 'action_expired', 'expired']);
    } finally {
      await close(own.server);
    }
  });
});

describe('restart (actions live in the database)', () => {
  it('a proposal survives a restart and is confirmable; an executed one replays its result and never runs again', async () => {
    const app = await device();
    const first = await startApex();
    const pending = await proposeBasketball(first.url, app);
    const done = await proposeBasketball(first.url, app);
    const executed = await confirm(first.url, done.id, app);
    expect(executed.status).toBe(200);
    await close(first.server);

    const second = await startApex(); // a new process: nothing in memory, same database
    try {
      const later = await confirm(second.url, pending.id, app);
      expect([later.status, later.json.result.success]).toEqual([200, true]);
      const replay = await confirm(second.url, done.id, app);
      expect([replay.status, replay.json.result]).toEqual([200, executed.json.result]);
      expect(app.applyActionChanges(changes(executed))).toBe(2);
      expect(app.applyActionChanges(changes(replay))).toBe(0); // the old result again: no second mutation
      app.applyActionChanges(changes(later));
      expect(snapshot(app).basketball).toHaveLength(2); // the two proposals, once each
    } finally {
      await close(second.server);
    }
  });
});

describe('health endpoints over HTTP', () => {
  it('/healthz says the process is alive; /readyz says it can serve; nothing else is exposed', async () => {
    const live = await nodeFetch(`${apex.url}/healthz`);
    expect([live.status, await live.json()]).toEqual([200, { status: 'ok' }]);
    const ready = await nodeFetch(`${apex.url}/readyz`);
    expect([ready.status, await ready.json()]).toEqual([200, { status: 'ready', checks: { database: 'ok', schema: 'current', auth: 'configured', model: 'configured' } }]);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect((await nodeFetch(`${apex.url}/healthz`, { method: 'POST' })).status).toBe(404);
    expect((await nodeFetch(`${apex.url}/`)).status).toBe(404);
  });
});

describe('web build access (CORS)', () => {
  it('only allow-listed browser origins get CORS headers; native requests need none', async () => {
    const deps = createDeps(loadServerConfig(env()), lazyDb(), makeClient, () => undefined);
    deps.now = () => NOW;
    deps.rate = new RateLimits(deps.db, `cors-${Date.now()}:`);
    const server = createAIServer(deps, { corsOrigins: ['http://localhost:8081'] });
    const url = await listen(server);
    try {
      const preflight = (origin: string) => nodeFetch(`${url}/ai/chat`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
      const ok = await preflight('http://localhost:8081');
      expect([ok.status, ok.headers.get('access-control-allow-origin'), ok.headers.get('access-control-allow-headers')]).toEqual([204, 'http://localhost:8081', 'authorization, content-type']);
      const evil = await preflight('https://evil.example');
      expect([evil.status, evil.headers.get('access-control-allow-origin')]).toEqual([403, null]);
      const res = await nodeFetch(`${url}/ai/chat`, { method: 'POST', headers: { origin: 'http://localhost:8081', 'content-type': 'application/json' }, body: '{}' });
      expect([res.status, res.headers.get('access-control-allow-origin')]).toEqual([401, 'http://localhost:8081']); // still authenticated
      const native = await post(url, '/ai/chat', { message: 'hi' });
      expect([native.status, native.json.message]).toEqual([200, 'Hello.']);
    } finally {
      await close(server);
    }
    const closed = createAIServer(deps); // default: no browser origin allowed
    const u2 = await listen(closed);
    try {
      expect((await nodeFetch(`${u2}/ai/chat`, { method: 'OPTIONS', headers: { origin: 'http://localhost:8081' } })).status).toBe(403);
    } finally {
      await close(closed);
    }
  });
});

describe('logs', () => {
  it('stay free of keys, tokens and athlete content', () => {
    const text = JSON.stringify(logs);
    expect(logs.some((l) => l.event === 'ai.action' && l.op === 'confirm')).toBe(true);
    for (const s of [API_KEY, SECRET, 'athlete_1', 'Log basketball for', 'Bearer']) expect(text).not.toContain(s);
  });
});
