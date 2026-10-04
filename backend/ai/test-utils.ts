// Test fixtures only — not imported by the server.
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { memoryStore, writeAll } from '../../src/data/store';
import type { ApexData } from '../../src/domain/types';
import { createApex } from '../../src/services/apex';
import { bball, completedGym, freshData } from '../../src/test-utils';
import { DEFAULT_LIMITS, loadAIConfig, type AILimits } from './config';
import { snapshotSource, type AthleteDataSource } from './data';
import type { ChatDeps } from './handler';
import { RateLimiter, signToken, type AILogEvent } from './security';
import { AIService, type ResponsesClient } from './service';

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

/** Last week's Legs and Monday's Pull logged, hard basketball today, a check-in, a PR, a bodyweight. */
export const trainedAthlete = () =>
  athleteData({
    profile: { goal: 'performance', sport: 'basketball', units: 'kg', schedule: [{ id: 's1', day: 2, kind: 'basketball', time: 'morning', enabled: true }] },
    instances: [
      completedGym('legs', '2026-09-30', { 'smith-squat': [[100, 8, 2], [100, 8, 2], [100, 8, 1]], 'leg-press': [[180, 12, 2], [180, 11, 1]] }),
      completedGym('pull', '2026-10-05', { 'lat-pulldown': [[60, 10, 2], [60, 9, 1]], 'chest-supported-row': [[50, 12, 2]] }),
    ],
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

export function testService(script: Script, limits: Partial<AILimits> = {}) {
  const logs: AILogEvent[] = [];
  const { client, bodies } = fakeClient(script);
  const config = loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'test-model', APEX_FAST_MODEL: 'test-fast' }, { ...DEFAULT_LIMITS, ...limits });
  const ai = new AIService({ client, config, logger: (e) => logs.push(e) });
  return { ai, bodies, logs, config };
}

export function testDeps(script: Script, opts: { limits?: Partial<AILimits>; data?: AthleteDataSource } = {}) {
  const { ai, bodies, logs, config } = testService(script, opts.limits);
  const deps: ChatDeps = {
    secret: SECRET, ai, limiter: new RateLimiter(config.limits.requestsPerWindow, config.limits.windowMs),
    data: opts.data ?? snapshotSource, logger: (e) => logs.push(e), limits: config.limits, now: () => NOW,
  };
  return { deps, bodies, logs };
}

export const token = (userId = 'athlete_1', ttlSec = 3600) => signToken(userId, SECRET, ttlSec, NOW.getTime());

export const post = (body: unknown, auth: string | null = token(), headers: Record<string, string> = {}) =>
  new Request('http://apex.test/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
