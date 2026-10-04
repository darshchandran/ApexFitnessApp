import { describe, expect, it } from '@jest/globals';
import { muscleVolume } from '../../../src/domain/volume';
import { exerciseHistory, liveExercise, nextProgression } from '../../../src/domain/logbook';
import type { ApexData } from '../../../src/domain/types';
import { todayOverview } from '../../../src/services/apex';
import { deepFreeze, snapshotSource } from '../data';
import { ACTIONS } from '../actions';
import { check, type Schema } from '../schemas';
import { runTool, toolDefinitions, TOOLS, type ToolContext } from '../tools';
import { athleteData, NOW, TODAY, trainedAthlete } from '../test-utils';

const ctxFor = (data: ApexData | null): ToolContext => ({ data: data && deepFreeze(structuredClone(data)), today: TODAY, proposals: [] });
const run = async (name: string, args: object, data: ApexData) => {
  const r = await runTool(name, JSON.stringify(args), ctxFor(data));
  if (!r.ok) throw new Error(`${name}: ${r.error} ${r.detail ?? ''}`);
  return r.output as Record<string, any>;
};

/** Valid arguments for each tool (every field present, as strict mode requires). */
const ARGS: Record<string, object> = {
  get_athlete_profile: {}, get_training_schedule: {}, get_today_plan: {}, get_current_adaptation: {}, get_training_load: {},
  get_readiness: {}, get_recent_sessions: { days: 14 }, get_workout_history: { limit: 5, kind: null }, get_exercise_history: { exercise: 'smith squat', limit: null },
  get_progression: { exercise: 'Smith Machine Squat' }, get_prs: { exercise: null, limit: null }, get_weekly_volume: {},
  propose_log_basketball: { duration_min: 60, rpe: 7, session_type: 'skills', lower_body_fatigue: null, date: null },
  propose_adapt_today_workout: { session: 'gym', choice: 'recovery_day' },
};

/** OpenAI strict mode: every object closes its properties and requires all of them. */
function strictProblems(s: Schema, path = '$'): string[] {
  const out: string[] = [];
  if (s.properties) {
    if (s.additionalProperties !== false) out.push(`${path}: open object`);
    const keys = Object.keys(s.properties);
    if (JSON.stringify([...(s.required ?? [])].sort()) !== JSON.stringify([...keys].sort())) out.push(`${path}: not all required`);
    for (const k of keys) out.push(...strictProblems(s.properties[k], `${path}.${k}`));
  }
  if (s.items) out.push(...strictProblems(s.items, `${path}[]`));
  return out;
}

describe('tool contracts', () => {
  it('the required read tools exist, plus proposal tools for enabled actions only — and nothing that executes', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'get_athlete_profile', 'get_training_schedule', 'get_today_plan', 'get_current_adaptation', 'get_training_load', 'get_readiness',
      'get_recent_sessions', 'get_workout_history', 'get_exercise_history', 'get_progression', 'get_prs', 'get_weekly_volume',
      'propose_log_basketball', 'propose_adapt_today_workout',
    ]);
    expect(TOOLS.filter((t) => t.access !== 'read').map((t) => [t.name, t.access])).toEqual([['propose_log_basketball', 'propose'], ['propose_adapt_today_workout', 'propose']]);
    expect(TOOLS.map((t) => t.name).filter((n) => !/^(get|propose)_/.test(n))).toEqual([]);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(Object.keys(ARGS)).toContain(t.name);
    }
  });

  it('every input and output schema is strict; definitions go to the model with strict: true', () => {
    for (const t of TOOLS) expect([...strictProblems(t.input), ...strictProblems(t.output)]).toEqual([]);
    for (const d of toolDefinitions()) expect(d).toMatchObject({ type: 'function', strict: true, parameters: { type: 'object', additionalProperties: false } });
  });

  it('no tool takes a user, athlete or storage parameter', () => {
    for (const t of TOOLS) expect(Object.keys(t.input.properties ?? {}).filter((k) => /user|athlete|account|id$|sql|query|path|url|key/i.test(k))).toEqual([]);
  });

  it('every tool validates its input', async () => {
    const data = await athleteData();
    const bad = (name: string, raw: string) => runTool(name, raw, ctxFor(data));
    for (const t of TOOLS) {
      expect(await bad(t.name, JSON.stringify({ ...ARGS[t.name], user_id: 'someone_else' }))).toEqual({ ok: false, error: 'invalid_arguments', detail: '$.user_id: not allowed' });
      expect(await bad(t.name, '{not json')).toMatchObject({ ok: false, error: 'invalid_arguments' });
      expect(await bad(t.name, '[]')).toMatchObject({ ok: false, error: 'invalid_arguments', detail: '$: expected an object' });
      for (const k of Object.keys(ARGS[t.name])) {
        const missing: Record<string, unknown> = { ...ARGS[t.name] };
        delete missing[k];
        expect(await bad(t.name, JSON.stringify(missing))).toMatchObject({ ok: false, error: 'invalid_arguments' });
      }
    }
    expect(await bad('get_recent_sessions', '{"days":99}')).toMatchObject({ ok: false, detail: '$.days: above 28' });
    expect(await bad('get_recent_sessions', '{"days":2.5}')).toMatchObject({ ok: false, detail: '$.days: expected an integer' });
    expect(await bad('get_workout_history', '{"limit":3,"kind":"cardio"}')).toMatchObject({ ok: false, detail: '$.kind: not an allowed value' });
    expect(await bad('get_exercise_history', `{"exercise":"${'x'.repeat(81)}","limit":null}`)).toMatchObject({ ok: false, detail: '$.exercise: wrong format' });
    expect(await bad('drop_database', '{}')).toEqual({ ok: false, error: 'unknown_tool' });
  });

  it('every tool returns its typed output — fresh install, a trained athlete, and lb units', async () => {
    const trained = await trainedAthlete();
    for (const data of [await athleteData(), trained, { ...trained, profile: { ...trained.profile, units: 'lb' as const } }]) {
      for (const t of TOOLS) {
        const r = await runTool(t.name, JSON.stringify(ARGS[t.name]), ctxFor(data));
        expect([t.name, r.ok, r.ok ? check(t.output, r.output) : r]).toEqual([t.name, true, null]);
      }
    }
  });

  it('without athlete data, tools say so instead of guessing', async () => {
    for (const t of TOOLS) expect(await runTool(t.name, JSON.stringify(ARGS[t.name]), ctxFor(null))).toEqual({ ok: false, error: 'athlete_data_unavailable' });
  });
});

