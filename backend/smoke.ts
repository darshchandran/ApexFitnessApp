// LIVE smoke test for a DEPLOYED APEX AI backend: real HTTPS, real database, real OpenAI.
// Nothing is mocked — a failure is reported as FAIL with its category, never hidden.
//
//   npm run ai:smoke -- --url https://ai.example.com            all live checks (~2 min)
//   npm run ai:smoke -- --url … --phase restart-before           then restart/redeploy the backend, then:
//   npm run ai:smoke -- --url … --phase restart-after
//   npm run ai:smoke -- --url … --phase client                  the app's own AI client code end to end
//   options: --slow (action + access-token expiry, ~15 min)  --registration-limit (registers until 429)
//
// It uses throwaway install identities and synthetic athlete data built with APEX's own seed and
// services (no real athlete data), revokes those identities at the end, and prints request ids so
// the matching server log lines can be inspected. It never reads or prints a server secret.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore, writeAll } from '../src/data/store';
import { seedData } from '../src/domain/seed';
import type { ApexData } from '../src/domain/types';
import { aiServerUrl, createAssistant, type ApexMessage } from '../src/services/ai';
import { memorySecrets } from '../src/services/aiSession';
import { createApex, todayOverview, type ActionChanges } from '../src/services/apex';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const BASE = (arg('url') ?? '').replace(/\/+$/, '');
const PHASE = arg('phase') ?? 'all';
const STATE = join(tmpdir(), 'apex-ai-smoke-state.json');

type Outcome = { name: string; result: 'PASS' | 'FAIL' | 'SKIPPED'; detail?: string };
const outcomes: Outcome[] = [];
const requestIds: Record<string, string> = {};
const identities: string[] = []; // refresh tokens to revoke at the end (never printed)
const athleteIds: string[] = []; // the synthetic test identities, for optional cleanup

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    outcomes.push({ name, result: 'PASS', ...(detail && { detail }) });
  } catch (e) {
    outcomes.push({ name, result: 'FAIL', detail: (e as Error).message });
  }
}
const skip = (name: string, why: string) => outcomes.push({ name, result: 'SKIPPED', detail: why });
function must(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(why);
}

// ---------- HTTP ----------

interface Reply { status: number; json: any; rid: string | null }
async function http(method: 'GET' | 'POST', path: string, body?: unknown, token?: string, label?: string): Promise<Reply> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  const rid = r.headers.get('x-request-id');
  if (label && rid) requestIds[label] = rid;
  return { status: r.status, json: await r.json().catch(() => null), rid };
}
const code = (r: Reply) => r.json?.error?.code ?? r.status;

interface Session { athlete: string; access: string; refresh: string }
async function register(label: string): Promise<Session> {
  const r = await http('POST', '/ai/auth/register', {}, undefined, label);
  must(r.status === 201, `registration answered ${code(r)}`);
  identities.push(r.json.refresh_token);
  athleteIds.push(r.json.athlete_id);
  return { athlete: r.json.athlete_id, access: r.json.access_token, refresh: r.json.refresh_token };
}

// ---------- a synthetic athlete on this machine (APEX's own seed + services) ----------

async function phone(data?: ApexData) {
  const store = memoryStore();
  await writeAll(store, data ?? seedData(new Date()));
  const app = createApex(store, () => new Date());
  await app.init();
  return { app, store };
}
type Phone = Awaited<ReturnType<typeof phone>>;
const ctx = (p: Phone) => ({ today: p.app.today(), athlete_data: p.app.getState().data });
const chat = (s: Session, p: Phone, message: string, label?: string, conversation_id = 'smoke') =>
  http('POST', '/ai/chat', { message, conversation_id, context: ctx(p) }, s.access, label);
const confirm = (s: Session, id: string, p: Phone, label?: string) => http('POST', `/ai/actions/${id}/confirm`, { context: ctx(p) }, s.access, label);
const cancel = (s: Session, id: string, label?: string) => http('POST', `/ai/actions/${id}/cancel`, {}, s.access, label);
const changes = (r: Reply) => r.json.result.result.changes as ActionChanges;
/** "Reload": the same storage, a fresh app start. */
const reload = async (p: Phone) => {
  const app = createApex(p.store, () => new Date());
  await app.init();
  return { ...p, app };
};
async function proposeBasketball(s: Session, p: Phone, label: string, minutes = 60, rpe = 7) {
  const r = await chat(s, p, `Log basketball: ${minutes} minutes at RPE ${rpe}, today.`, label);
  must(r.status === 200, `chat answered ${code(r)}`);
  must(r.json.action_required && r.json.action?.type === 'log_basketball', 'the model did not propose log_basketball (model behaviour)');
  return r.json.action as { id: string };
}

