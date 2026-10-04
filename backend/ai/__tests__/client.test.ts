// The app's APEX AI client (src/services/ai.ts) against the real backend routes — the contract the
// mobile screen relies on. Requests go through route(), exactly as the HTTP server calls it.
import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../../src/data/store';
import type { ApexData, WorkoutInstance } from '../../../src/domain/types';
import { createAssistant, NOTE, type ApexMessage } from '../../../src/services/ai';
import { todayOverview } from '../../../src/services/apex';
import { bball } from '../../../src/test-utils';
import { route, type ChatDeps } from '../handler';
import { callTool, device, NOW, res, say, snapshot, testActions, testClock, testDeps, TODAY, week, type Body } from '../test-utils';

type Device = Awaited<ReturnType<typeof device>>;
const lastRole = (b: Body) => (b.input as Record<string, unknown>[]).at(-1)?.role;
/** Proposes `tool(args)` for each new question, otherwise answers. */
const proposer = (tool: string, args: object) => (b: Body) => (lastRole(b) === 'user' ? res(callTool(tool, args)) : say('Waiting for your confirmation.'));
const BASKETBALL = { duration_min: 90, rpe: 8, session_type: null, lower_body_fatigue: null, date: null };
const gym = (d: ApexData) => todayOverview(d, TODAY).gym as WorkoutInstance;
const keep = (d: ApexData) => JSON.stringify({ templates: d.templates, plyoTemplates: d.plyoTemplates, profile: d.profile, plan: d.plan, records: d.records, settings: d.settings, history: d.instances.filter((i) => i.status === 'completed') });

/** The app on a phone talking to the real backend routes; `lose` drops the next confirm response after the server handled it. */
async function phone(deps: ChatDeps, app?: Device, opts: { now?: () => Date } = {}) {
  const athlete = app ?? (await device());
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const net = { offline: false, loseNextResponse: false };
  const ai = createAssistant({
    store: memoryStore(),
    apex: athlete,
    now: opts.now,
    async fetch(url, init) {
      if (net.offline) throw new TypeError('Network request failed');
      const path = new URL(url).pathname;
      sent.push({ path, body: JSON.parse(String(init.body)) });
      const r = await route(new Request(url, init), deps);
      if (net.loseNextResponse) {
        net.loseNextResponse = false;
        throw new TypeError('Network request failed'); // the server did the work; the reply never arrived
      }
      return r;
    },
  });
  await ai.init();
  await ai.connect('http://apex.test');
  return { ai, app: athlete, sent, net };
}
const lastAction = (ai: Awaited<ReturnType<typeof phone>>['ai']) => {
  const m = ai.getState().messages.filter((x): x is ApexMessage => x.role === 'apex').at(-1)!;
  return { id: m.id, action: m.action! };
};