describe('tools use the existing APEX engine', () => {
  it('load, plan and adaptation are the app’s own read models — not recalculated', async () => {
    const d = await trainedAthlete();
    const o = todayOverview(d, TODAY);
    const load = await run('get_training_load', {}, d);
    expect(load.today).toEqual({ total: o.load.total, basketball: o.load.basketball, gym: o.load.gym, plyometrics: o.load.plyo, band: o.load.band });
    expect(load.last_7_days).toEqual(o.week.map((w) => ({ date: w.date, total: w.total, band: w.band })));
    const adaptation = await run('get_current_adaptation', {}, d);
    const gym = adaptation.sessions[0];
    expect(gym).toMatchObject({ session: 'gym', template: 'Legs', outcome: o.gym!.decision.outcome, headline: o.gym!.decision.headline, reasons: o.gym!.decision.reasons });
    expect(gym.outcome).not.toBe('normal'); // hard basketball today adapted Legs
    expect(gym.volume_change_pct).toBe(Math.round((o.gym!.decision.volumeFactor - 1) * 100));
    expect(gym.recent_sessions.join(' ')).toContain('Basketball 90 min @ RPE 8');
    const plan = await run('get_today_plan', {}, d);
    expect(plan.gym.exercises.map((e: { prescribed: string }) => e.prescribed)).toEqual(o.gym!.exercises.map((e) => `${e.prescribed.sets} × ${e.prescribed.repRange[0]}–${e.prescribed.repRange[1]}`));
    expect(plan.basketball.logged).toEqual([{ duration_min: 90, rpe: 8, session_type: 'mixed' }]);
    expect(await run('get_readiness', {}, d)).toMatchObject({ checked_in: true, score: o.readiness, check_in: { sleep_hours: 6, soreness_1_to_5: 3, energy_1_to_5: 3 } });
  });

  it('progression, history, PRs and volume come from the logbook and volume modules', async () => {
    const d = await trainedAthlete();
    const h = exerciseHistory(d.instances, 'smith-squat');
    const rec = nextProgression(h, liveExercise(d.instances, 'smith-squat', TODAY), 'smith-squat', 'kg');
    const p = await run('get_progression', { exercise: 'smith squat' }, d);
    expect(p).toMatchObject({ exercise: { id: 'smith-squat', name: 'Smith Machine Squat' }, recommendation: { action: rec.action, reps: rec.reps, reason: rec.reason }, on_today_plan: true });
    expect(p.based_on).toEqual({ date: '2026-09-30', sets: ['100 kg × 8 @ 2 RIR', '100 kg × 8 @ 2 RIR', '100 kg × 8 @ 1 RIR'] });
    expect(await run('get_exercise_history', { exercise: 'smith-squat', limit: null }, d)).toMatchObject({ total_sessions: 1, best_set: '100 kg × 8 @ 2 RIR on 2026-09-30' });
    expect((await run('get_prs', { exercise: null, limit: null }, d)).records).toEqual([{ date: '2026-09-30', exercise: 'Smith Machine Squat', kind: 'Weight PR', detail: '100 kg × 8' }]);
    const vol = await run('get_weekly_volume', {}, d);
    expect(vol.groups.map((g: { sets: number }) => g.sets)).toEqual(muscleVolume(d.instances, TODAY).map((g) => g.sets));
  });

  it('logged vs planned: recent sessions are logged only; the schedule is labelled as planned', async () => {
    const d = await trainedAthlete();
    const recent = await run('get_recent_sessions', { days: 7 }, d);
    expect(recent.days.flatMap((x: { sessions: { name: string }[] }) => x.sessions.map((s) => s.name))).toEqual(['Basketball 90 min @ RPE 8', 'Pull']);
    const week = await run('get_training_schedule', {}, d);
    expect(week.note).toMatch(/not training until logged/);
    expect(week.days[2].activities).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'basketball', source: 'schedule', time: 'morning' }), expect.objectContaining({ kind: 'gym', source: 'program', name: 'Legs' })]));
    expect(week.days[0].activities[0].name).toMatch(/^Push rotation \(next: Push V1\)$/);
  });

  it('weights come back in the athlete’s units', async () => {
    const t = await trainedAthlete();
    const d = { ...t, profile: { ...t.profile, units: 'lb' as const } };
    expect((await run('get_exercise_history', { exercise: 'smith squat', limit: 1 }, d)).sessions[0].sets[0]).toBe('220.5 lb × 8 @ 2 RIR');
    expect((await run('get_prs', { exercise: 'smith squat', limit: 1 }, d)).records[0].detail).toBe('220.5 lb × 8');
    expect((await run('get_athlete_profile', {}, d)).bodyweight).toEqual({ value: '176.4 lb', date: '2026-10-01' });
  });

  it('finds exercises by the athlete’s own wording, and asks when a name is ambiguous', async () => {
    const d = await athleteData();
    expect((await run('get_progression', { exercise: 'Chest Supported Rows' }, d)).exercise).toEqual({ id: 'chest-supported-row', name: 'Chest Supported Row' });
    const vague = await run('get_exercise_history', { exercise: 'curl', limit: null }, d);
    expect(vague.exercise).toBeNull();
    expect(vague.matches.length).toBeGreaterThan(1);
    expect(await run('get_progression', { exercise: 'underwater basket weaving' }, d)).toMatchObject({ exercise: null, matches: [], recommendation: null });
  });

  it('the profile is reported as athlete-provided, without the name or question bookkeeping', async () => {
    const d = await trainedAthlete();
    const p = await run('get_athlete_profile', {}, { ...d, user: { ...d.user, name: 'Jordan' } });
    expect(p).toMatchObject({ source: 'athlete_reported', goal: 'performance', sport: 'basketball' });
    expect(JSON.stringify(p)).not.toMatch(/Jordan|prompts|lastPromptAt/);
  });
});

