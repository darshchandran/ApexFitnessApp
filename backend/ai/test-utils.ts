// Test fixtures only — not imported by the server.
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { memoryStore, writeAll } from '../../src/data/store';
import type { ApexData } from '../../src/domain/types';
import { createApex } from '../../src/services/apex';
import { bball, completedGym, freshData } from '../../src/test-utils';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { migrate, pgDb, type Db } from '../db/db';
import { DEFAULT_LIMITS, loadAIConfig, type AILimits, type Environment } from './config';
import { snapshotSource, type AthleteDataSource } from './data';
import type { ChatDeps } from './handler';
import { signToken, type AILogEvent } from './security';
import { AIService, type ResponsesClient } from './service';
import { ActionStore, RateLimits } from './store';

export const NOW = new Date(2026, 9, 7, 18); // Wed 7 Oct 2026, 18:00 — Legs on the program
export const TODAY = '2026-10-07';
export const SECRET = 'test-secret-that-is-at-least-32-characters-long';
export const API_KEY = 'sk-test-DO-NOT-LOG-0123456789';

/** What the app holds: stored data through the app's own start-up (today's sessions generated and adapted). */
export async function athleteData(patch: Partial<ApexData> = {}): Promise<ApexData> {
  const store = memoryStore();
  await writeAll(store, { ...freshData(), ...patch });
  const app = createApex(store, () => NOW);
  await app.init();
  return app.getState().data;
}

/** Last week's Legs and Monday's Pull logged; basketball planned this morning but not logged. */
export const week = (): Partial<ApexData> => ({
  profile: { goal: 'performance', sport: 'basketball', units: 'kg', schedule: [{ id: 's1', day: 2, kind: 'basketball', time: 'morning', enabled: true }] },
  instances: [
    completedGym('legs', '2026-09-30', { 'smith-squat': [[100, 8, 2], [100, 8, 2], [100, 8, 1]], 'leg-press': [[180, 12, 2], [180, 11, 1]] }),
    completedGym('pull', '2026-10-05', { 'lat-pulldown': [[60, 10, 2], [60, 9, 1]], 'chest-supported-row': [[50, 12, 2]] }),
  ],
});

/** The athlete's phone: the app's own service on its own store, at NOW. */
export async function device(patch: Partial<ApexData> = week()) {
  const store = memoryStore();
  await writeAll(store, { ...freshData(), ...patch });
  const app = createApex(store, () => NOW);
  await app.init();
  return app;
}

/** What the app sends as context.athlete_data. */
export const snapshot = (app: { getState(): { data: ApexData } }) => JSON.parse(JSON.stringify(app.getState().data)) as ApexData;

/** week(), plus hard basketball today, a check-in, a PR, a bodyweight. */
export const trainedAthlete = () =>
  athleteData({
    ...week(),
    basketball: [bball({ durationMin: 90, rpe: 8, date: TODAY, jumping: 3, sprinting: 2, lowerFatigue: 2 })],
    recovery: [{ date: TODAY, sleepHours: 6, soreness: 3, energy: 3 }],
    records: [{ id: 'pr1', date: '2026-09-30', instanceId: 'w-2026-09-30-legs', exerciseId: 'smith-squat', exerciseName: 'Smith Machine Squat', kind: 'weight', value: 100, previous: 95, detail: '100 kg × 8' }],
    bodyMetrics: [{ id: 'bw1', date: '2026-10-01', kind: 'bodyweight', value: 80 }],
  });

// ---------- a scripted stand-in for the OpenAI Responses API ----------

export type Body = ResponseCreateParamsNonStreaming & { input: Record<string, unknown>[] };
type Script = (body: Body, n: number, opts?: { signal?: AbortSignal; timeout?: number }) => ModelResponse | Promise<ModelResponse>;

