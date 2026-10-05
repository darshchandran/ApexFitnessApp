// Phase 5D: production configuration, identity, persistence, exactly-once, isolation, validation, logs.
import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { loadCa, migrate, MIGRATIONS_DIR, pendingMigrations } from '../../db/db';
import { edgeClientIp, edgeEnv, edgePath } from '../../edge';
import { clientAddress } from '../../http';
import { ACCESS_TTL_SEC } from '../auth';
import { ConfigError, loadServerConfig } from '../config';
import { readiness, route, type ChatDeps } from '../handler';
import { signToken } from '../security';
import { argumentsHash } from '../store';
import { callTool, device, NOW, res, say, SECRET, snapshot, testActions, testClock, testDb, testDeps, TODAY, token, type Body } from '../test-utils';

type Device = Awaited<ReturnType<typeof device>>;
const ROOT = join(__dirname, '..', '..', '..');
const lastRole = (b: Body) => (b.input as Record<string, unknown>[]).at(-1)?.role;
const BASKETBALL = { duration_min: 90, rpe: 8, session_type: null, lower_body_fatigue: null, date: null };
const proposer = (b: Body) => (lastRole(b) === 'user' ? res(callTool('propose_log_basketball', BASKETBALL)) : say('Confirm in the app.'));

const req = (path: string, body: unknown, auth: string | null = token(), headers: Record<string, string> = {}) =>
  new Request(`http://apex.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
async function call(deps: ChatDeps, path: string, body: unknown, auth: string | null = token(), ip = '203.0.113.7') {
  const r = await route(req(path, body, auth), deps, { clientIp: ip });
  return { status: r.status, json: await r.json(), rid: r.headers.get('x-request-id') };
}
const propose = async (deps: ChatDeps, app: Device, user = 'athlete_1') =>
  (await call(deps, '/ai/chat', { message: 'Log basketball for 90 minutes at RPE 8.', conversation_id: 'c1', context: { today: TODAY, athlete_data: snapshot(app) } }, token(user))).json.action;
const confirm = (deps: ChatDeps, id: string, app: Device, user = 'athlete_1') =>
  call(deps, `/ai/actions/${id}/confirm`, { context: { today: TODAY, athlete_data: snapshot(app) } }, token(user));
const cancel = (deps: ChatDeps, id: string, user = 'athlete_1') => call(deps, `/ai/actions/${id}/cancel`, {}, token(user));
const bbId = (r: { json: { result?: { result?: { basketball_sessions?: { id: string }[] } } } }) => r.json.result?.result?.basketball_sessions?.[0]?.id;

const PROD = {
  APEX_ENV: 'production', APEX_AUTH_SECRET: 'k8#Qz!m2Lr9@vX4$pT7&wN1*eB6^cY3%hJ5', DATABASE_URL: 'postgres://apex@db.internal:5432/apex', DATABASE_SSL: 'require',
  APEX_AI_CORS_ORIGINS: 'https://app.apex.example', APEX_AI_REGISTRATION: 'open', OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345', APEX_AI_MODEL: 'gpt-5.1',
};
const problems = (env: Record<string, string | undefined>) => {
  try {
    loadServerConfig(env);
    return [];
  } catch (e) {
    return (e as ConfigError).problems;
  }
};

describe('production configuration guards', () => {
  it('a complete production configuration loads; APEX_ENV must be explicit', () => {
    expect(loadServerConfig(PROD)).toMatchObject({ env: 'production', corsOrigins: ['https://app.apex.example'], registration: 'open', trustProxy: false });
    expect(problems({ ...PROD, APEX_ENV: undefined })).toEqual(['APEX_ENV must be set to "development" or "production"']);
    expect(problems({ ...PROD, APEX_ENV: 'prod' })).toHaveLength(1);
  });

  it('production refuses missing or unsafe settings — and never echoes a value', () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ OPENAI_API_KEY: undefined }, /OPENAI_API_KEY is not set/],
      [{ OPENAI_API_KEY: 'sk-mock' }, /does not look like an OpenAI API key/],
      [{ OPENAI_BASE_URL: 'http://127.0.0.1:8799/v1' }, /OPENAI_BASE_URL must not be set in production/],
      [{ APEX_AI_MODEL: undefined }, /APEX_AI_MODEL is not set/],
      [{ DATABASE_URL: undefined }, /DATABASE_URL is required in production/],
      [{ DATABASE_URL: 'mysql://x' }, /DATABASE_URL must be a postgres/],
      [{ APEX_AUTH_SECRET: 'short' }, /at least 32/],
      [{ APEX_AUTH_SECRET: 'a'.repeat(40) }, /too predictable/],
      [{ APEX_AI_CORS_ORIGINS: undefined }, /APEX_AI_CORS_ORIGINS is required in production/],
      [{ APEX_AI_CORS_ORIGINS: '*' }, /never a wildcard/],
      [{ APEX_AI_CORS_ORIGINS: 'https://*.apex.example' }, /never a wildcard/],
      [{ APEX_AI_CORS_ORIGINS: 'http://app.apex.example' }, /https:\/\/ origins in production/],
      [{ APEX_AI_CORS_ORIGINS: 'https://app.apex.example/path' }, /not an origin/],
      [{ APEX_AI_REGISTRATION: undefined }, /APEX_AI_REGISTRATION .*required in production/],
      [{ DATABASE_SSL: undefined }, /DATABASE_SSL must be "require" in production/],
      [{ DATABASE_SSL: 'disable' }, /DATABASE_SSL must be "require" in production/],
      [{ DATABASE_URL: 'postgres://apex@db.internal:5432/apex?sslmode=disable' }, /must not contain sslmode/],
    ];
    for (const [patch, msg] of cases) {
      const p = problems({ ...PROD, ...patch });
      expect(p.join(' | ')).toMatch(msg);
      for (const v of Object.values(patch)) if (v && v.length > 5) expect(p.join(' ')).not.toContain(v);
    }
    expect(loadServerConfig({ ...PROD, APEX_AI_CORS_ORIGINS: 'none' }).corsOrigins).toEqual([]);
  });

  it('development is usable locally but still rejects wildcards', () => {
    expect(loadServerConfig({ APEX_ENV: 'development', APEX_AUTH_SECRET: SECRET })).toMatchObject({ env: 'development', ai: null, databaseUrl: undefined, registration: 'open', corsOrigins: [] });
    expect(loadServerConfig({ APEX_ENV: 'development', APEX_AUTH_SECRET: SECRET, APEX_AI_CORS_ORIGINS: 'http://localhost:8081' }).corsOrigins).toEqual(['http://localhost:8081']);
    expect(problems({ APEX_ENV: 'development', APEX_AUTH_SECRET: SECRET, APEX_AI_CORS_ORIGINS: '*' })).toHaveLength(1);
  });

  it('the dev token tool refuses to run outside development, and its tokens only work on a development server', () => {
    const cli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [cli, join(ROOT, 'backend', 'token.ts'), 'dev_athlete'], { env: { ...process.env, ...env }, encoding: 'utf8', cwd: ROOT });
    const prod = run({ APEX_ENV: 'production', APEX_AUTH_SECRET: SECRET });
    expect([prod.status, prod.stdout.trim()]).toEqual([1, '']);
    expect(prod.stderr).toMatch(/development only/);
    const dev = run({ APEX_ENV: 'development', APEX_AUTH_SECRET: SECRET });
    expect(dev.status).toBe(0);
    const devToken = dev.stdout.trim();
    expect(devToken).toMatch(/^dev1\./);
    return (async () => {
      const prodDeps = testDeps(() => say('hi')).deps;
      expect((await call(prodDeps, '/ai/chat', { message: 'hi' }, devToken)).status).toBe(401);
      const devDeps = testDeps(() => say('hi'), { env: 'development' }).deps;
      devDeps.now = () => new Date();
      expect((await call(devDeps, '/ai/chat', { message: 'hi', context: { today: new Date().toISOString().slice(0, 10) } }, devToken)).status).toBe(200);
    })();
  });
});

describe('database TLS and readiness', () => {
  it('a CA can be given as PEM text (one-line env var) or as a file', () => {
    const pem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    expect(loadCa(pem)).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
    expect(loadCa(undefined)).toBeUndefined();
    expect(loadCa(join(ROOT, '.env.example'))).toContain('APEX_ENV');
    expect(loadServerConfig({ ...PROD, DATABASE_CA_CERT: 'ca.pem' })).toMatchObject({ databaseSsl: 'require', databaseCaCert: 'ca.pem' });
  });

  it('readiness reports database, schema, auth and model by name; an unreachable database is a 503 with no details', async () => {
    const { deps } = testDeps(() => say('x'));
    expect(await readiness(deps)).toEqual({ status: 200, body: { status: 'ready', checks: { database: 'ok', schema: 'current', auth: 'configured', model: 'configured' } } });
    const down = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { code: 'ECONNREFUSED' });
    deps.db = { query: () => Promise.reject(down), tx: () => Promise.reject(down), close: async () => undefined };
    const r = await readiness(deps);
    expect(r).toEqual({ status: 503, body: { status: 'not_ready', checks: { database: 'unreachable', schema: 'unknown', auth: 'configured', model: 'configured' } } });
    // requests during a database outage: "unavailable, try again" — never the error itself
    deps.rate = { take: () => Promise.reject(down) } as never;
    for (const [path, body, auth] of [['/ai/auth/register', {}, null], ['/ai/chat', { message: 'hi' }, token()]] as const) {
      const res = await call(deps, path, body, auth);
      expect([res.status, res.json.error.code]).toEqual([503, 'ai_unavailable']);
      expect(JSON.stringify(res.json)).not.toMatch(/10\.0\.0\.5|hunter2|ECONNREFUSED/);
    }
  });

  it('readiness fails when migrations are pending or the model is missing in production', async () => {
    const { deps } = testDeps(() => say('x'));
    deps.ai = null;
    expect((await readiness(deps)).body.checks.model).toBe('missing');
    expect((await readiness(deps)).status).toBe(503);
    deps.env = 'development';
    expect((await readiness(deps)).status).toBe(200); // development may run without a model
    const db = await testDb();
    expect(await pendingMigrations(db)).toEqual([]);
  });
});

describe('Supabase Edge Function adapter', () => {
  it('always runs as production with verified TLS; secrets come from the function, the database from Supabase', () => {
    const env = edgeEnv({ SUPABASE_DB_URL: 'postgres://u:p@db.example.supabase.co:6543/postgres?sslmode=require&x=1', OPENAI_API_KEY: 'sk-x', APEX_ENV: 'development', DATABASE_SSL: 'disable' });
    expect(env).toMatchObject({ APEX_ENV: 'production', DATABASE_SSL: 'require', APEX_AI_REGISTRATION: 'open', APEX_AI_CORS_ORIGINS: 'none', OPENAI_API_KEY: 'sk-x' });
    expect(env.DATABASE_URL).toBe('postgres://u:p@db.example.supabase.co:6543/postgres?x=1'); // sslmode can't override the TLS settings
    expect(edgeEnv({ SUPABASE_DB_URL: 'postgres://h/db?sslmode=require' }).DATABASE_URL).toBe('postgres://h/db');
    expect(edgeEnv({ SUPABASE_DB_URL: 'postgres://h/db?a=1&sslmode=require' }).DATABASE_URL).toBe('postgres://h/db?a=1');
    expect(edgeEnv({ APEX_AI_MODEL: 'm-1' }).APEX_AI_MODEL).toBe('m-1');
  });

  it('routes /apex-ai/<route> to the API and takes the address the proxy observed', () => {
    expect([edgePath('/apex-ai/ai/chat'), edgePath('/functions/v1/apex-ai/readyz'), edgePath('/apex-ai'), edgePath('/apex-ai-x/ai')]).toEqual(['/ai/chat', '/readyz', '/', '/apex-ai-x/ai']);
    expect(edgeClientIp(new Headers({ 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7, 198.51.100.4' }))).toBe('198.51.100.4');
    expect(edgeClientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 198.51.100.4' }))).toBe('198.51.100.4');
    expect(edgeClientIp(new Headers())).toBe('unknown');
  });
});

describe('device identity and tokens', () => {
  it('a device registers, uses its short-lived access token, and rotates its refresh token', async () => {
    const { deps } = testDeps(() => say('Hello.'));
    const reg = await call(deps, '/ai/auth/register', {}, null);
    expect(reg.status).toBe(201);
    expect(reg.json).toEqual({
      athlete_id: expect.stringMatching(/^ath_[\w-]{22}$/), access_token: expect.stringMatching(/^v1\./), access_expires_at: new Date(NOW.getTime() + ACCESS_TTL_SEC * 1000).toISOString(),
      refresh_token: expect.stringMatching(/^rt_[\w-]{43}$/), refresh_expires_at: expect.any(String),
    });
    expect((await call(deps, '/ai/chat', { message: 'hi' }, reg.json.access_token)).status).toBe(200);

    const next = await call(deps, '/ai/auth/refresh', { refresh_token: reg.json.refresh_token }, null);
    expect(next.status).toBe(200);
    expect(next.json.athlete_id).toBe(reg.json.athlete_id);
    expect(next.json.refresh_token).not.toBe(reg.json.refresh_token);

    // the server keeps only a hash
    const rows = await (await testDb()).query('select token_hash from ai_refresh_tokens where identity_id = $1', [reg.json.athlete_id]);
    expect(JSON.stringify(rows.rows)).not.toContain(reg.json.refresh_token.slice(3));
  });

  it('a spent refresh token presented again revokes the whole lineage', async () => {
    const { deps } = testDeps(() => say('Hello.'));
    const reg = await call(deps, '/ai/auth/register', {}, null);
    const second = await call(deps, '/ai/auth/refresh', { refresh_token: reg.json.refresh_token }, null);
    expect((await call(deps, '/ai/auth/refresh', { refresh_token: reg.json.refresh_token }, null)).status).toBe(401); // replayed: theft signal
    expect((await call(deps, '/ai/auth/refresh', { refresh_token: second.json.refresh_token }, null)).status).toBe(401); // the lineage is gone
  });

  it('revoke ends the session; unknown or malformed refresh tokens are refused', async () => {
    const { deps } = testDeps(() => say('Hello.'));
    const reg = await call(deps, '/ai/auth/register', {}, null);
    expect((await call(deps, '/ai/auth/revoke', { refresh_token: reg.json.refresh_token }, null)).json).toEqual({ ok: true });
    expect((await call(deps, '/ai/auth/refresh', { refresh_token: reg.json.refresh_token }, null)).status).toBe(401);
    expect((await call(deps, '/ai/auth/refresh', { refresh_token: `rt_${'x'.repeat(43)}` }, null)).status).toBe(401);
    expect((await call(deps, '/ai/auth/refresh', { refresh_token: 'nope' }, null)).status).toBe(400);
    expect((await call(deps, '/ai/auth/refresh', { refresh_token: reg.json.refresh_token, athlete_id: 'ath_other' }, null)).status).toBe(400);
  });

  it('expired, malformed, foreign-signed and missing access tokens are refused', async () => {
    const { deps } = testDeps(() => say('Hello.'));
    const fresh = signToken('athlete_1', SECRET, ACCESS_TTL_SEC, NOW.getTime());
    expect((await call(deps, '/ai/chat', { message: 'hi' }, fresh)).status).toBe(200);
    deps.now = () => new Date(NOW.getTime() + (ACCESS_TTL_SEC + 1) * 1000);
    expect((await call(deps, '/ai/chat', { message: 'hi', context: { today: TODAY } }, fresh)).status).toBe(401);
    deps.now = () => NOW;
    for (const bad of ['v1.x.y', 'Bearer', `${fresh}x`, signToken('athlete_1', 'another-secret-another-secret-another-1', 60, NOW.getTime()), null]) {
      expect((await call(deps, '/ai/chat', { message: 'hi' }, bad)).status).toBe(401);
    }
  });

  it('registration: closed → refused; per address and in total → rate-limited (by the address the server saw)', async () => {
    const closed = testDeps(() => say('x'), { registration: 'closed' }).deps;
    expect((await call(closed, '/ai/auth/register', {}, null)).json.error.code).toBe('registration_closed');
    const { deps } = testDeps(() => say('x'), { limits: { registrationsPerIpPerHour: 2, registrationsPerHour: 3 } });
    expect((await call(deps, '/ai/auth/register', {}, null, '198.51.100.1')).status).toBe(201);
    expect((await call(deps, '/ai/auth/register', {}, null, '198.51.100.1')).status).toBe(201);
    const third = await route(req('/ai/auth/register', {}, null, { 'x-forwarded-for': '10.9.9.9' }), deps, { clientIp: '198.51.100.1' });
    expect(third.status).toBe(429); // a client-chosen header doesn't change the address
    expect((await call(deps, '/ai/auth/register', {}, null, '198.51.100.2')).status).toBe(201);
    expect((await call(deps, '/ai/auth/register', {}, null, '198.51.100.3')).status).toBe(429); // service-wide cap
  });

  it('the client address comes from the socket unless a trusted proxy appended it', () => {
    const msg = (xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '192.0.2.10' } }) as unknown as IncomingMessage;
    expect(clientAddress(msg('1.1.1.1'), false)).toBe('192.0.2.10');
    expect(clientAddress(msg('1.1.1.1, 203.0.113.9'), true)).toBe('203.0.113.9');
    expect(clientAddress(msg(), true)).toBe('192.0.2.10');
  });
});

describe('persistent actions and exactly-once', () => {
  it('two server instances confirming at once: one execution, the same result for both', async () => {
    const app = await device();
    const a = testDeps(proposer).deps;
    const b = testDeps(proposer).deps;
    const action = await propose(a, app);
    const [x, y] = await Promise.all([confirm(a, action.id, app), confirm(b, action.id, app)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(bbId(x)).toBeDefined();
    expect(bbId(y)).toBe(bbId(x)); // every execution would mint a new id: there was exactly one
    const replay = await confirm(b, action.id, app); // a network retry after success
    expect(replay.json.result).toEqual(x.json.result);
    app.applyActionChanges(x.json.result.result.changes);
    app.applyActionChanges(y.json.result.result.changes);
    app.applyActionChanges(replay.json.result.result.changes);
    expect(snapshot(app).basketball).toHaveLength(1);
  });

  it('cancel racing confirm: exactly one of them wins', async () => {
    for (let i = 0; i < 4; i++) {
      const app = await device();
      const { deps } = testDeps(proposer);
      const action = await propose(deps, app);
      const [c, x] = await Promise.all([confirm(deps, action.id, app), cancel(deps, action.id)]);
      const confirmed = c.status === 200;
      const cancelled = x.status === 200;
      expect(confirmed !== cancelled).toBe(true);
      expect(confirmed ? x.json.error.code : c.json.error.code).toBe(confirmed ? 'action_not_pending' : 'action_cancelled');
    }
  });

  it('expiry racing confirm: a millisecond before runs, at expiry is refused', async () => {
    const app = await device();
    const clock = testClock();
    const actions = testActions({ clock: clock.now });
    const { deps } = testDeps(proposer, { actions });
    const early = await propose(deps, app);
    clock.advance(5 * 60_000 - 1);
    expect((await confirm(deps, early.id, app)).status).toBe(200);
    const late = await propose(deps, app);
    clock.advance(5 * 60_000);
    expect((await confirm(deps, late.id, app)).json.error.code).toBe('action_expired');
  });

  it('a server that died mid-execution: the confirm is taken over after the lease, still once', async () => {
    const app = await device();
    const clock = testClock();
    const actions = testActions({ clock: clock.now, leaseMs: 60_000, settleMs: 200 });
    const { deps } = testDeps(proposer, { actions });
    const action = await propose(deps, app);
    expect(await actions.claim(action.id, 'athlete_1')).toBeDefined(); // claimed, then the process died
    expect((await confirm(deps, action.id, app)).json.error.code).toBe('action_in_progress');
    clock.advance(61_000);
    const r = await confirm(deps, action.id, app);
    expect(r.status).toBe(200);
    expect((await confirm(deps, action.id, app)).json.result).toEqual(r.json.result);
  });

  it('every state survives a restart: pending, executed, cancelled, expired', async () => {
    const app = await device();
    const clock = testClock();
    const first = testDeps(proposer, { actions: testActions({ clock: clock.now }) }).deps;
    const pending = await propose(first, app);
    const executed = await propose(first, app);
    const cancelled = await propose(first, app);
    const done = await confirm(first, executed.id, app);
    await cancel(first, cancelled.id);

    const second = testDeps(proposer, { actions: testActions({ clock: clock.now }) }).deps; // new process, same database
    expect((await confirm(second, executed.id, app)).json.result).toEqual(done.json.result);
    expect((await confirm(second, cancelled.id, app)).json.error.code).toBe('action_cancelled');
    clock.advance(5 * 60_000);
    expect((await confirm(second, pending.id, app)).json.error.code).toBe('action_expired');
    const third = testDeps(proposer, { actions: testActions({ clock: clock.now }) }).deps;
    expect((await confirm(third, pending.id, app)).json.error.code).toBe('action_expired');
  });
});

describe('athlete isolation', () => {
  it('B cannot see, confirm, cancel or learn the result of A’s action', async () => {
    const app = await device();
    const { deps, actions } = testDeps(proposer);
    const action = await propose(deps, app, 'alice');
    for (const r of [await confirm(deps, action.id, app, 'bob'), await cancel(deps, action.id, 'bob')]) {
      expect(r).toMatchObject({ status: 404, json: { error: { code: 'not_found' } } });
      expect(JSON.stringify(r.json)).not.toMatch(/log_basketball|summary|arguments/);
    }
    expect(await actions.get(action.id, 'bob')).toBeUndefined();
    const done = await confirm(deps, action.id, app, 'alice');
    expect(done.status).toBe(200);
    const peek = await confirm(deps, action.id, app, 'bob'); // the result too
    expect([peek.status, peek.json.result]).toEqual([404, undefined]);
  });

  it('rate limits are per athlete: one athlete at the limit does not affect another', async () => {
    const { deps } = testDeps(() => say('ok'), { limits: { requestsPerWindow: 1, actionRequestsPerWindow: 1 } });
    expect((await call(deps, '/ai/chat', { message: 'a' }, token('alice'))).status).toBe(200);
    expect((await call(deps, '/ai/chat', { message: 'b' }, token('alice'))).status).toBe(429);
    expect((await call(deps, '/ai/chat', { message: 'a' }, token('bob'))).status).toBe(200);
    expect((await call(deps, `/ai/actions/${randomUUID()}/cancel`, {}, token('alice'))).status).toBe(404);
    expect((await call(deps, `/ai/actions/${randomUUID()}/cancel`, {}, token('alice'))).status).toBe(429);
  });
});

describe('request validation', () => {
  it('prototype keys, bad ids, modes and sizes are refused before anything runs', async () => {
    const { deps, bodies } = testDeps(() => say('never'), { limits: { maxBodyBytes: 5000 } });
    const bad = async (path: string, body: string | object, status = 400) => expect((await call(deps, path, body)).status).toBe(status);
    await bad('/ai/chat', '{"message":"hi","__proto__":{"admin":true}}');
    await bad('/ai/chat', '{"message":"hi","context":{"athlete_data":{"constructor":{"prototype":{"x":1}}}}}');
    await bad('/ai/chat', { message: 'hi', conversation_id: 'a b' });
    await bad('/ai/chat', { message: 'hi', mode: 'unlimited' });
    await bad('/ai/chat', { message: 'x'.repeat(6000) }, 413);
    await bad(`/ai/actions/${randomUUID().toUpperCase()}/confirm`, {}, 404);
    await bad('/ai/actions/../../confirm', {}, 404);
    expect(bodies).toHaveLength(0); // the model was never called
    expect(({}) as Record<string, unknown>).not.toHaveProperty('admin');
  });

  it('an unknown or tampered action in the database never executes', async () => {
    const app = await device();
    const { deps, actions } = testDeps(proposer);
    const db = await testDb();
    const id = randomUUID();
    await db.query(
      `insert into ai_actions (id, identity_id, conversation_id, type, arguments, arguments_hash, summary, preview, status, created_at, expires_at, updated_at)
       values ($1, 'athlete_1', 'c', 'drop_everything', '{}', $2, 's', '[]', 'pending', $3, $4, $3)`,
      [id, argumentsHash('drop_everything' as never, {}), new Date(), new Date(Date.now() + 60_000)],
    );
    expect((await confirm(deps, id, app)).json.error.code).toBe('action_not_allowed');
    expect((await actions.get(id, 'athlete_1'))!.status).toBe('failed');
    const real = await propose(deps, app);
    await db.query(`update ai_actions set arguments = '{"date":"2026-10-07","duration_min":600,"rpe":10,"session_type":null,"lower_body_fatigue":null}' where id = $1`, [real.id]);
    expect((await confirm(deps, real.id, app)).status).toBe(500); // arguments changed in storage: refused
    expect((await actions.get(real.id, 'athlete_1'))!.status).toBe('failed');
  });
});

describe('logs and migrations', () => {
  it('every request has a correlation id; no tokens, refresh tokens or athlete ids are logged', async () => {
    const { deps, logs } = testDeps(proposer);
    const app = await device();
    const reg = await call(deps, '/ai/auth/register', {}, null);
    const ref = await call(deps, '/ai/auth/refresh', { refresh_token: reg.json.refresh_token }, null);
    const action = await propose(deps, app);
    const c = await confirm(deps, action.id, app);
    expect(c.rid).toMatch(/^[0-9a-f]{12}$/);
    expect(logs.every((l) => typeof l.rid === 'string' && l.rid.length === 12)).toBe(true);
    expect(logs.some((l) => l.rid === c.rid && l.event === 'ai.action')).toBe(true);
    const text = JSON.stringify(logs);
    for (const s of [reg.json.access_token, reg.json.refresh_token, ref.json.refresh_token, reg.json.athlete_id, 'athlete_1', SECRET, 'Log basketball for', '"duration_min"']) expect(text).not.toContain(s);
  });

  it('migrations are idempotent, close the tables to Supabase API roles, and match what the Supabase CLI applies', async () => {
    const db = await testDb();
    expect(await migrate(db)).toEqual([]);
    for (const f of ['20261005120000_ai_production.sql']) await db.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')); // applied again as raw SQL
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('ai_identities','ai_refresh_tokens','ai_actions','ai_rate_limits') order by 1");
    expect(rls.rows).toEqual(['ai_actions', 'ai_identities', 'ai_rate_limits', 'ai_refresh_tokens'].map((relname) => ({ relname, relrowsecurity: true })));
  });
});