describe('safety', () => {
  it('tools run on frozen data and never change it — history, templates and profile stay as they were', async () => {
    const d = await trainedAthlete();
    const before = JSON.stringify(d);
    const ctx = ctxFor(d);
    for (const t of TOOLS) expect((await runTool(t.name, JSON.stringify(ARGS[t.name]), ctx)).ok).toBe(true);
    expect(JSON.stringify(ctx.data)).toBe(before);
    expect(Object.isFrozen(ctx.data!.instances[0].exercises[0])).toBe(true);
  });

  it('propose tools only draft an action inside its contract — nothing is logged', async () => {
    const d = await trainedAthlete();
    const ctx = ctxFor(d);
    const r = await runTool('propose_log_basketball', JSON.stringify({ duration_min: 75, rpe: 6, session_type: null, lower_body_fatigue: null, date: null }), ctx);
    expect(r).toEqual({ ok: true, output: { status: 'awaiting_confirmation', summary: 'Log basketball — 75 min at RPE 6, today.', would_change: expect.arrayContaining(['Basketball 75 min at RPE 6 on 2026-10-07']), reason: null } });
    expect(ctx.proposals).toEqual([{ type: 'log_basketball', arguments: { date: TODAY, duration_min: 75, rpe: 6, session_type: null, lower_body_fatigue: null }, summary: expect.any(String), preview: expect.any(Array) }]);
    expect(check(ACTIONS.log_basketball.args, ctx.proposals[0].arguments)).toBeNull();
    expect(ctx.data!.basketball).toHaveLength(1); // nothing was logged
  });

  it('a snapshot is checked like stored data: valid data loads frozen, broken data is refused', async () => {
    const d = await trainedAthlete();
    const loaded = await snapshotSource.load({ userId: 'u' }, JSON.parse(JSON.stringify(d)), NOW);
    expect(loaded!.instances.map((i) => i.id)).toEqual(d.instances.map((i) => i.id));
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(await snapshotSource.load({ userId: 'u' }, { ...JSON.parse(JSON.stringify(d)), plan: { days: [] } }, NOW)).toBeNull();
    expect(await snapshotSource.load({ userId: 'u' }, { templates: 'nope' }, NOW)).toBeNull();
    expect(await snapshotSource.load({ userId: 'u' }, undefined, NOW)).toBeNull();
    // legacy layout is migrated exactly like the app does on start-up
    const legacy = await snapshotSource.load({ userId: 'u' }, { profile: {}, plan: { ...d.plan, days: d.plan.days.map((x, i) => (i === 1 ? { ...x, basketball: '07:00' } : x)) } }, NOW);
    expect(legacy!.profile.schedule).toEqual([expect.objectContaining({ day: 1, kind: 'basketball', time: '07:00' })]);
  });
});
