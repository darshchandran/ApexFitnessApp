import { describe, expect, it } from '@jest/globals';
import { muscleVolume } from '../../../src/domain/volume';
import { exerciseHistory, liveExercise, nextProgression } from '../../../src/domain/logbook';
import type { ApexData } from '../../../src/domain/types';
import { todayOverview } from '../../../src/services/apex';
import { deepFreeze, snapshotSource } from '../data';
import { ACTIONS } from '../actions';
import { check, type Schema } from '../schemas';
import { runTool, toolDefinitions, TOOLS, type ToolContext } from '../tools';
import { athleteData, device, NOW, snapshot, TODAY, trainedAthlete } from '../test-utils';
import { dayLog, dayPlan, MEAL_LABEL, nutritionTargets, WINDOW_LABEL, type PlannedMeal } from '../../../src/domain/nutrition';
import { amountText, foodById, gramsOf, macrosOf, MEALS, type PreGymWindow } from '../../../src/domain/foods';
import { completedGym } from '../../../src/test-utils';

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
  get_nutrition_day: { date: null }, get_meal_estimate: { items: [{ food: 'dal', quantity: null, unit: null }] },
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
      'get_nutrition_day', 'get_meal_estimate', 'propose_log_basketball', 'propose_adapt_today_workout',
    ]);
    expect(TOOLS.filter((t) => t.access !== 'read').map((t) => [t.name, t.access])).toEqual([['propose_log_basketball', 'propose'], ['propose_adapt_today_workout', 'propose']]);
    expect(TOOLS.map((t) => t.name).filter((n) => !/^(get|propose)_/.test(n))).toEqual([]);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(Object.keys(ARGS)).toContain(t.name);
    }
  });

  it('every input and output schema is strict; definitions go to the model in Chat Completions form', () => {
    for (const t of TOOLS) expect([...strictProblems(t.input), ...strictProblems(t.output)]).toEqual([]);
    // no `strict` flag (Groq doesn't document it for tools): runTool validates every argument instead
    for (const d of toolDefinitions()) expect(d).toEqual({ type: 'function', function: { name: expect.any(String), description: expect.any(String), parameters: expect.objectContaining({ type: 'object', additionalProperties: false }) } });
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

  it('finds exercises by the athlete’s own wording; only what they logged counts as their history', async () => {
    const fresh = await athleteData();
    // regression (audit 6B): an athlete with no history and a vague name got catalogue entries back,
    // which the model presented as "variations in your history" — now an explicit no-history result
    for (const tool of ['get_exercise_history', 'get_progression', 'get_prs']) {
      const args = tool === 'get_progression' ? { exercise: 'bench press' } : { exercise: 'bench press', limit: null };
      expect(await run(tool, args, fresh)).toMatchObject({ exercise: null, matches: [], lookup: 'no_history' });
    }
    expect(await run('get_prs', { exercise: 'bench press', limit: null }, fresh)).toMatchObject({ total: 0, records: [] });
    expect(await run('get_exercise_history', { exercise: 'bench press', limit: null }, fresh)).toMatchObject({ total_sessions: 0, sessions: [], best_set: null });
    // a name that is clearly one exercise is resolved — and still says nothing is logged
    expect(await run('get_progression', { exercise: 'Chest Supported Rows' }, fresh)).toMatchObject({ exercise: { id: 'chest-supported-row', name: 'Chest Supported Row' }, lookup: 'no_history' });
    expect(await run('get_progression', { exercise: 'underwater basket weaving' }, fresh)).toMatchObject({ exercise: null, matches: [], lookup: 'not_found', recommendation: null });
    // with history: a vague name resolves among what they logged, and is ambiguous only between those
    const trained = await athleteData({ instances: [completedGym('legs', '2026-09-30', { 'leg-press': [[180, 12, 2]], 'seated-leg-curl': [[40, 12, 2]], 'smith-squat': [[100, 8, 2]] })] });
    expect(await run('get_exercise_history', { exercise: 'squat', limit: null }, trained)).toMatchObject({ exercise: { id: 'smith-squat' }, lookup: 'logged', total_sessions: 1 });
    const leg = await run('get_exercise_history', { exercise: 'leg', limit: null }, trained);
    expect(leg).toMatchObject({ exercise: null, lookup: 'ambiguous' });
    expect(leg.matches.map((m: { id: string }) => m.id).sort()).toEqual(['leg-press', 'seated-leg-curl']); // never Leg Extension: not logged
  });

  it('an adapted session states the engine’s recommendation and its options — quoted, not inferred (audit 6B)', async () => {
    const hard = await run('get_current_adaptation', {}, await trainedAthlete());
    const gym = hard.sessions.find((s: { session: string }) => s.session === 'gym');
    expect(gym.outcome).not.toBe('normal');
    const expected = gym.outcome === 'deferred' ? `Take a recovery day: APEX advises against ${gym.template} today.`
      : gym.outcome === 'alternative' && gym.alternative ? `Train ${gym.alternative} instead of ${gym.template} today.`
        : `Train ${gym.template} with APEX’s adjusted prescription (${gym.volume_change_pct}% volume).`;
    expect(gym.engine_recommendation).toBe(expected);
    expect(gym.options).toEqual([
      `adapt — ${gym.template} with APEX’s adjusted prescription (${gym.volume_change_pct}% volume)`,
      ...(gym.alternative ? [`alternative — ${gym.alternative} instead of ${gym.template}`] : []),
      'recovery_day — take today as a recovery day (nothing is deleted)',
      `keep — the original ${gym.template} plan (the athlete chooses this in the app)`,
    ]);
    // a day with nothing to adapt says so plainly
    const calm = (await run('get_current_adaptation', {}, await athleteData())).sessions.find((s: { session: string }) => s.session === 'gym');
    expect(calm).toMatchObject({ outcome: 'normal', engine_recommendation: `Train ${calm.template} as planned.`, options: ['recovery_day — take today as a recovery day (nothing is deleted)'] });
  });

  it('the profile is reported as athlete-provided, without the name or question bookkeeping', async () => {
    const d = await trainedAthlete();
    const p = await run('get_athlete_profile', {}, { ...d, user: { ...d.user, name: 'Jordan' } });
    expect(p).toMatchObject({ source: 'athlete_reported', goal: 'performance', sport: 'basketball' });
    expect(JSON.stringify(p)).not.toMatch(/Jordan|prompts|lastPromptAt/);
  });
});