// ---------- the checks ----------

async function all() {
  await check('HTTPS endpoint', async () => {
    if (BASE.startsWith('https://')) return;
    must(flag('allow-http'), 'the backend URL is not https://');
    return 'NOT https — allowed only for a local rehearsal (--allow-http)';
  });
  await check('liveness /healthz', async () => must((await http('GET', '/healthz')).status === 200, 'not 200'));
  await check('readiness /readyz (database, schema, auth, model)', async () => {
    const r = await http('GET', '/readyz');
    must(r.status === 200, `not ready: ${JSON.stringify(r.json?.checks ?? {})}`);
    return JSON.stringify(r.json.checks);
  });

  let a: Session | undefined;
  let b: Session | undefined;
  await check('register two test installs', async () => {
    a = await register('register-a');
    b = await register('register-b');
  });
  if (!a || !b) return;
  const A = a;
  const B = b;
  const p = await phone();

  for (const [label, q] of [['today', 'What is today\'s training plan?'], ['load', 'What is my recent training load?'], ['progression', 'Show my recent progression.']] as const) {
    await check(`real OpenAI answer: ${label}`, async () => {
      const r = await chat(A, p, q, `chat-${label}`, `smoke-${label}`);
      must(r.status === 200, `chat answered ${code(r)}`);
      must(typeof r.json.message === 'string' && r.json.message.length > 0, 'empty answer');
      return `model ${r.json.model}; tools ${r.json.tools_used.join(', ') || 'none'}`;
    });
  }

  // basketball: one session, survives reload, a second confirm adds nothing
  let executed: { id: string } | undefined;
  await check('basketball action: propose → confirm → exactly one session', async () => {
    executed = await proposeBasketball(A, p, 'propose-basketball');
    const r = await confirm(A, executed.id, p, 'confirm-basketball');
    must(r.status === 200 && r.json.result?.success, `confirm answered ${code(r)}`);
    p.app.applyActionChanges(changes(r));
    must(p.app.getState().data.basketball.length === 1, 'not exactly one session');
    const again = await confirm(A, executed.id, p, 'confirm-basketball-again');
    must(again.status === 200 && JSON.stringify(again.json.result) === JSON.stringify(r.json.result), 'the second confirm did not replay the same result');
    p.app.applyActionChanges(changes(again));
    must(p.app.getState().data.basketball.length === 1, 'the second confirm duplicated the session');
    await p.app.flush();
    const after = await reload(p);
    must(after.app.getState().data.basketball.length === 1, 'the session did not survive a reload');
  });

  // adaptation: a controlled state where APEX's engine adapts today's gym session
  await check('adapt today\'s workout: engine adaptation applied, template untouched', async () => {
    const q = await phone();
    const today = q.app.today();
    q.app.planSession('gym', 'legs'); // today's session: Legs
    q.app.logBasketball({ durationMin: 100, rpe: 9, sessionType: 'game', jumping: 3, lowerFatigue: 3 });
    const gym = todayOverview(q.app.getState().data, today).gym!;
    must(gym.decision.outcome !== 'normal', 'test state did not produce an adaptation');
    q.app.setPlanMode(gym.id, 'kept');
    const templates = JSON.stringify(q.app.getState().data.templates);
    const r = await chat(A, q, 'I kept today\'s plan earlier. Please switch today\'s gym session back to APEX\'s adaptation.', 'propose-adapt', 'smoke-adapt');
    must(r.status === 200, `chat answered ${code(r)}`);
    must(r.json.action?.type === 'adapt_today_workout', 'the model did not propose adapt_today_workout (model behaviour)');
    const c = await confirm(A, r.json.action.id, q, 'confirm-adapt');
    must(c.status === 200 && c.json.result?.success, `confirm answered ${code(c)}`);
    q.app.applyActionChanges(changes(c));
    const after = todayOverview(q.app.getState().data, today).gym!;
    must(after.plan === 'adapted', 'the adaptation was not applied on the device');
    await q.app.flush();
    const reloaded = await reload(q);
    must(todayOverview(reloaded.app.getState().data, today).gym!.plan === 'adapted', 'the adaptation did not survive a reload');
    must(JSON.stringify(reloaded.app.getState().data.templates) === templates, 'a template changed');
  });

  await check('athlete isolation: B cannot read, confirm, cancel or get A\'s action', async () => {
    must(executed, 'no action from A to test with');
    for (const r of [await confirm(B, executed.id, p, 'isolation-confirm'), await cancel(B, executed.id, 'isolation-cancel')]) {
      must(r.status === 404 && r.json?.error?.code === 'not_found', `B got ${code(r)}`);
      must(!r.json?.result && !r.json?.action, 'B saw action data');
    }
  });

  await check("cancelled action cannot be confirmed (and B cannot touch A's pending action)", async () => {
    const act = await proposeBasketball(A, await phone(), 'propose-cancel', 45, 5);
    for (const r of [await confirm(B, act.id, p, 'isolation-pending-confirm'), await cancel(B, act.id, 'isolation-pending-cancel')]) {
      must(r.status === 404 && r.json?.error?.code === 'not_found' && !r.json?.action, `B got ${code(r)} for A's pending action`);
    }
    must((await cancel(A, act.id, 'cancel')).status === 200, "cancel failed (B's attempts must not have changed it)");
    must(code(await confirm(A, act.id, p, 'confirm-cancelled')) === 'action_cancelled', 'a cancelled action was not refused');
  });

  if (flag('slow')) {
    // both waits run at once (~15 minutes)
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all([
      check('expired action cannot be confirmed (waits 5 minutes)', async () => {
        const act = await proposeBasketball(A, p, 'propose-expire');
        await wait(5 * 60_000 + 5_000);
        must(code(await confirm(A, act.id, p, 'confirm-expired')) === 'action_expired', 'an expired action was not refused');
      }),
      check('expired access token is refused; refresh restores access (waits 15 minutes)', async () => {
        const s = await register('register-expiry');
        await wait(15 * 60_000 + 10_000);
        const r = await http('POST', '/ai/chat', { message: 'hi' }, s.access, 'expired-token');
        must(r.status === 401 && r.json?.error?.code === 'unauthorized', `an expired token answered ${code(r)}`);
        const f = await http('POST', '/ai/auth/refresh', { refresh_token: s.refresh });
        must(f.status === 200, `refresh after expiry answered ${code(f)}`);
        identities.push(f.json.refresh_token);
      }),
    ]);
  } else {
    skip('expired action', 'run with --slow (waits 5 minutes)');
    skip('expired access token', 'run with --slow (waits 15 minutes)');
  }

  await check('invalid and malformed access tokens are refused', async () => {
    for (const t of ['garbage', `${A.access}x`, 'v1.e30.e30']) must((await http('POST', '/ai/chat', { message: 'hi' }, t)).status === 401, 'a bad token was accepted');
  });
  await check('a replayed refresh token revokes the session', async () => {
    const s = await register('register-c');
    const first = await http('POST', '/ai/auth/refresh', { refresh_token: s.refresh });
    must(first.status === 200, `refresh answered ${code(first)}`);
    identities.push(first.json.refresh_token);
    must((await http('POST', '/ai/auth/refresh', { refresh_token: s.refresh })).status === 401, 'a spent refresh token was accepted');
    must((await http('POST', '/ai/auth/refresh', { refresh_token: first.json.refresh_token })).status === 401, 'the lineage was not revoked');
  });
  await check('malformed requests are refused with a safe 400', async () => {
    for (const body of ['{not json', JSON.stringify({ message: 'x', conversation_id: 'c', context: { today: 'no' } }), '{"message":"x","conversation_id":"c","__proto__":{"a":1}}']) {
      const r = await http('POST', '/ai/chat', body, A.access, 'malformed');
      must(r.status === 400 && r.json?.error?.code === 'invalid_request', `malformed body answered ${code(r)}`);
      must(!/at \w+ \(|stack|postgres|sql/i.test(JSON.stringify(r.json)), 'the error exposed internals');
    }
  });

  // rate limits at their production values: invalid bodies are counted before validation, so no model cost
  await check('chat rate limit returns 429', async () => {
    for (let i = 0; i < 60; i++) {
      const r = await http('POST', '/ai/chat', {}, B.access);
      if (r.status === 429) return `429 after ${i + 1} requests (retry-after set)`;
    }
    throw new Error('no 429 within 60 requests');
  });
  await check('confirm/cancel rate limit returns 429', async () => {
    for (let i = 0; i < 200; i++) {
      const r = await http('POST', `/ai/actions/${crypto.randomUUID()}/cancel`, {}, B.access);
      if (r.status === 429) {
        // confirm shares the per-athlete action limit
        const c = await http('POST', `/ai/actions/${crypto.randomUUID()}/confirm`, { context: ctx(p) }, B.access);
        must(c.status === 429, `confirm after the limit answered ${code(c)}`);
        return `cancel: 429 after ${i + 1} requests; confirm: 429`;
      }
    }
    throw new Error('no 429 within 200 requests');
  });
  if (flag('registration-limit')) {
    await check('registration rate limit returns 429', async () => {
      for (let i = 0; i < 30; i++) {
        const r = await http('POST', '/ai/auth/register', {});
        if (r.status === 201) identities.push(r.json.refresh_token);
        if (r.status === 429) return `429 after ${i + 1} more registrations`;
      }
      throw new Error('no 429 within 30 registrations');
    });
  } else skip('registration rate limit', 'run with --registration-limit (creates up to 10 test identities, revoked afterwards)');

}

async function restartBefore() {
  await check('restart: create a pending action and execute another', async () => {
    const s = await register('restart-register');
    const p = await phone();
    const data = JSON.parse(JSON.stringify(p.app.getState().data));
    const pending = await proposeBasketball(s, p, 'restart-propose-pending', 75, 6);
    const run = await proposeBasketball(s, p, 'restart-propose-run');
    const done = await confirm(s, run.id, p, 'restart-confirm');
    must(done.status === 200, `confirm answered ${code(done)}`);
    writeFileSync(STATE, JSON.stringify({ base: BASE, refresh: s.refresh, pending: pending.id, executed: run.id, result: done.json.result, data }), { mode: 0o600 });
    identities.length = 0; // keep this session alive for the after-restart phase
    return 'now restart or redeploy the backend, then run --phase restart-after';
  });
}

async function restartAfter() {
  if (!existsSync(STATE)) return void outcomes.push({ name: 'restart', result: 'FAIL', detail: 'run --phase restart-before first' });
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  await check('restart: session, pending action and executed action survive', async () => {
    must(st.base === BASE, 'state belongs to a different backend URL');
    const r = await http('POST', '/ai/auth/refresh', { refresh_token: st.refresh }, undefined, 'restart-refresh');
    must(r.status === 200, `refresh after restart answered ${code(r)}`);
    identities.push(r.json.refresh_token);
    const s: Session = { athlete: r.json.athlete_id, access: r.json.access_token, refresh: r.json.refresh_token };
    const p = await phone(st.data);
    const later = await confirm(s, st.pending, p, 'restart-confirm-pending');
    must(later.status === 200 && later.json.result?.success, `pending action after restart answered ${code(later)}`);
    const replay = await confirm(s, st.executed, p, 'restart-replay');
    must(replay.status === 200 && JSON.stringify(replay.json.result) === JSON.stringify(st.result), 'the executed action did not replay its original result');
    p.app.applyActionChanges(st.result.result.changes);
    must(p.app.applyActionChanges(changes(replay)) === 0, 'the replay changed data');
    p.app.applyActionChanges(changes(later));
    must(p.app.getState().data.basketball.length === 2, 'expected exactly the two logged sessions');
  });
  rmSync(STATE, { force: true });
}

/**
 * The production app's flow with the app's own client code (src/services/ai.ts + the APEX data
 * service), wired as the production build wires it: built-in address, secure-store-like secrets,
 * conversation storage. Only the screen is missing — this drives what its buttons call.
 */
async function clientFlow() {
  const p = await phone();
  const chatStore = memoryStore(); // AsyncStorage on the device
  const secrets = memorySecrets(); // the Keychain / Keystore on the device
  const open = () => createAssistant({ store: chatStore, apex: p.app, secrets, defaultUrl: aiServerUrl(BASE, false) });
  let ai = open();
  const last = () => ai.getState().messages.at(-1) as ApexMessage | undefined;
  const ask = async (text: string) => {
    must(await ai.send(text), `no answer (${JSON.stringify(ai.getState().messages.at(-1))?.slice(0, 160)})`);
    must(last()?.role === 'apex' && last()!.text.length > 0, 'empty answer');
    return last()!;
  };

  await check('client: a production build uses this address and signs in', async () => {
    must(aiServerUrl(BASE, false) === BASE, 'a production build would ignore this address');
    await ai.init();
    must(ai.getState().connection?.url === BASE && !ai.getState().authFailed, 'not connected');
  });
  for (const [label, q] of [['today', "What's my training plan today?"], ['load', 'How has my training load been recently?'], ['progression', 'How am I progressing on my lifts?']] as const) {
    await check(`client: real AI answer — ${label}`, async () => `checked: ${(await ask(q)).checked.join(', ') || 'nothing'}`);
  }
  await check('client: basketball — propose, confirm, applied once, duplicate confirm ignored', async () => {
    const m = await ask('Log basketball for today: 55 minutes, RPE 7.');
    must(m.action?.type === 'log_basketball' && m.action.state === 'pending', 'no log_basketball proposal (model behaviour)');
    await ai.confirm(m.id);
    must(ai.getState().messages.find((x) => x.id === m.id)?.role === 'apex', 'message lost');
    const a = (ai.getState().messages.find((x) => x.id === m.id) as ApexMessage).action!;
    must(a.state === 'executed', `action ${a.state}: ${a.note ?? ''}`);
    must(p.app.getState().data.basketball.length === 1, 'not exactly one session on the device');
    await ai.confirm(m.id);
    must(p.app.getState().data.basketball.length === 1, 'a second confirm duplicated the session');
  });
  await check('client: reload keeps the session, the conversation and the sign-in', async () => {
    await Promise.all([ai.flush(), p.app.flush()]);
    const app = createApex(p.store, () => new Date());
    await app.init();
    must(app.getState().data.basketball.length === 1, 'the session did not survive a reload');
    ai = open();
    await ai.init();
    const executed = ai.getState().messages.find((x) => x.role === 'apex' && x.action?.type === 'log_basketball') as ApexMessage | undefined;
    must(executed?.action?.state === 'executed', 'the confirmed action did not survive a reload');
    await ask('Thanks. Anything else to note for today?');
  });
  await check('client: new conversation starts clean and works', async () => {
    const before = ai.getState().conversationId;
    await ai.newConversation();
    must(ai.getState().messages.length === 0, 'old messages kept');
    await ask('What is my readiness today?');
    must(ai.getState().conversationId !== before, 'the conversation id was reused');
    must(p.app.getState().data.basketball.length === 1, 'a new conversation changed athlete data');
  });
  await ai.disconnect().catch(() => undefined); // signs this install out (revokes its session)
}

async function main() {
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(BASE)) {
    console.error('Usage: npm run ai:smoke -- --url https://<apex-ai-backend> [--phase all|restart-before|restart-after] [--slow] [--registration-limit]');
    process.exit(2);
  }
  if (PHASE === 'restart-before') await restartBefore();
  else if (PHASE === 'restart-after') await restartAfter();
  else if (PHASE === 'client') await clientFlow();
  else await all();

  // clean up: revoke every test session this run created (actions expire and are purged by the server)
  for (const t of identities) await http('POST', '/ai/auth/revoke', { refresh_token: t }).catch(() => undefined);

  for (const o of outcomes) console.log(`${o.result.padEnd(7)} ${o.name}${o.detail ? ` — ${o.detail}` : ''}`);
  console.log(`request ids (for the server logs): ${JSON.stringify(requestIds)}`);
  if (athleteIds.length) {
    const list = athleteIds.map((id) => `'${id}'`).join(', ');
    console.log(`test identities (sessions revoked): ${athleteIds.join(', ')}`);
    console.log(`optional cleanup (Supabase SQL editor): delete from ai_actions where identity_id in (${list}); delete from ai_identities where id in (${list});`);
  }
  process.exitCode = outcomes.some((o) => o.result === 'FAIL') ? 1 : 0;
}

void main();
