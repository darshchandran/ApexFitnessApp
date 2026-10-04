import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { planVsActual } from '../../../src/domain/logbook';
import type { ApexData, WorkoutInstance } from '../../../src/domain/types';
import { todayOverview, type ActionChanges } from '../../../src/services/apex';
import { ACTIONS, ActionRejected, simulate, type ActionResult } from '../actions';
import type { ActionStore, ClientAction } from '../store';
import { handleChat, route, type ChatDeps } from '../handler';
import { bball } from '../../../src/test-utils';
import { callTool, device, NOW, post, res, say, snapshot, testActions, testClock, testDeps, TODAY, token, toolOutputs, week, type Body } from '../test-utils';

type Device = Awaited<ReturnType<typeof device>>;
type Store = ActionStore;
type Ok = Extract<ActionResult, { success: true }>;
type Confirmed = { action: ClientAction; result: Ok & { result: Record<string, any> & { changes: ActionChanges } }; message: string; error?: { code: string } };
const lastRole = (b: Body) => (b.input as Record<string, unknown>[]).at(-1)?.role;

/** A model that proposes with `tool` on each new user message, then says it is waiting for confirmation. */
const proposer = (tool: string, args: object) => (b: Body) =>
  lastRole(b) === 'user' ? res(callTool(tool, args)) : say('Waiting for your confirmation in the app.');

const BASKETBALL = { duration_min: 90, rpe: 8, session_type: null, lower_body_fatigue: null, date: null };

function setup(tool = 'propose_log_basketball', args: object = BASKETBALL, opts: { actions?: Store } = {}) {
  return testDeps(proposer(tool, args), opts);
}

async function propose(deps: ChatDeps, app: Device, user = 'athlete_1') {
  const r = await handleChat(post({ message: 'Log basketball for 90 minutes at RPE 8.', conversation_id: 'conv1', context: { today: TODAY, athlete_data: snapshot(app) } }, token(user)), deps);
  return (await r.json()) as { action_required: boolean; action: ClientAction | null; message: string };
}

