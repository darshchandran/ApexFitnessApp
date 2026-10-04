import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AIConfigError, DEFAULT_LIMITS, loadAIConfig } from '../config';
import type { AthleteDataSource } from '../data';
import { createChatDeps, handleChat } from '../handler';
import { RateLimiter, signToken, verifyToken } from '../security';
import { AIService } from '../service';
import { API_KEY, athleteData, callTool, fakeClient, NOW, post, res, say, SECRET, TODAY, testDeps, token, toolOutputs, trainedAthlete } from '../test-utils';

const ROOT = join(__dirname, '..', '..', '..');
const ok = () => say('Fine.');

describe('configuration', () => {
  it('needs an API key and a model, and says which variable is missing without echoing values', () => {
    expect(() => loadAIConfig({ APEX_AI_MODEL: 'm' })).toThrow(new AIConfigError('OPENAI_API_KEY is not set'));
    expect(() => loadAIConfig({ OPENAI_API_KEY: API_KEY })).toThrow('APEX_AI_MODEL is not set');
    expect(() => loadAIConfig({ OPENAI_API_KEY: '  ', APEX_AI_MODEL: 'm' })).toThrow('OPENAI_API_KEY is not set');
    try {
      loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'bad model; rm -rf /' });
    } catch (e) {
      expect((e as Error).message).toBe('APEX_AI_MODEL is not a valid model name');
      expect((e as Error).message).not.toContain('rm -rf');
    }
    expect(() => loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'm', APEX_DEEP_MODEL: 'has space' })).toThrow('APEX_DEEP_MODEL is not a valid model name');
  });

  it('fast and deep models fall back to APEX_AI_MODEL; nothing is hard-coded', () => {
    expect(loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'main-1' }).models).toEqual({ default: 'main-1', fast: 'main-1', deep: 'main-1' });
    expect(loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'main-1', APEX_FAST_MODEL: 'small-1', APEX_DEEP_MODEL: 'big-1' }).models)
      .toEqual({ default: 'main-1', fast: 'small-1', deep: 'big-1' });
  });

  it('the service picks the model for the requested mode', async () => {
    const { client, bodies } = fakeClient(ok);
    const ai = new AIService({ client, config: loadAIConfig({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'main-1', APEX_DEEP_MODEL: 'big-1' }), logger: () => undefined });
    await ai.respond({ userId: 'u1', conversationId: 'c1', message: 'hi', mode: 'deep', data: null, today: TODAY });
    expect(bodies[0].model).toBe('big-1');
    expect(ai.model('fast')).toBe('main-1');
  });

  it('without a key the endpoint answers ai_unavailable — after authenticating — and logs only the variable name', async () => {
    const logs: string[] = [];
    const deps = createChatDeps({ APEX_AUTH_SECRET: SECRET, APEX_AI_MODEL: 'm' }, () => fakeClient(ok).client, (e) => logs.push(JSON.stringify(e)));
    expect(deps.ai).toBeNull();
    expect(logs[0]).toContain('OPENAI_API_KEY is not set');
    const denied = await handleChat(post({ message: 'hi' }, null), deps);
    expect(denied.status).toBe(401);
    const res = await handleChat(post({ message: 'hi' }, signToken('u1', SECRET, 60)), deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'ai_unavailable', message: expect.stringContaining('not affected') } });
  });

  it('without an auth secret every request is refused (fail closed)', async () => {
    const deps = createChatDeps({ OPENAI_API_KEY: API_KEY, APEX_AI_MODEL: 'm', APEX_AUTH_SECRET: 'too-short' }, () => fakeClient(ok).client, () => undefined);
    expect(deps.secret).toBeUndefined();
    expect((await handleChat(post({ message: 'hi' }, signToken('u1', 'too-short', 60)), deps)).status).toBe(503);
  });
});