export const res = (...output: unknown[]) => ({ id: 'resp_test', object: 'response', status: 'completed', output }) as unknown as ModelResponse;
export const say = (text: string) => res({ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
export const callTool = (name: string, args: object = {}, n = 1) =>
  ({ type: 'function_call', id: `fc_${name}_${n}`, call_id: `call_${name}_${n}`, name, arguments: JSON.stringify(args), status: 'completed' });

/** Tool results the service sent back to the model in a request body, parsed. */
export const toolOutputs = (body: Body) =>
  body.input.filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(i.output as string));

export function fakeClient(script: Script) {
  const bodies: Body[] = [];
  const client: ResponsesClient = {
    responses: {
      async create(body, opts) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        return script(bodies[bodies.length - 1], bodies.length - 1, opts);
      },
    },
  };
  return { client, bodies };
}

/** A settable clock for action expiry. */
export const testClock = () => {
  const c = { ms: Date.now(), now: () => c.ms, advance: (ms: number) => { c.ms += ms; } };
  return c;
};

// ---------- the test database (a real Postgres started by Jest's global setup) ----------

/** Starts this worker's own Postgres (PGlite, see backend/db/test-postgres.mjs) and returns its URL. */
function startWorkerPostgres(): Promise<string> {
  const child = spawn(process.execPath, [join(__dirname, '..', 'db', 'test-postgres.mjs')], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test Postgres did not start')), 60_000);
    child.stdout!.on('data', (d) => {
      const m = /APEX_TEST_DATABASE_URL=(\S+)/.exec(String(d));
      if (!m) return;
      clearTimeout(timer);
      child.stdout!.destroy();
      child.unref(); // it stops by itself when this worker goes away (the IPC channel closes)
      (child as unknown as { channel?: { unref(): void } }).channel?.unref();
      resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error(`test Postgres exited (${code})`)));
  });
}

let shared: Promise<Db> | undefined;
/**
 * A real Postgres for each test worker, through one connection (PGlite serves one session at a
 * time). Concurrent requests in a test are queued on it — the exactly-once logic lives in the
 * conditional UPDATEs, so it is exercised all the same.
 */
export const testDb = () =>
  (shared ??= (async () => {
    const db = pgDb(process.env.APEX_TEST_DATABASE_URL ?? (await startWorkerPostgres()), { max: 1, idleMs: 250 });
    await migrate(db);
    return db;
  })());

/** A Db that waits for the shared test database — lets fixtures stay synchronous. */
export const lazyDb = (p: Promise<Db> = testDb()): Db => ({
  query: async (sql, params) => (await p).query(sql, params),
  tx: async (fn) => (await p).tx(fn),
  close: async () => undefined,
});

export const testActions = (opts: ConstructorParameters<typeof ActionStore>[1] = {}) => new ActionStore(lazyDb(), opts);

export function testService(script: Script, limits: Partial<AILimits> = {}, actions = testActions()) {
  const logs: AILogEvent[] = [];
  const { client, bodies } = fakeClient(script);
  const config = loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'test-model', APEX_FAST_MODEL: 'test-fast' }, { ...DEFAULT_LIMITS, ...limits });
  const ai = new AIService({ client, config, logger: (e) => logs.push(e), actions });
  return { ai, bodies, logs, config, actions };
}

/** Rate-limit keys get a fresh namespace per fixture, so tests sharing the database don't share limits. */
let fixture = 0;
export function testDeps(script: Script, opts: { limits?: Partial<AILimits>; data?: AthleteDataSource; actions?: ActionStore; env?: Environment; registration?: 'open' | 'closed' } = {}) {
  const { ai, bodies, logs, config, actions } = testService(script, opts.limits, opts.actions);
  const db = lazyDb();
  const deps: ChatDeps = {
    env: opts.env ?? 'production', secret: SECRET, ai, db, actions, rate: new RateLimits(db, `t${process.pid}-${Date.now()}-${fixture++}:`),
    registration: opts.registration ?? 'open', data: opts.data ?? snapshotSource, logger: (e) => logs.push(e), limits: config.limits, now: () => NOW,
  };
  return { deps, bodies, logs, actions };
}

export const token = (userId = 'athlete_1', ttlSec = 3600) => signToken(userId, SECRET, ttlSec, NOW.getTime());

export const post = (body: unknown, auth: string | null = token(), headers: Record<string, string> = {}) =>
  new Request('http://apex.test/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