const actionReq = (id: string, op: 'confirm' | 'cancel', body: unknown, user: string | null = 'athlete_1') =>
  new Request(`http://apex.test/ai/actions/${id}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user && { authorization: `Bearer ${token(user)}` }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function confirm(deps: ChatDeps, id: string, app: Device, extra: { user?: string; arguments?: object } = {}) {
  const r = await route(actionReq(id, 'confirm', { context: { today: TODAY, athlete_data: snapshot(app) }, ...(extra.arguments && { arguments: extra.arguments }) }, extra.user ?? 'athlete_1'), deps);
  return { status: r.status, body: (await r.json()) as Confirmed };
}
const cancel = async (deps: ChatDeps, id: string, user = 'athlete_1') => {
  const r = await route(actionReq(id, 'cancel', {}, user), deps);
  return { status: r.status, body: await r.json() };
};
const gym = (d: ApexData) => todayOverview(d, TODAY).gym as WorkoutInstance;

describe('proposals', () => {
  it('"Log basketball for 90 minutes at RPE 8." → a pending, confirmable action with the engine’s preview — nothing logged', async () => {
    const app = await device();
    const before = snapshot(app);
    const { deps } = setup();
    const out = await propose(deps, app);
    expect(out.action_required).toBe(true);
    const a = out.action!;
    expect(Object.keys(a).sort()).toEqual(['arguments', 'created_at', 'expires_at', 'id', 'preview', 'requires_confirmation', 'status', 'summary', 'type']);
    expect(a).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), type: 'log_basketball', status: 'pending', requires_confirmation: true,
      summary: 'Log basketball — 90 min at RPE 8, today.',
      arguments: { date: TODAY, duration_min: 90, rpe: 8, session_type: null, lower_body_fatigue: null },
    });
    expect(Date.parse(a.expires_at) - Date.parse(a.created_at)).toBe(5 * 60_000);
    // the preview is what APEX's engine does with it: the practice, today's Legs, today's load
    expect(a.preview[0]).toBe('Basketball 90 min at RPE 8 on 2026-10-07');
    expect(a.preview.some((l) => /^Legs: \d+ sets · Adapted$/.test(l))).toBe(true);
    expect(a.preview.some((l) => /^Today’s load: 0 → \d+/.test(l))).toBe(true);
    expect(snapshot(app)).toEqual(before); // proposing changed nothing
  });

  it('nonsense is rejected — no action is created', async () => {
    const app = await device();
    const bad: [object, string][] = [
      [{ ...BASKETBALL, rpe: 11 }, '$.rpe: above 10'],
      [{ ...BASKETBALL, duration_min: 0 }, '$.duration_min: below 1'],
      [{ ...BASKETBALL, duration_min: 1000 }, '$.duration_min: above 600'],
      [{ ...BASKETBALL, rpe: 7.5 }, '$.rpe: expected an integer'],
      [{ ...BASKETBALL, session_type: 'pickup' }, '$.session_type: not an allowed value'],
    ];
    for (const [args, detail] of bad) {
      const { deps, bodies } = setup('propose_log_basketball', args);
      const out = await propose(deps, app);
      expect(out).toMatchObject({ action_required: false, action: null });
      expect(toolOutputs(bodies[1])).toEqual([{ error: 'invalid_arguments', detail }]);
    }
    const rejected: [object, RegExp][] = [
      [{ ...BASKETBALL, date: '2026-10-08' }, /future/],
      [{ ...BASKETBALL, date: '2026-09-01' }, /last 7 days/],
      [{ ...BASKETBALL, date: '2026-02-30' }, /doesn’t exist/],
    ];
    for (const [args, reason] of rejected) {
      const { deps, bodies } = setup('propose_log_basketball', args);
      expect((await propose(deps, app)).action).toBeNull();
      expect(toolOutputs(bodies[1])[0]).toMatchObject({ status: 'rejected', reason: expect.stringMatching(reason) });
    }
  });

  it('is bound to the athlete who saw it, and expires', async () => {
    const app = await device();
    const clock = testClock();
    const { deps, actions } = setup(undefined, undefined, { actions: testActions({ clock: clock.now }) });
    const { action } = await propose(deps, app);
    expect(await actions.get(action!.id, 'athlete_1')).toMatchObject({ userId: 'athlete_1', conversationId: 'conv1', status: 'pending' });
    expect(await actions.get(action!.id, 'athlete_2')).toBeUndefined();
    clock.advance(5 * 60_000);
    const r = await confirm(deps, action!.id, app);
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ error: { code: 'action_expired' }, action: { status: 'expired' } });
    expect(snapshot(app).basketball).toHaveLength(0);
  });
});

describe('confirmation', () => {
  it('executes once through the app’s service and returns the real result for the device to store', async () => {
    const app = await device();
    const { deps } = setup();
    const { action } = await propose(deps, app);
    const r = await confirm(deps, action!.id, app);
    expect(r.status).toBe(200);
    const { result, message } = r.body;
    expect(result).toMatchObject({ success: true, action_id: action!.id, action_type: 'log_basketball', timestamp: expect.any(String) });
    expect(result.result.basketball_sessions).toEqual([{ id: expect.stringMatching(/^bb_/), date: TODAY, duration_min: 90, rpe: 8, session_type: null }]);
    expect(result.affected_entities).toEqual([
      { type: 'basketball_session', id: result.result.basketball_sessions[0].id, change: 'created' },
      { type: 'session_instance', id: gym(snapshot(app)).id, change: 'updated' },
    ]);
    expect(message).toMatch(/^Basketball logged\. Log basketball — 90 min at RPE 8, today\. Today: Legs: \d+ sets · Adapted\.$/);
    expect(r.body.action.status).toBe('executed');

    // the device stores it (the session, and today's Legs as re-adapted) — matching what the server reported
    expect(app.applyActionChanges(result.result.changes)).toBe(2);
    const d = snapshot(app);
    expect(d.basketball.map((b) => b.id)).toEqual([result.result.basketball_sessions[0].id]);
    expect(todayOverview(d, TODAY).load.total).toBe(result.result.load_today.total);
    expect((result.result.load_today as { basketball: number }).basketball).toBeGreaterThan(0);
    expect(gym(d).decision.outcome).not.toBe('normal');
    expect(`Legs: ${planVsActual(gym(d)).prescribed} sets · Adapted`).toBe((result.result.today_sessions as { prescribed: string }[])[0].prescribed);
  });

  it('confirm, confirm again, confirm again, and two taps at once → one basketball session', async () => {
    const app = await device();
    const { deps } = setup();
    const { action } = await propose(deps, app);
    const [a, b] = await Promise.all([confirm(deps, action!.id, app), confirm(deps, action!.id, app)]);
    const c = await confirm(deps, action!.id, app);
    const d = await confirm(deps, action!.id, app);
    for (const x of [a, b, c, d]) expect([x.status, x.body.result]).toEqual([200, a.body.result]);
    // a retrying client applies the same result each time — still one record
    for (const x of [a, b, c, d]) app.applyActionChanges(x.body.result.result.changes);
    expect(snapshot(app).basketball).toHaveLength(1);
  });

  it('cancel: pending → cancelled, can’t be confirmed, cancelling again is harmless, executed can’t be cancelled', async () => {
    const app = await device();
    const { deps } = setup();
    const first = (await propose(deps, app)).action!;
    expect(await cancel(deps, first.id)).toEqual({ status: 200, body: { action: expect.objectContaining({ status: 'cancelled' }) } });
    expect((await confirm(deps, first.id, app)).body.error).toMatchObject({ code: 'action_cancelled' });
    expect((await cancel(deps, first.id)).status).toBe(200);
    const second = (await propose(deps, app)).action!;
    await confirm(deps, second.id, app);
    expect(await cancel(deps, second.id)).toMatchObject({ status: 409, body: { error: { code: 'action_not_pending' }, action: { status: 'executed' } } });
  });

  it('another athlete, a forged id or a missing token can’t confirm or cancel', async () => {
    const app = await device();
    const { deps } = setup();
    const { action } = await propose(deps, app, 'alice');
    expect((await confirm(deps, action!.id, app, { user: 'bob' })).status).toBe(404);
    expect((await cancel(deps, action!.id, 'bob')).status).toBe(404);
    expect((await confirm(deps, randomUUID(), app, { user: 'alice' })).status).toBe(404);
    expect((await route(actionReq('1234', 'confirm', {}), deps)).status).toBe(404);
    expect((await route(actionReq(action!.id, 'confirm', { context: { today: TODAY, athlete_data: {} } }, null), deps)).status).toBe(401);
    expect((await route(actionReq(action!.id, 'cancel', {}, null), deps)).status).toBe(401);
    // still pending for its owner
    expect((await confirm(deps, action!.id, app, { user: 'alice' })).status).toBe(200);
  });

  it('arguments that differ from the proposal void it; confirm never takes new arguments', async () => {
    const app = await device();
    const { deps } = setup();
    const ok = (await propose(deps, app)).action!;
    expect((await confirm(deps, ok.id, app, { arguments: ok.arguments })).status).toBe(200); // an exact echo is fine
    const { action } = await propose(deps, app);
    const altered = await confirm(deps, action!.id, app, { arguments: { ...action!.arguments, rpe: 9 } });
    expect(altered).toMatchObject({ status: 409, body: { error: { code: 'arguments_changed' }, action: { status: 'cancelled' } } });
    expect((await confirm(deps, action!.id, app)).body.error).toMatchObject({ code: 'action_cancelled' });
    for (const body of [{ context: { today: TODAY, athlete_data: snapshot(app) }, action_type: 'log_basketball' }, { context: { today: TODAY, athlete_data: snapshot(app) }, duration_min: 300 }]) {
      const r = await route(actionReq(randomUUID(), 'confirm', body), deps);
      expect([r.status, (await r.json()).error.code]).toEqual([400, 'invalid_request']);
    }
  });

  it('malformed confirm payloads are refused and leave the action pending', async () => {
    const app = await device();
    const { deps } = setup();
    const { action } = await propose(deps, app);
    for (const body of ['{oops', {}, { context: { today: TODAY } }, { context: { today: '2026-01-01', athlete_data: snapshot(app) } }, { context: { today: TODAY, athlete_data: { plan: { days: [] } } } }]) {
      const r = await route(actionReq(action!.id, 'confirm', body), deps);
      expect([r.status, (await r.json()).error.code]).toEqual([400, 'invalid_request']);
    }
    expect((await confirm(deps, action!.id, app)).status).toBe(200);
  });

  it('an action type that isn’t enabled can never execute', async () => {
    const app = await device();
    const { deps, actions } = setup();
    for (const type of ['update_athlete_profile', 'log_gym_set', 'start_workout', 'finish_workout'] as const) {
      expect(ACTIONS[type].enabled).toBe(false);
      const a = await actions.create({ type, arguments: {}, summary: 'x', preview: [] }, 'athlete_1', 'conv1');
      const r = await confirm(deps, a.id, app);
      expect([r.status, r.body.error?.code, (await actions.get(a.id, 'athlete_1'))!.status]).toEqual([403, 'action_not_allowed', 'failed']);
      expect((await confirm(deps, a.id, app)).status).toBe(403); // settled for good: never retried into an execution
    }
    expect(snapshot(app).profile.goal).toBe('performance');
  });

  it('the model can’t bypass the proposal: there is no execute tool, and chatting executes nothing', async () => {
    const app = await device();
    const { deps, bodies, actions } = testDeps((b) => (lastRole(b) === 'user' ? res(callTool('log_basketball', { duration_min: 90, rpe: 8 }), callTool('execute_action', {})) : say('ok')));
    const out = await propose(deps, app);
    expect(toolOutputs(bodies[1])).toEqual([{ error: 'unknown_tool' }, { error: 'unknown_tool' }]);
    expect(out.action).toBeNull();
    expect(await actions.get(randomUUID(), 'athlete_1')).toBeUndefined();
  });
});

describe('execution', () => {
  it('a failed execution never claims success and changes nothing', async () => {
    const app = await device({ ...week(), basketball: [bball({ durationMin: 90, rpe: 9, date: TODAY, lowerFatigue: 3 })] });
    app.setPlanMode(gym(snapshot(app)).id, 'kept');
    const { deps } = setup('propose_adapt_today_workout', { session: 'gym', choice: 'adapt' });
    const { action } = await propose(deps, app);
    expect(action).toMatchObject({ type: 'adapt_today_workout', status: 'pending' });
    app.startInstance(gym(snapshot(app)).id); // the athlete starts Legs before confirming
    const r = await confirm(deps, action!.id, app);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: 'action_failed' }, result: { success: false, error: { code: 'action_failed' } }, action: { status: 'failed' } });
    expect(r.body.message).toMatch(/^Nothing was changed: /);
    expect(r.body.message).not.toMatch(/Done|logged/);
    expect((await confirm(deps, action!.id, app)).status).toBe(422); // settled: never retried into a success
  });

  it('the executor stops anything that would touch templates, the profile or history', async () => {
    const app = await device({ ...week(), basketball: [bball({ id: 'old', durationMin: 60, rpe: 5, date: '2026-10-06' })] });
    const d = snapshot(app);
    const plan = ACTIONS.log_basketball.plan!;
    const sneaky: [(a: any) => unknown, RegExp][] = [
      [(a) => a.duplicateTemplate('legs'), /protected data/],
      [(a) => a.updateProfile({ goal: 'muscle' }), /protected data/],
      [(a) => a.deleteBasketball('old'), /can’t be changed/],
    ];
    try {
      for (const [run, msg] of sneaky) {
        ACTIONS.log_basketball.plan = () => ({ summary: 'x', run });
        await expect(simulate(d, 'log_basketball', { date: TODAY, duration_min: 60, rpe: 6, session_type: null, lower_body_fatigue: null }, TODAY)).rejects.toThrow(msg);
      }
    } finally {
      ACTIONS.log_basketball.plan = plan;
    }
    await expect(simulate(d, 'log_basketball', { date: TODAY, duration_min: 60, rpe: 6, session_type: null, lower_body_fatigue: null }, TODAY)).resolves.toBeDefined();
    await expect(simulate(d, 'log_basketball', { date: TODAY, duration_min: 60, rpe: 6 }, TODAY)).rejects.toThrow(ActionRejected);
  });
});

describe('adapting today’s workout', () => {
  async function keptAfterHardPractice() {
    const app = await device({ ...week(), basketball: [bball({ durationMin: 100, rpe: 9, date: TODAY, jumping: 3, lowerFatigue: 3 })] });
    app.setPlanMode(gym(snapshot(app)).id, 'kept'); // the athlete had chosen KEEP PLAN
    return app;
  }

  it('"Can you reduce today’s legs?" → the engine’s own adaptation as a proposal; executes only after confirmation; templates untouched', async () => {
    const app = await keptAfterHardPractice();
    const templates = JSON.stringify(snapshot(app).templates);
    const kept = gym(snapshot(app));
    // what the engine itself does on the device (a separate copy)
    const reference = await keptAfterHardPractice();
    reference.setPlanMode(gym(snapshot(reference)).id, 'adapted');
    const engine = gym(snapshot(reference));

    const { deps } = setup('propose_adapt_today_workout', { session: 'gym', choice: 'adapt' });
    const { action } = await propose(deps, app);
    expect(action!.summary).toBe(`Use APEX’s adaptation for today’s Legs: ${engine.decision.headline}.`);
    expect(action!.preview).toContain(`Legs: ${planVsActual(engine).prescribed} sets · Adapted`);
    expect(gym(snapshot(app))).toEqual(kept); // nothing changed before the athlete confirms

    const r = await confirm(deps, action!.id, app);
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/^Done\. /);
    app.applyActionChanges(r.body.result.result.changes);
    const after = gym(snapshot(app));
    expect(after.plan).toBe('adapted');
    expect(after.exercises.map((e) => [e.exerciseId, e.status, e.prescribed.sets])).toEqual(engine.exercises.map((e) => [e.exerciseId, e.status, e.prescribed.sets]));
    expect(JSON.stringify(snapshot(app).templates)).toBe(templates);
  });

  it('the engine’s other options: alternative and recovery day — and nothing it doesn’t offer', async () => {
    const app = await keptAfterHardPractice();
    const altId = gym(snapshot(app)).decision.alternativeTemplateId;
    expect(altId).toBeDefined();
    const alt = setup('propose_adapt_today_workout', { session: 'gym', choice: 'alternative' });
    const a = (await propose(alt.deps, app)).action!;
    app.applyActionChanges((await confirm(alt.deps, a.id, app)).body.result.result.changes);
    expect(gym(snapshot(app))).toMatchObject({ templateId: altId, alternativeFor: { templateId: 'legs' } });

    const other = await keptAfterHardPractice();
    const rec = setup('propose_adapt_today_workout', { session: 'gym', choice: 'recovery_day' });
    const b = (await propose(rec.deps, other)).action!;
    other.applyActionChanges((await confirm(rec.deps, b.id, other)).body.result.result.changes);
    expect(gym(snapshot(other)).status).toBe('skipped');

    // nothing logged that calls for an adaptation → the engine has nothing to offer, so no proposal
    const quiet = await device();
    const none = setup('propose_adapt_today_workout', { session: 'gym', choice: 'adapt' });
    expect((await propose(none.deps, quiet)).action).toBeNull();
    expect(toolOutputs(none.bodies[1])[0]).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/nothing logged calls for one/) });
    const plyo = setup('propose_adapt_today_workout', { session: 'plyometrics', choice: 'recovery_day' });
    await propose(plyo.deps, quiet);
    expect(toolOutputs(plyo.bodies[1])[0]).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/no plyometric session/) });
  });
});

describe('the device side', () => {
  it('applyActionChanges only takes new basketball and today’s unstarted sessions, and is idempotent', async () => {
    const app = await device({ ...week(), basketball: [bball({ id: 'kept', durationMin: 60, rpe: 5, date: '2026-10-06' })] });
    const d = snapshot(app);
    const completed = d.instances.find((i) => i.status === 'completed')!;
    const changes: ActionChanges = {
      basketball: [{ ...d.basketball[0], rpe: 10 }, bball({ id: 'bad', durationMin: 0, rpe: 5 }), bball({ id: 'new', durationMin: 45, rpe: 6 })],
      instances: [{ ...completed, notes: 'rewritten' }, { ...gym(d), status: 'completed' }],
    };
    expect(app.applyActionChanges(changes)).toBe(1);
    expect(app.applyActionChanges(changes)).toBe(0);
    const after = snapshot(app);
    expect(after.basketball.map((b) => [b.id, b.rpe])).toEqual([['kept', 5], ['new', 6]]);
    expect(after.instances.find((i) => i.id === completed.id)).toEqual(completed);
    expect(gym(after).status).toBe('planned');
  });

  it('after confirming, the conversation knows the real outcome and tools see the new session', async () => {
    const app = await device();
    let turn = 0;
    const { deps, bodies } = testDeps((b) => {
      if (lastRole(b) === 'user') return res(turn++ === 0 ? callTool('propose_log_basketball', BASKETBALL) : callTool('get_current_adaptation'));
      return say('ok');
    });
    const { action } = await propose(deps, app);
    const r = await confirm(deps, action!.id, app);
    app.applyActionChanges(r.body.result.result.changes);
    await handleChat(post({ message: 'How did that affect today’s workout?', conversation_id: 'conv1', context: { today: TODAY, athlete_data: snapshot(app) } }), deps);
    const next = bodies[2];
    expect(next.input.slice(0, 4)).toEqual([
      { role: 'user', content: 'Log basketball for 90 minutes at RPE 8.' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: r.body.message },
      { role: 'user', content: 'How did that affect today’s workout?' },
    ]);
    const [adaptation] = toolOutputs(bodies[3]);
    expect(adaptation.sessions[0].recent_sessions.join(' ')).toContain('Basketball 90 min @ RPE 8');
    expect(adaptation.sessions[0].outcome).not.toBe('normal');
    expect(NOW.getDate()).toBe(7);
  });
});