describe('authentication', () => {
  it('signed tokens verify; tampered, expired, foreign or malformed ones do not', () => {
    const t = signToken('athlete_1', SECRET, 60, NOW.getTime());
    expect(verifyToken(t, SECRET, NOW.getTime())).toEqual({ userId: 'athlete_1' });
    expect(verifyToken(t, SECRET, NOW.getTime() + 61_000)).toBeNull();
    expect(verifyToken(t, 'another-secret-another-secret-another', NOW.getTime())).toBeNull();
    const [v, payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'athlete_2', exp: 9e9 })).toString('base64url');
    expect(verifyToken(`${v}.${forged}.${sig}`, SECRET, NOW.getTime())).toBeNull();
    expect(verifyToken(`${v}.${payload}.${sig.slice(0, -2)}xx`, SECRET, NOW.getTime())).toBeNull();
    expect(verifyToken('nonsense', SECRET)).toBeNull();
    expect(() => signToken('../etc', SECRET, 60)).toThrow();
  });

  it('rejects requests without a valid bearer token; accepts an authenticated athlete', async () => {
    const { deps, bodies } = testDeps(ok);
    for (const auth of [null, 'garbage', signToken('athlete_1', 'wrong-secret-wrong-secret-wrong-secret', 60, NOW.getTime()), token('athlete_1', -10)]) {
      const r = await handleChat(post({ message: 'hi' }, auth), deps);
      expect(r.status).toBe(401);
      expect((await r.json()).error.code).toBe('unauthorized');
    }
    expect(bodies).toHaveLength(0); // nothing reached the model
    const r = await handleChat(post({ message: 'hi' }), deps);
    expect(r.status).toBe(200);
  });

  it('isolates athletes: tools only ever see the authenticated caller’s data', async () => {
    const byUser: Record<string, Awaited<ReturnType<typeof athleteData>>> = {
      alice: await athleteData({ profile: { goal: 'muscle', units: 'kg', schedule: [] } }),
      bob: await athleteData({ profile: { goal: 'performance', units: 'lb', schedule: [] } }),
    };
    const keyed: AthleteDataSource = { load: async (user) => byUser[user.userId] ?? null };
    // the model even tries to name another athlete — the strict schema refuses it
    const { deps, bodies } = testDeps((_b, n) => (n % 2 === 0 ? res(callTool('get_athlete_profile', { user_id: 'alice' }), callTool('get_athlete_profile', {}, 2)) : say('ok')), { data: keyed });
    await handleChat(post({ message: 'my goal?', context: { athlete_data: {} } }, token('bob')), deps);
    const [smuggled, own] = toolOutputs(bodies[1]);
    expect(smuggled).toEqual({ error: 'invalid_arguments', detail: '$.user_id: not allowed' });
    expect(own.goal).toBe('performance');
    await handleChat(post({ message: 'my goal?', context: { athlete_data: {} } }, token('alice')), deps);
    expect(toolOutputs(bodies[3])[1].goal).toBe('muscle');
  });

  it('a conversation id cannot be used to read another athlete’s conversation', async () => {
    const { deps, bodies } = testDeps(() => say('Noted.'));
    await handleChat(post({ conversation_id: 'shared', message: 'ALICE-PRIVATE note' }, token('alice')), deps);
    await handleChat(post({ conversation_id: 'shared', message: 'hello' }, token('bob')), deps);
    expect(JSON.stringify(bodies[1].input)).not.toContain('ALICE-PRIVATE');
    await handleChat(post({ conversation_id: 'shared', message: 'again' }, token('alice')), deps);
    expect(JSON.stringify(bodies[2].input)).toContain('ALICE-PRIVATE');
  });
});