describe('the app client and the Phase 5B backend', () => {
  it('a read-only question: answer shown, conversation id kept, nothing changed on the device', async () => {
    const { deps, bodies } = testDeps((b) => (lastRole(b) === 'user' ? res(callTool('get_training_load')) : say('Your load today is low.')));
    const { ai, app, sent } = await phone(deps);
    const before = snapshot(app);
    expect(await ai.send('What is my current training load?')).toBe(true);
    expect(ai.getState().messages.at(-1)).toMatchObject({ role: 'apex', text: 'Your load today is low.', checked: ['training load'] });
    await ai.send('And this week?');
    expect(sent.filter((x) => x.path === '/ai/chat')[1].body.conversation_id).toBe(ai.getState().conversationId);
    expect(bodies[2].input.slice(0, 2)).toEqual([{ role: 'user', content: 'What is my current training load?' }, { role: 'assistant', content: 'Your load today is low.' }]);
    expect(snapshot(app)).toEqual(before);
  });

  it('log basketball: proposal → confirm → applyActionChanges → exactly one session, nothing else touched', async () => {
    const { deps } = testDeps(proposer('propose_log_basketball', BASKETBALL));
    const { ai, app, sent } = await phone(deps);
    const before = snapshot(app);
    await ai.send('Log basketball for 90 minutes at RPE 8.');
    const { id, action } = lastAction(ai);
    expect(action).toMatchObject({ type: 'log_basketball', state: 'pending', arguments: { duration_min: 90, rpe: 8, date: TODAY } });
    expect(snapshot(app)).toEqual(before); // nothing happens until the athlete confirms

    await Promise.all([ai.confirm(id), ai.confirm(id)]); // a double tap
    expect(sent.filter((s) => s.path.endsWith('/confirm'))).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ path: `/ai/actions/${action.id}/confirm`, body: { arguments: action.arguments, context: { today: TODAY } } });
    expect(lastAction(ai).action).toMatchObject({ state: 'executed', note: 'Basketball session logged.' });
    const after = snapshot(app);
    expect(after.basketball).toEqual([expect.objectContaining({ durationMin: 90, rpe: 8, date: TODAY })]);
    expect(keep(after)).toBe(keep(before));
    expect(todayOverview(after, TODAY).load.basketball).toBeGreaterThan(0);
    await ai.confirm(id); // executed: nothing to do
    expect(sent.filter((s) => s.path.endsWith('/confirm'))).toHaveLength(1);
  });

  it('a lost confirm response is never retried automatically; confirming again finishes it once', async () => {
    const { deps } = testDeps(proposer('propose_log_basketball', BASKETBALL));
    const { ai, app, sent, net } = await phone(deps);
    await ai.send('Log basketball for 90 minutes at RPE 8.');
    const { id } = lastAction(ai);
    net.loseNextResponse = true;
    await ai.confirm(id);
    expect(lastAction(ai).action).toMatchObject({ state: 'pending', note: NOTE.offline });
    expect(snapshot(app).basketball).toHaveLength(0);
    expect(sent.filter((s) => s.path.endsWith('/confirm'))).toHaveLength(1);
    await ai.confirm(id); // the athlete taps again: the server returns the one result
    expect(lastAction(ai).action.state).toBe('executed');
    expect(snapshot(app).basketball).toHaveLength(1);
  });

  it('cancel calls the cancel endpoint and changes nothing', async () => {
    const { deps } = testDeps(proposer('propose_log_basketball', BASKETBALL));
    const { ai, app, sent } = await phone(deps);
    await ai.send('Log basketball for 90 minutes at RPE 8.');
    const before = snapshot(app);
    const { id, action } = lastAction(ai);
    await ai.cancel(id);
    expect(sent.at(-1)!.path).toBe(`/ai/actions/${action.id}/cancel`);
    expect(lastAction(ai).action).toMatchObject({ state: 'cancelled', note: NOTE.cancelled });
    await ai.confirm(id);
    expect(sent.filter((s) => s.path.endsWith('/confirm'))).toHaveLength(0);
    expect(snapshot(app)).toEqual(before);
  });

  it('expired: by the server (410) or already past on the phone (no request at all)', async () => {
    const clock = testClock();
    const { deps } = testDeps(proposer('propose_log_basketball', BASKETBALL), { actions: testActions({ clock: clock.now }) });
    const { ai, app } = await phone(deps);
    await ai.send('Log basketball for 90 minutes at RPE 8.');
    clock.advance(5 * 60_000);
    await ai.confirm(lastAction(ai).id);
    expect(lastAction(ai).action).toMatchObject({ state: 'expired', note: NOTE.expired });
    expect(snapshot(app).basketball).toHaveLength(0);

    const later = await phone(testDeps(proposer('propose_log_basketball', BASKETBALL)).deps, undefined, { now: () => new Date(Date.now() + 6 * 60_000) });
    await later.ai.send('Log basketball for 90 minutes at RPE 8.');
    await later.ai.confirm(lastAction(later.ai).id);
    expect(lastAction(later.ai).action.state).toBe('expired');
    expect(later.sent.filter((s) => s.path.endsWith('/confirm'))).toHaveLength(0);
  });

  it('a plan change after the proposal: validation failure shown, nothing changed', async () => {
    const app = await device({ ...week(), basketball: [bball({ durationMin: 100, rpe: 9, date: TODAY, jumping: 3, lowerFatigue: 3 })] });
    app.setPlanMode(gym(snapshot(app)).id, 'kept');
    const { deps } = testDeps(proposer('propose_adapt_today_workout', { session: 'gym', choice: 'adapt' }));
    const { ai } = await phone(deps, app);
    await ai.send('Can you reduce today’s legs?');
    app.startInstance(gym(snapshot(app)).id);
    const before = snapshot(app);
    await ai.confirm(lastAction(ai).id);
    expect(lastAction(ai).action).toMatchObject({ state: 'failed', note: expect.stringMatching(/^Nothing was changed\. Today’s Legs has already started/) });
    expect(snapshot(app)).toEqual(before);
  });

  it('adapt today’s workout: the engine’s adaptation applied on the device, the template untouched', async () => {
    const app = await device({ ...week(), basketball: [bball({ durationMin: 100, rpe: 9, date: TODAY, jumping: 3, lowerFatigue: 3 })] });
    app.setPlanMode(gym(snapshot(app)).id, 'kept');
    const templates = JSON.stringify(snapshot(app).templates);
    const { deps } = testDeps(proposer('propose_adapt_today_workout', { session: 'gym', choice: 'adapt' }));
    const { ai } = await phone(deps, app);
    await ai.send('Can you reduce today’s legs?');
    await ai.confirm(lastAction(ai).id);
    expect(lastAction(ai).action).toMatchObject({ state: 'executed', note: 'Today’s workout adapted.' });
    expect(gym(snapshot(app)).plan).toBe('adapted');
    expect(JSON.stringify(snapshot(app).templates)).toBe(templates);
  });

  it('offline: the question fails with a retry, the action isn’t confirmed and isn’t retried by itself', async () => {
    const { deps } = testDeps(proposer('propose_log_basketball', BASKETBALL));
    const { ai, net, sent } = await phone(deps);
    await ai.send('Log basketball for 90 minutes at RPE 8.');
    net.offline = true;
    expect(await ai.send('hello?')).toBe(false);
    expect(ai.getState().messages.at(-1)).toMatchObject({ status: 'failed', retry: true });
    await ai.confirm(lastAction(ai).id);
    expect(lastAction(ai).action).toMatchObject({ state: 'pending', note: NOTE.offline });
    expect(sent.filter((s) => s.path.endsWith('/confirm'))).toHaveLength(0);
  });

  it('when this device can no longer sign in, the action stays pending and nothing runs', async () => {
    const { deps } = testDeps(proposer('propose_log_basketball', BASKETBALL));
    const { ai, app, sent } = await phone(deps);
    await ai.send('Log basketball for 90 minutes at RPE 8.');
    // the server rotates its signing secret, revokes this device and stops registering new ones
    deps.secret = 'a-completely-different-signing-secret-0123456789';
    await deps.db.query('update ai_refresh_tokens set revoked_at = now() where identity_id in (select identity_id from ai_actions where id = $1)', [lastAction(ai).action.id]);
    deps.registration = 'closed';
    await ai.confirm(lastAction(ai).id);
    expect(lastAction(ai).action).toMatchObject({ state: 'pending', note: NOTE.unavailable });
    expect(snapshot(app).basketball).toHaveLength(0);
    expect(sent.filter((x) => x.path.endsWith('/confirm'))).toHaveLength(1); // refused before anything ran
    expect(NOW.getDate()).toBe(7);
  });
});