describe('nutrition tools', () => {
  type Item = { food: string; amount: string; kcal: number; protein_g: number };
  type Meal = { meal?: string; timing?: string; name: string; items: Item[]; kcal: number; protein_g: number; logged: boolean };
  const g1 = (n: number) => Math.round(n * 10) / 10;
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  /** Set up (evening gym), then `edit`; by default breakfast is logged from food the athlete entered. */
  const fed = async (edit?: (app: Awaited<ReturnType<typeof device>>) => void, food = true) => {
    const app = await device();
    app.updateProfile({ gymTime: 'evening' });
    app.saveNutrition({ profile: { age: 24, ageAsOf: TODAY, lifestyle: 'moderate', avoid: ['beef'], budget: 'moderate' }, heightCm: 183, targetKg: 79, weightKg: 72 });
    if (food) {
      app.logFood({ date: TODAY, meal: 'breakfast', foodId: 'egg', qty: 3 });
      app.logFood({ date: TODAY, meal: 'breakfast', foodId: 'roti', qty: 2 });
    }
    edit?.(app);
    return snapshot(app);
  };
  const targetsOf = (d: ApexData) => {
    const t = nutritionTargets(d, TODAY);
    if (!t.ok) throw new Error('no targets');
    return t.targets;
  };
  /** What the tool must say for a planned meal: each item recomputed from the food table, not taken from the tool. */
  const fromTable = (m: PlannedMeal) => ({
    name: m.name, kcal: m.kcal, protein_g: m.protein, logged: m.eaten,
    items: m.items.map((i) => {
      const f = foodById(i.foodId)!;
      const x = macrosOf(f, gramsOf(f, i.qty, i.unit)!);
      return { food: f.name, amount: amountText(i.qty, i.unit), kcal: x.kcal, protein_g: x.protein };
    }),
  });
  /** Items add up to the meal; the meal is what the tool says. */
  const addsUp = (m: Meal) => {
    expect([m.name, sum(m.items.map((i) => i.kcal)), g1(sum(m.items.map((i) => i.protein_g)))]).toEqual([m.name, m.kcal, m.protein_g]);
  };

  it('suggested meals and every pre-gym timing carry APEX’s own per-item numbers (seen live: invented per-item kcal, the wrong timing)', async () => {
    const d = await fed((app) => app.setPreGymWindow(TODAY, 'under45'));
    const t = targetsOf(d);
    const n = await run('get_nutrition_day', { date: null }, d);
    const plan = dayPlan(d, TODAY, TODAY, t);
    expect(n.suggested).toEqual(plan.meals.map((m) => ({ meal: MEAL_LABEL[m.slot], ...fromTable(m) })));
    // one option per time before training, each the meal APEX picks for that timing; the app's choice is named
    const at = (w: PreGymWindow) => dayPlan({ ...d, nutrition: { ...d.nutrition, days: { [TODAY]: { preGym: w } } } }, TODAY, TODAY, t).preGym!;
    const windows: PreGymWindow[] = ['under45', '1to2h', '2to3h'];
    expect(n.pre_gym).toEqual({
      gym_time: 'evening', shown_in_app: 'Under 45 min before training',
      options: windows.map((w) => ({ timing: `${WINDOW_LABEL[w]} before training`, ...fromTable(at(w)) })),
    });
    expect(n.pre_gym.options.map((o: Meal) => MEALS.find((x) => x.name === o.name)?.window)).toEqual(windows);
    for (const m of [...n.suggested, ...n.pre_gym.options] as Meal[]) {
      expect(m.items.length).toBeGreaterThan(0);
      for (const i of m.items) expect([i.kcal, i.protein_g].every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
      addsUp(m);
    }
    expect(n.suggested.every((m: Meal) => !m.logged)).toBe(true); // shown, not eaten
    expect(JSON.stringify(n).toLowerCase()).not.toMatch(/beef curry|beef,|whey|protein powder/);
  });

  it('logged food: items, meal totals and the day total agree, to the food table', async () => {
    const d = await fed((app) => { app.logFood({ date: TODAY, meal: 'lunch', foodId: 'dal', qty: 1.5 }); });
    const t = targetsOf(d);
    const n = await run('get_nutrition_day', { date: null }, d);
    expect(n.logged).toEqual([
      { meal: 'Breakfast', kcal: 435, protein_g: 25.9, items: [{ food: 'Egg (whole)', amount: '3 eggs', kcal: 215, protein_g: 18.9 }, { food: 'Roti / chapati', amount: '2 rotis', kcal: 220, protein_g: 7 }] },
      { meal: 'Lunch', kcal: 248, protein_g: 14.6, items: [{ food: 'Dal (cooked, home-style)', amount: '1.5 katoris', kcal: 248, protein_g: 14.6 }] },
    ]);
    for (const m of n.logged) addsUp({ ...m, name: m.meal, logged: true });
    expect(n.items_not_listed).toBe(0);
    expect(n.eaten).toEqual({ kcal: 683, protein_g: 40.5, carbs_g: dayLog(d, TODAY).totals.carbs, fat_g: dayLog(d, TODAY).totals.fat });
    expect(n.eaten.kcal).toBe(sum(n.logged.map((m: { kcal: number }) => m.kcal)));
    expect(n.remaining).toEqual({ kcal: t.kcal - 683, protein_g: g1(t.protein - 40.5), carbs_g: g1(t.carbs - n.eaten.carbs_g), fat_g: g1(t.fat - n.eaten.fat_g) });
    expect(n.basis.join(' ')).toMatch(/Mifflin–St Jeor/);
    expect(n.diet).toMatch(/non-vegetarian; never: beef; .*no supplements/);
  });

  it('an empty log is zero eaten and the whole target left — not missing data', async () => {
    const d = await fed(undefined, false);
    const t = targetsOf(d);
    const n = await run('get_nutrition_day', { date: null }, d);
    expect(n).toMatchObject({ set_up: true, unavailable: [], logged: [], items_not_listed: 0, eaten: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } });
    expect(n.remaining).toEqual({ kcal: t.kcal, protein_g: t.protein, carbs_g: t.carbs, fat_g: t.fat });
    expect(n.suggested).toHaveLength(4);
  });

  it('with more items than it lists, meal and day totals still cover every item — and say how many are not listed', async () => {
    const d = await fed((app) => { for (let i = 0; i < 45; i++) app.logFood({ date: TODAY, meal: 'snacks', foodId: 'egg', qty: 1 }); });
    const n = await run('get_nutrition_day', { date: null }, d);
    const all = dayLog(d, TODAY);
    expect(sum(n.logged.map((m: { items: Item[] }) => m.items.length))).toBe(40);
    expect(n.items_not_listed).toBe(all.entries.length - 40);
    expect(n.logged.find((m: { meal: string }) => m.meal === 'Snacks')).toMatchObject({ kcal: 45 * 72, protein_g: g1(45 * 6.3) });
    expect(n.eaten.kcal).toBe(all.totals.kcal);
    expect(n.eaten.kcal).toBe(sum(n.logged.map((m: { kcal: number }) => m.kcal)));
    expect(n.eaten.protein_g).toBe(g1(sum(n.logged.map((m: { protein_g: number }) => m.protein_g))));
  });

  it('missing data is said, never filled in: no profile, a past day, no gym today', async () => {
    const fresh = await run('get_nutrition_day', { date: null }, await athleteData());
    expect(fresh).toMatchObject({
      set_up: false, targets: null, remaining: null, suggested: [], pre_gym: null, logged: [], eaten: { kcal: 0 },
      unavailable: ["targets, remaining and suggestions: missing age, height, a weigh-in on or before 2026-10-07 — add them in the app's Nutrition tab"],
    });
    // a day before the first weigh-in: set up, but no weight for that day — said as such, not as "set up nutrition"
    const set = await fed();
    expect(await run('get_nutrition_day', { date: '2026-10-06' }, set)).toMatchObject({
      set_up: true, targets: null, unavailable: ["targets, remaining and suggestions: missing a weigh-in on or before 2026-10-06 — add it in the app's Nutrition tab"],
    });
    const weighed = { ...set, bodyMetrics: [...set.bodyMetrics, { id: 'bw0', date: '2026-10-01', kind: 'bodyweight' as const, value: 72 }] };
    const past = await run('get_nutrition_day', { date: '2026-10-06' }, weighed);
    expect(past).toMatchObject({ targets: { kcal: expect.any(Number) }, suggested: [], pre_gym: null, unavailable: ['suggested meals: APEX suggests meals for today only'], logged: [] });
    // basketball still planned, the gym session made a recovery day: no pre-gym meal, and it says why
    const noGym = await fed((app) => { for (const i of app.getState().data.instances.filter((x) => x.date === TODAY)) app.takeRecoveryDay(i.id); });
    const r = await run('get_nutrition_day', { date: null }, noGym);
    expect(r).toMatchObject({ day_type: 'Basketball day (planned)', pre_gym: null, unavailable: ['pre-gym meal: no gym session today'] });
    expect(r.suggested).toHaveLength(4);
    expect((await runTool('get_nutrition_day', JSON.stringify({ date: '2026-10-08' }), ctxFor(await fed()))).ok).toBe(false); // no future days
    expect(await runTool('get_nutrition_day', JSON.stringify({ date: 'yesterday' }), ctxFor(await fed()))).toMatchObject({ ok: false, detail: '$.date: wrong format' });
  });

  it('estimates meals from the food table item by item; unknown foods, units and amounts are refused, never swapped', async () => {
    const m = await run('get_meal_estimate', { items: [
      { food: 'anda', quantity: 2, unit: null }, { food: 'roti', quantity: 3, unit: 'rotis' }, { food: 'rice', quantity: 200, unit: 'grams' },
      { food: 'milk', quantity: 300, unit: 'ml' }, { food: 'dal', quantity: null, unit: null },
      { food: 'rice', quantity: 2, unit: 'cup' }, { food: 'rice', quantity: 5000, unit: 'g' }, { food: 'egg', quantity: 0, unit: null }, { food: 'beef curry', quantity: 1, unit: null },
    ] }, await athleteData());
    const table = (id: string, qty: number, unit?: string) => {
      const f = foodById(id)!;
      const x = macrosOf(f, gramsOf(f, qty, unit)!);
      return { kcal: x.kcal, protein_g: x.protein, carbs_g: x.carbs, fat_g: x.fat };
    };
    expect(m.items).toEqual([
      { food: 'Egg (whole)', amount: '2 eggs', amount_from: 'asked', ...table('egg', 2), cost: 'budget' },
      { food: 'Roti / chapati', amount: '3 rotis', amount_from: 'asked', ...table('roti', 3), cost: 'budget' },
      { food: 'Rice, cooked', amount: '200 g', amount_from: 'asked', ...table('rice', 200, 'g'), cost: 'budget' },
      { food: 'Milk, toned', amount: '300 ml', amount_from: 'asked', ...table('milk-toned', 300, 'ml'), cost: 'budget' },
      { food: 'Dal (cooked, home-style)', amount: '1 katori', amount_from: 'usual serving', ...table('dal', 1), cost: 'budget' },
    ]);
    expect(m.not_found).toEqual([
      { asked: 'rice (cup)', reason: 'unknown unit', options: ['bowl', 'g'] }, // not quietly turned into "2 bowls"
      { asked: 'rice (5000 g)', reason: 'amount out of range', options: [] },
      { asked: 'egg (0 egg)', reason: 'amount out of range', options: [] },
      { asked: 'beef curry', reason: 'unknown food', options: [] },
    ]);
    const items = m.items as { kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
    expect(m.total).toEqual({ kcal: sum(items.map((i) => i.kcal)), protein_g: g1(sum(items.map((i) => i.protein_g))), carbs_g: g1(sum(items.map((i) => i.carbs_g))), fat_g: g1(sum(items.map((i) => i.fat_g))) });
    expect(m.note).toMatch(/Estimates/);
    expect(await run('get_meal_estimate', { items: [{ food: 'pizza', quantity: 1, unit: null }] }, await athleteData())).toMatchObject({ items: [], total: { kcal: 0, protein_g: 0 } });
  });

  it('each request sees only the data it was sent: two athletes, two different days', async () => {
    const mine = await fed();
    const theirs = await athleteData();
    expect((await run('get_nutrition_day', { date: null }, mine)).eaten.kcal).toBe(435);
    expect((await run('get_nutrition_day', { date: null }, theirs)).logged).toEqual([]);
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