describe('the endpoint', () => {
  it('returns a structured answer with a conversation id', async () => {
    const { deps } = testDeps(ok);
    const r = await handleChat(post({ message: 'hi', context: { today: TODAY } }), deps);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({
      conversation_id: expect.stringMatching(/^[\w-]{8,}$/), message: 'Fine.', model: 'test-model',
      prompt_version: expect.stringMatching(/^apex-ai-/), tools_used: [], action_required: null,
    });
  });

  it('validates the request', async () => {
    const { deps, bodies } = testDeps(ok);
    const bad = async (body: unknown, detail?: string) => {
      const r = await handleChat(post(body), deps);
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe('invalid_request');
      if (detail) expect(j.error.detail).toBe(detail);
    };
    await bad('not json', 'body is not JSON');
    await bad({}, '$.message: missing');
    await bad({ message: '   ' }, '$.message: empty');
    await bad({ message: 'x'.repeat(DEFAULT_LIMITS.maxMessageChars + 1) }, '$.message: too long');
    await bad({ message: 'hi', admin: true }, '$.admin: not allowed');
    await bad({ message: 'hi', mode: 'unlimited' }, '$.mode: not an allowed value');
    await bad({ message: 'hi', conversation_id: '../../etc' }, '$.conversation_id: wrong format');
    await bad({ message: 'hi', context: { today: '2026-12-25' } }, '$.context.today: not today');
    await bad({ message: 'hi', context: { athlete_data: { plan: { days: [] } } } }, '$.context.athlete_data: not valid APEX data');
    expect(bodies).toHaveLength(0);
    expect((await handleChat(new Request('http://apex.test/ai/chat', { headers: { authorization: `Bearer ${token()}` } }), deps)).status).toBe(405);
  });

  it('refuses oversized bodies before parsing them', async () => {
    const { deps } = testDeps(ok, { limits: { maxBodyBytes: 1000 } });
    expect((await handleChat(post({ message: 'hi', context: { athlete_data: { note: 'x'.repeat(2000) } } }), deps)).status).toBe(413);
  });

  it('rate-limits per athlete', async () => {
    const { deps } = testDeps(ok, { limits: { requestsPerWindow: 2 } });
    expect((await handleChat(post({ message: '1' }), deps)).status).toBe(200);
    expect((await handleChat(post({ message: '2' }), deps)).status).toBe(200);
    const limited = await handleChat(post({ message: '3' }), deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await handleChat(post({ message: '1' }, token('someone_else')), deps)).status).toBe(200);
    const rl = new RateLimiter(1, 1000);
    expect(rl.take('u', 0)).toBe(0);
    expect(rl.take('u', 500)).toBe(500);
    expect(rl.take('u', 1000)).toBe(0); // new window
  });

  it('maps every failure to a structured, user-safe error', async () => {
    const cases: [Parameters<typeof testDeps>[0], number, string][] = [
      [() => Promise.reject(Object.assign(new Error('boom'), { status: 500 })), 503, 'ai_unavailable'],
      [() => Promise.reject(Object.assign(new Error('bad model'), { status: 400 })), 502, 'model_error'],
      [() => ({ id: 'r', status: 'completed', output: 'not a list' }) as never, 502, 'model_error'],
    ];
    for (const [script, status, code] of cases) {
      const { deps } = testDeps(script);
      const r = await handleChat(post({ message: 'hi' }), deps);
      expect(r.status).toBe(status);
      const j = await r.json();
      expect(j).toEqual({ error: { code, message: expect.stringContaining('not affected') } });
      expect(JSON.stringify(j)).not.toMatch(/boom|bad model|stack|Error/);
    }
    const broken: AthleteDataSource = { load: () => Promise.reject(new Error('disk on fire')) };
    const { deps } = testDeps(ok, { data: broken });
    const r = await handleChat(post({ message: 'hi', context: { athlete_data: {} } }), deps);
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('disk on fire');
  });

  it('logs outcome, model, latency and tool names — never message text, athlete data, keys or tokens', async () => {
    const data = await trainedAthlete();
    const named = { ...data, user: { ...data.user, name: 'Jordan Privatename' }, profile: { ...data.profile, targetBodyweightKg: 87.3 } };
    const { deps, logs } = testDeps((_b, n) => (n === 0 ? res(callTool('get_athlete_profile')) : say('Your target is 87.3 kg.')));
    const auth = token();
    await handleChat(post({ message: 'SECRET-MESSAGE-TEXT what is my target?', context: { today: TODAY, athlete_data: named } }, auth), deps);
    const text = JSON.stringify(logs);
    expect(logs.map((l) => l.event)).toEqual(['ai.tool', 'ai.request']);
    expect(logs[1]).toEqual({ event: 'ai.request', ok: true, status: 200, model: 'test-model', latencyMs: expect.any(Number), rounds: 1, tools: 1 });
    for (const secret of ['SECRET-MESSAGE-TEXT', 'Jordan', '87.3', API_KEY, auth, SECRET, 'athlete_1', 'Bearer']) expect(text).not.toContain(secret);
  });
});

describe('architecture boundary', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js)$/.test(f) ? [p] : [];
    });

  it('the app never imports the AI backend or the OpenAI SDK, and never names the key', () => {
    for (const f of files(join(ROOT, 'src'))) {
      const s = readFileSync(f, 'utf8');
      expect(s).not.toMatch(/from ['"][./]*backend\/|from ['"]openai|require\(['"]openai/);
      expect(s).not.toMatch(/OPENAI_API_KEY|EXPO_PUBLIC_[A-Z_]*(OPENAI|AI_KEY|API_KEY|SECRET)/);
    }
    expect(readFileSync(join(ROOT, 'app.json'), 'utf8')).not.toMatch(/openai|api[_-]?key|secret/i);
  });

  it('the AI backend has no storage, network, file, process or app-UI access of its own', () => {
    for (const f of files(join(ROOT, 'backend', 'ai')).filter((p) => !p.includes('__tests__') && !p.endsWith('test-utils.ts'))) {
      const s = readFileSync(f, 'utf8');
      expect(s).not.toMatch(/async-storage|react-native|from ['"]react['"]|node:fs|node:child_process|\bfetch\(|\beval\(|new Function|writeDocs|writeInstances|clearData|\bcreateApex\b/);
    }
  });
});
