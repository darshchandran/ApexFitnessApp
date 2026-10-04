import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { previousPerformance } from '../../domain/history';
import { dailyLoad, gymVolume, plyoLoad } from '../../domain/load';
import { adaptationStatus, exerciseBests, exerciseHistory, exerciseSeries, supersetLabels, workoutSummary } from '../../domain/logbook';
import { weeklySets } from '../../domain/volume';
import type { PlyometricInstance, WorkoutInstance } from '../../domain/types';
import { createApex, DOUBLE_TAP_MS, todayOverview } from '../apex';

// Mon 5 Oct 2026: Push rotation (Push V1) + Vertical Power. Wed 7 Oct: Legs + basketball.
function setup(y = 2026, m = 10, d = 5, store = memoryStore()) {
  const c = { now: new Date(y, m - 1, d, 18) };
  const tick = (msec = 120_000) => { c.now = new Date(c.now.getTime() + msec); };
  const day = (dd: number, hour = 18) => { c.now = new Date(y, m - 1, dd, hour); };
  const apex = createApex(store, () => c.now);
  const restart = async () => { const b = createApex(store, () => c.now); await b.init(); return b; };
  return { apex, store, tick, day, restart };
}
type A = ReturnType<typeof createApex>;
const inst = (a: A, id: string) => a.getState().data.instances.find((i) => i.id === id) as WorkoutInstance;
const exNamed = (w: WorkoutInstance, exerciseId: string) => w.exercises.find((e) => e.exerciseId === exerciseId)!;
const templates = (a: A) => JSON.stringify(a.getState().data.templates);
const total = (w: WorkoutInstance) => w.exercises.filter((e) => e.status !== 'removed').reduce((n, e) => n + e.prescribed.sets, 0);

/** Log every prescribed set of one exercise, spacing the taps like a real session. */
function logAll(a: A, tick: (ms?: number) => void, id: string, exerciseId: string, sets: [number, number, number?][]) {
  const e = exNamed(inst(a, id), exerciseId);
  for (const [weight, reps, rir] of sets) {
    a.logSet(id, e.id, { kind: 'working', weight, reps, rir });
    tick();
  }
}

describe('workout entry', () => {
  it('1 · start: today’s Push V1 opens from the template with every exercise ready, rotation kept', async () => {
    const { apex } = setup();
    await apex.init();
    const scheduled = todayOverview(apex.getState().data, apex.today()).gym!;
    const id = apex.openTemplate('gym', 'push-v1')!;
    expect(id).toBe(scheduled.id); // the scheduled rotation session, not a copy
    apex.startInstance(id);
    const w = inst(apex, id);
    expect(w.status).toBe('active');
    expect(w.rotationId).toBe('rot-push');
    expect(w.exercises.map((e) => e.name)).toEqual([
      'Incline Dumbbell Bench Press', 'Seated Machine Fly', 'Seated Dumbbell Shoulder Press', 'Cable Overhead Triceps Extension',
      'Lateral Machine Raise', 'Single Arm Triceps Extension', 'Cable Crunch', 'Russian Twist',
    ]);
    expect(w.exercises.every((e) => e.sets.length === 0)).toBe(true); // prepared, nothing marked done
  });

  it('2 · resume: opening the template again returns the started session — no duplicate', async () => {
    const { apex } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    apex.startInstance(id);
    const count = apex.getState().data.instances.length;
    expect(apex.openTemplate('gym', 'push-v1')).toBe(id);
    apex.startInstance(id);
    expect(apex.getState().data.instances).toHaveLength(count);
  });

  it('a template that isn’t scheduled today gets a freshly adapted plan, once', async () => {
    const { apex } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'pull')!;
    expect(inst(apex, id).templateId).toBe('pull');
    expect(apex.openTemplate('gym', 'pull')).toBe(id);
  });
});

describe('logging sets', () => {
  it('3 · LOG SET stores the set, starts the session and advances the set count', async () => {
    const { apex } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    const s = apex.logSet(id, e.id, { kind: 'working', weight: 12.5, reps: 12 });
    expect(s).toBeDefined();
    const w = inst(apex, id);
    expect(w.status).toBe('active');
    expect(w.startedAt).toBeDefined();
    expect(exNamed(w, 'incline-db-bench').sets).toEqual([s]);
    expect(s!.rir).toBeUndefined(); // effort is optional
  });

  it('4 · rapid duplicate taps store one set; a repeated quick-log SAVE stores one batch', async () => {
    const { apex, tick } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    apex.logSet(id, e.id, { kind: 'working', weight: 12.5, reps: 12 });
    apex.logSet(id, e.id, { kind: 'working', weight: 12.5, reps: 12 });
    expect(exNamed(inst(apex, id), 'incline-db-bench').sets).toHaveLength(1);
    tick();
    const fly = exNamed(inst(apex, id), 'machine-fly');
    const batch = [{ kind: 'working' as const, weight: 40, reps: 12 }, { kind: 'working' as const, weight: 40, reps: 12 }];
    expect(apex.logSets(id, fly.id, batch)).toBe(2); // identical sets inside one batch are real sets
    expect(apex.logSets(id, fly.id, batch)).toBe(0);
    expect(exNamed(inst(apex, id), 'machine-fly').sets).toHaveLength(2);
    tick(DOUBLE_TAP_MS + 1);
    expect(apex.logSets(id, fly.id, batch.slice(0, 1))).toBe(1);
  });

  it('8/9 · warm-ups are logged and kept in history but are not working volume or PRs', async () => {
    const { apex, tick, day } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    apex.logSet(id, e.id, { kind: 'warmup', weight: 10, reps: 10 });
    tick();
    apex.logSet(id, e.id, { kind: 'working', weight: 15, reps: 8 });
    const w = inst(apex, id);
    expect(exNamed(w, 'incline-db-bench').sets.map((s) => s.kind)).toEqual(['warmup', 'working']);
    expect(gymVolume(w)).toEqual({ workingSets: 1, volumeLoad: 120 });
    expect(exNamed(w, 'incline-db-bench').status).toBe('pending'); // 1 of 3 working sets
    apex.finishInstance(id);
    expect(weeklySets(apex.getState().data.instances, apex.today()).chest).toBe(1);
    expect(exerciseHistory(apex.getState().data.instances, 'incline-db-bench')[0].sets).toHaveLength(2);

    // a heavy warm-up next time is not a weight PR
    day(8);
    apex.refreshToday();
    const id2 = apex.openTemplate('gym', 'push-v1')!;
    const e2 = exNamed(inst(apex, id2), 'incline-db-bench');
    apex.logSet(id2, e2.id, { kind: 'warmup', weight: 30, reps: 5 });
    tick();
    apex.logSet(id2, e2.id, { kind: 'working', weight: 15, reps: 8 });
    expect(apex.finishInstance(id2).filter((p) => p.kind === 'weight')).toEqual([]);
  });

  it('a logged set can become a warm-up and carry a note; invalid edits are ignored', async () => {
    const { apex } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    const s = apex.logSet(id, e.id, { kind: 'working', weight: 12.5, reps: 12 })!;
    apex.updateSet(id, e.id, s.id, { kind: 'warmup', note: '  Felt strong.  ' });
    apex.updateSet(id, e.id, s.id, { reps: 0 });
    const got = exNamed(inst(apex, id), 'incline-db-bench').sets[0];
    expect(got).toMatchObject({ kind: 'warmup', note: 'Felt strong.', reps: 12 });
  });
});

describe('history, graph and records', () => {
  async function twoSessions() {
    const t = setup();
    await t.apex.init();
    const a = t.apex;
    const id1 = a.openTemplate('gym', 'push-v1')!;
    logAll(a, t.tick, id1, 'incline-db-bench', [[12.5, 12, 2], [12.5, 10, 1], [12.5, 8, 0]]);
    a.finishInstance(id1);
    t.day(8); // Thursday: Push rotation again
    a.refreshToday();
    const id2 = a.openTemplate('gym', 'push-v1')!;
    return { ...t, id1, id2 };
  }

  it('5 · previous performance is the last completed session, never the live one', async () => {
    const { apex, tick, id1, id2 } = await twoSessions();
    logAll(apex, tick, id2, 'incline-db-bench', [[15, 8]]);
    const prev = previousPerformance(apex.getState().data.instances, 'incline-db-bench', id2)!;
    expect(prev.instanceId).toBe(id1);
    expect(prev.sets.map((s) => `${s.weight}×${s.reps}`)).toEqual(['12.5×12', '12.5×10', '12.5×8']);
  });

  it('6/7 · exercise history lists both sessions newest first; graph data per metric', async () => {
    const { apex, tick, id1, id2 } = await twoSessions();
    logAll(apex, tick, id2, 'incline-db-bench', [[15, 10, 2], [15, 9, 1], [15, 8, 1]]);
    apex.finishInstance(id2);
    const h = exerciseHistory(apex.getState().data.instances, 'incline-db-bench');
    expect(h.map((x) => x.instanceId)).toEqual([id2, id1]);
    expect(h[0].sets.map((s) => s.rir)).toEqual([2, 1, 1]);
    expect(exerciseSeries(h, 'weight').map((p) => p.value)).toEqual([12.5, 15]);
    expect(exerciseSeries(h, 'volume').map((p) => p.value)).toEqual([375, 405]);
    expect(exerciseSeries(h, 'reps').map((p) => p.value)).toEqual([30, 27]);
    expect(exerciseSeries(h, 'e1rm').map((p) => p.value)).toEqual([17.5, 20]);
    const b = exerciseBests(h)!;
    expect(b.best.set).toMatchObject({ weight: 15, reps: 10 });
    expect(b.e1rm.value).toBe(20);
    expect(b.last.set).toMatchObject({ weight: 15, reps: 10 });
    expect(exerciseBests([])).toBeUndefined();
  });

  it('19 · the first session is a baseline; beating it is a PR', async () => {
    const { apex, tick, id1, id2 } = await twoSessions();
    expect(apex.getState().data.records.filter((r) => r.instanceId === id1)).toEqual([]);
    logAll(apex, tick, id2, 'incline-db-bench', [[15, 10]]);
    expect(apex.finishInstance(id2).map((p) => p.kind)).toEqual(expect.arrayContaining(['weight', 'e1rm']));
  });
});

describe('editing today’s session only', () => {
  it('10/11 · substitution inherits the slot’s prescription and leaves the template unchanged', async () => {
    const { apex } = setup();
    await apex.init();
    const before = templates(apex);
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    apex.substituteExercise(id, e.id, 'flat-db-bench');
    const s = inst(apex, id).exercises.find((x) => x.id === e.id)!;
    expect(s).toMatchObject({ exerciseId: 'flat-db-bench', name: 'Flat Dumbbell Bench Press', substitutedFrom: 'Incline Dumbbell Bench Press' });
    expect(s.prescribed).toEqual(e.prescribed);
    expect(templates(apex)).toBe(before);
  });

  it('12/13 · skip, add, remove and edit the prescription — instance only', async () => {
    const { apex } = setup();
    await apex.init();
    const before = templates(apex);
    const id = apex.openTemplate('gym', 'push-v1')!;
    const [a, b] = inst(apex, id).exercises;
    apex.setExerciseSkipped(id, a.id, true);
    expect(inst(apex, id).exercises[0].status).toBe('skipped');
    apex.addPrescribedSet(id, b.id);
    expect(inst(apex, id).exercises[1].prescribed.sets).toBe(4);
    apex.removePrescribedSet(id, b.id);
    apex.removePrescribedSet(id, b.id);
    apex.removePrescribedSet(id, b.id);
    apex.removePrescribedSet(id, b.id);
    expect(inst(apex, id).exercises[1].prescribed.sets).toBe(1); // floor of one
    apex.editPrescription(id, b.id, { sets: 2, repRange: [12, 15], restSec: 60, targetRir: 1 });
    apex.editPrescription(id, b.id, { repRange: [15, 12] }); // rejected
    expect(inst(apex, id).exercises[1].prescribed).toMatchObject({ sets: 2, repRange: [12, 15], restSec: 60, targetRir: 1 });
    expect(templates(apex)).toBe(before);
  });

  it('14 · superset two exercises for this session, labelled A1/A2, and unlink', async () => {
    const { apex } = setup();
    await apex.init();
    const before = templates(apex);
    const id = apex.openTemplate('gym', 'push-v1')!;
    const w = inst(apex, id);
    const lat = exNamed(w, 'lateral-machine-raise');
    apex.toggleSuperset(id, lat.id);
    const after = inst(apex, id);
    expect(supersetLabels(after.exercises)).toEqual({ [lat.id]: 'A1', [after.exercises[5].id]: 'A2' });
    apex.toggleSuperset(id, lat.id);
    expect(supersetLabels(inst(apex, id).exercises)).toEqual({});
    expect(templates(apex)).toBe(before);
  });

  it('15 · set, exercise and workout notes persist across a restart', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    apex.logSet(id, e.id, { kind: 'working', weight: 12.5, reps: 12, note: 'Felt strong.' });
    apex.setExerciseNotes(id, e.id, 'Left shoulder uncomfortable.');
    apex.setInstanceNotes(id, 'Gym was crowded.');
    await apex.flush();
    const b = await restart();
    const w = inst(b, id);
    expect(w.notes).toBe('Gym was crowded.');
    expect(exNamed(w, 'incline-db-bench').notes).toBe('Left shoulder uncomfortable.');
    expect(exNamed(w, 'incline-db-bench').sets[0].note).toBe('Felt strong.');
  });

  it('16 · quick log records forgotten sets in one go and completes the exercise', async () => {
    const { apex } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    const n = apex.logSets(id, e.id, [[12.5, 12], [12.5, 10], [12.5, 8]].map(([weight, reps]) => ({ kind: 'working' as const, weight, reps })));
    expect(n).toBe(3);
    expect(exNamed(inst(apex, id), 'incline-db-bench').status).toBe('done');
    expect(inst(apex, id).rest).toBeUndefined(); // quick log doesn't start a rest timer
    expect(apex.logSets(id, e.id, [{ kind: 'working', weight: 12.5, reps: 0 }])).toBe(0);
  });
});

describe('finishing', () => {
  it('17/18/20 · finish → summary with plan vs actual, volume change, skips, swaps and next-time advice', async () => {
    const { apex, tick, day } = setup();
    await apex.init();
    const id1 = apex.openTemplate('gym', 'push-v1')!;
    logAll(apex, tick, id1, 'incline-db-bench', [[12.5, 10, 2], [12.5, 10, 2], [12.5, 10, 2]]);
    apex.finishInstance(id1);
    day(8);
    apex.refreshToday();
    const id2 = apex.openTemplate('gym', 'push-v1')!;
    logAll(apex, tick, id2, 'incline-db-bench', [[12.5, 10, 2], [12.5, 10, 2], [12.5, 10, 2]]);
    logAll(apex, tick, id2, 'machine-fly', [[40, 12, 2]]);
    const w = inst(apex, id2);
    apex.setExerciseSkipped(id2, exNamed(w, 'russian-twist').id, true);
    apex.substituteExercise(id2, exNamed(w, 'cable-crunch').id, 'hanging-leg-raise');
    apex.finishInstance(id2);
    apex.finishInstance(id2); // idempotent
    const d = apex.getState().data;
    const done = inst(apex, id2);
    expect(done.status).toBe('completed');
    const s = workoutSummary(done, d.instances, d.records);
    expect(s.sets).toBe(4);
    expect(s.volume).toBe(375 + 480);
    expect(s.volumeChange).toBe(128); // 855 kg vs 375 kg last time
    expect(s.plan).toEqual({ planned: 22, prescribed: 22, done: 4, unit: 'sets' });
    expect(s.skipped).toEqual(['Russian Twist']);
    expect(s.substitutions).toEqual([{ from: 'Cable Crunch', to: 'Hanging Leg Raise' }]);
    const bench = s.progressions.find((p) => p.exerciseId === 'incline-db-bench')!;
    expect(bench.rec.action).toBe('increase'); // 10/10/10 @ 2 RIR at the top of 6–10
    expect(bench.rec.weight).toBe(14.5);
    expect(s.load.value).toBeGreaterThan(0);
  });

  it('20 · under high recent load the same performance holds the weight', async () => {
    const { apex, tick } = setup(2026, 10, 7); // Wed: Legs
    await apex.init();
    apex.logBasketball({ durationMin: 120, rpe: 9, jumping: 3, sprinting: 3, changeOfDirection: 3, lowerFatigue: 3 });
    const id = todayOverview(apex.getState().data, apex.today()).gym!.id;
    logAll(apex, tick, id, 'romanian-deadlift', [[80, 10, 2], [80, 10, 2]]);
    apex.finishInstance(id);
    const d = apex.getState().data;
    const rdl = workoutSummary(inst(apex, id), d.instances, d.records).progressions.find((p) => p.exerciseId === 'romanian-deadlift')!;
    expect(rdl.rec.action).toBe('hold');
    expect(rdl.rec.weight).toBe(80);
  });
});

describe('adaptation and control through a workout', () => {
  it('21 · an adapted workout keeps its decision while logging; history shows what was actually done', async () => {
    const { apex, tick } = setup(2026, 10, 7);
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3, changeOfDirection: 3 });
    const id = todayOverview(apex.getState().data, apex.today()).gym!.id;
    const planned = inst(apex, id);
    expect(planned.decision.outcome).not.toBe('normal');
    const decision = planned.decision;
    apex.startInstance(id);
    logAll(apex, tick, id, 'smith-squat', [[60, 8, 2], [60, 8, 2]]);
    apex.logBasketball({ durationMin: 30, rpe: 4, date: apex.today() }); // re-adaptation must not touch a started session
    expect(inst(apex, id).decision).toEqual(decision);
    apex.finishInstance(id);
    const d = apex.getState().data;
    const s = workoutSummary(inst(apex, id), d.instances, d.records);
    expect(s.adapted).toBe(true);
    expect(s.plan.planned).toBe(21);
    expect(s.plan.prescribed).toBe(total(planned));
    expect(s.plan.prescribed).toBeLessThan(21);
    expect(s.plan.done).toBe(2);
  });

  it('22 · KEEP PLAN survives starting, new load and a restart', async () => {
    const { apex, restart } = setup(2026, 10, 7);
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9 });
    const id = todayOverview(apex.getState().data, apex.today()).gym!.id;
    apex.setPlanMode(id, 'kept');
    apex.startInstance(id);
    apex.logBasketball({ durationMin: 60, rpe: 8, date: apex.today() });
    expect(inst(apex, id).plan).toBe('kept');
    expect(total(inst(apex, id))).toBe(21);
    await apex.flush();
    const b = await restart();
    expect(inst(b, id).plan).toBe('kept');
    expect(total(inst(b, id))).toBe(21);
    expect(inst(b, id).status).toBe('active');
  });

  it('23/24 · rest timer and logged sets survive a restart mid-workout', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const e = exNamed(inst(apex, id), 'incline-db-bench');
    apex.logSet(id, e.id, { kind: 'working', weight: 12.5, reps: 12 });
    const rest = { endsAt: Date.UTC(2026, 9, 5, 17, 2), total: 120 };
    apex.setRest(id, rest);
    await apex.flush();
    const b = await restart();
    const w = inst(b, id);
    expect(w.status).toBe('active');
    expect(w.rest).toEqual(rest);
    expect(exNamed(w, 'incline-db-bench').sets).toHaveLength(1);
    expect(b.openTemplate('gym', 'push-v1')).toBe(id); // resume, not restart
  });
});

describe('phase 4A completion', () => {
  it('A · no history gives clean empty states — nothing fabricated', async () => {
    const { apex } = setup();
    await apex.init();
    const ins = apex.getState().data.instances;
    expect(previousPerformance(ins, 'incline-db-bench')).toBeUndefined();
    const h = exerciseHistory(ins, 'incline-db-bench');
    expect(h).toEqual([]);
    expect(exerciseBests(h)).toBeUndefined();
    expect(exerciseSeries(h, 'e1rm')).toEqual([]);
  });

  it('I · a completed workout is read-only', async () => {
    const { apex } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const [a, b] = inst(apex, id).exercises;
    const s = apex.logSet(id, a.id, { kind: 'working', weight: 12.5, reps: 12 })!;
    apex.finishInstance(id);
    const frozen = JSON.stringify(inst(apex, id));
    expect(apex.logSet(id, a.id, { kind: 'working', weight: 20, reps: 5 })).toBeUndefined();
    expect(apex.logSets(id, a.id, [{ kind: 'working', weight: 20, reps: 5 }])).toBe(0);
    apex.updateSet(id, a.id, s.id, { weight: 100 });
    apex.deleteSet(id, a.id, s.id);
    apex.substituteExercise(id, b.id, 'cable-fly');
    apex.editPrescription(id, b.id, { sets: 5 });
    apex.setExerciseSkipped(id, b.id, true);
    apex.toggleSuperset(id, a.id);
    apex.setExerciseNotes(id, a.id, 'late edit');
    apex.setInstanceNotes(id, 'late edit');
    expect(JSON.stringify(inst(apex, id))).toBe(frozen);
  });

  it('J · labels: a trained adapted session is "Adapted"; "Alternative" only when it was actually taken', async () => {
    const { apex, restart } = setup(2026, 10, 7); // Wed: Legs
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3, changeOfDirection: 3 });
    const legs = todayOverview(apex.getState().data, apex.today()).gym!;
    expect(adaptationStatus(legs)).toBe('Adapted');
    expect(legs.decision.alternativeTemplateId).toBeDefined(); // suggested, not taken

    apex.useAlternative(legs.id);
    const alt = inst(apex, legs.id);
    expect(alt.templateId).toBe(legs.decision.alternativeTemplateId);
    expect(alt.alternativeFor).toEqual({ templateId: 'legs', templateName: 'Legs', rotationId: undefined });
    expect(adaptationStatus(alt)).toBe('Alternative');
    apex.logBasketball({ durationMin: 20, rpe: 3, date: apex.today() }); // re-adaptation keeps the choice
    expect(inst(apex, legs.id).alternativeFor?.templateName).toBe('Legs');
    await apex.flush();
    const b = await restart();
    expect(adaptationStatus(inst(b, legs.id))).toBe('Alternative');

    b.undoAlternative(legs.id);
    const back = inst(b, legs.id);
    expect(back.templateId).toBe('legs');
    expect(back.alternativeFor).toBeUndefined();
    expect(adaptationStatus(back)).toBe('Adapted');
    b.setPlanMode(legs.id, 'kept');
    expect(adaptationStatus(inst(b, legs.id))).toBe('Plan kept');
    b.takeRecoveryDay(legs.id);
    expect(adaptationStatus(inst(b, legs.id))).toBe('Recovery day');
  });

  it('J · an adapted workout completed as prescribed stays "Adapted", not "Alternative"', async () => {
    const { apex, tick } = setup(2026, 10, 7);
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3, changeOfDirection: 3 });
    const id = todayOverview(apex.getState().data, apex.today()).gym!.id;
    expect(inst(apex, id).decision.outcome).toBe('alternative'); // the engine suggested one
    logAll(apex, tick, id, 'smith-squat', [[60, 8], [60, 8]]);
    apex.finishInstance(id);
    expect(adaptationStatus(inst(apex, id))).toBe('Adapted');
  });

  it('a normal rotation session is "As planned" and keeps its rotation slot', async () => {
    const { apex } = setup(); // Mon: Push V1 from the rotation
    await apex.init();
    const w = todayOverview(apex.getState().data, apex.today()).gym!;
    expect(adaptationStatus(w)).toBe('As planned');
    expect(w.rotationId).toBe('rot-push');
  });

  it('K · quick log stores the same training data as live logging: load, volume and history agree', async () => {
    const live = setup();
    const quick = setup();
    await live.apex.init();
    await quick.apex.init();
    const sets: [number, number][] = [[12.5, 12], [12.5, 12], [12.5, 10]];
    const a = live.apex.openTemplate('gym', 'push-v1')!;
    logAll(live.apex, live.tick, a, 'incline-db-bench', sets);
    live.apex.finishInstance(a);
    const b = quick.apex.openTemplate('gym', 'push-v1')!;
    const ex = exNamed(inst(quick.apex, b), 'incline-db-bench');
    expect(quick.apex.logSets(b, ex.id, sets.map(([weight, reps]) => ({ kind: 'working' as const, weight, reps })))).toBe(3);
    quick.apex.finishInstance(b);
    const day = (x: A) => dailyLoad(x.getState().data, x.today());
    expect(day(quick.apex).gym).toBe(day(live.apex).gym);
    expect(day(quick.apex).gym).toBeGreaterThan(0);
    expect(weeklySets(quick.apex.getState().data.instances, quick.apex.today())).toEqual(weeklySets(live.apex.getState().data.instances, live.apex.today()));
    expect(exerciseHistory(quick.apex.getState().data.instances, 'incline-db-bench')[0].sets.map((s) => s.reps)).toEqual([12, 12, 10]);
  });

  it('K · plyometric quick log: one batch per SAVE, contacts and load counted once', async () => {
    const { apex, tick } = setup(); // Mon: Vertical Power
    await apex.init();
    const p = todayOverview(apex.getState().data, apex.today()).plyo!;
    const e = p.exercises[0];
    const logs = Array.from({ length: e.prescribed.sets }, () => ({ reps: e.prescribed.reps, value: 50 }));
    expect(apex.logPlyos(p.id, e.id, logs)).toBe(logs.length);
    expect(apex.logPlyos(p.id, e.id, logs)).toBe(0); // double tap on SAVE
    expect(apex.logPlyos(p.id, e.id, [{ reps: 0 }])).toBe(0); // invalid
    const after = apex.getState().data.instances.find((i) => i.id === p.id)!;
    expect(after.status).toBe('active');
    expect(after.exercises[0].status).toBe('done');
    tick();
    apex.finishInstance(p.id);
    const done = apex.getState().data.instances.find((i) => i.id === p.id) as PlyometricInstance;
    expect(plyoLoad(done).contacts).toBe(e.prescribed.sets * e.prescribed.reps * (e.prescribed.perSide ? 2 : 1));
    expect(dailyLoad(apex.getState().data, apex.today()).plyo).toBeGreaterThan(0);
  });

  it('L · a session superset survives a restart and never touches the template', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const before = templates(apex);
    const id = apex.openTemplate('gym', 'push-v1')!;
    const lat = exNamed(inst(apex, id), 'lateral-machine-raise');
    apex.toggleSuperset(id, lat.id);
    await apex.flush();
    const b = await restart();
    expect(Object.values(supersetLabels(inst(b, id).exercises))).toEqual(['A1', 'A2']);
    expect(templates(b)).toBe(before);
  });

  it('M · skipped stays skipped and an abandoned workout stays resumable the next day', async () => {
    const { apex, day, restart } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    const [a, b] = inst(apex, id).exercises;
    apex.logSet(id, a.id, { kind: 'working', weight: 12.5, reps: 12 });
    apex.setExerciseSkipped(id, b.id, true);
    await apex.flush();
    day(6); // never finished; next day
    const r = await restart();
    const w = inst(r, id);
    expect(w.status).toBe('active');
    expect(w.exercises[1].status).toBe('skipped');
    expect(todayOverview(r.getState().data, r.today()).active?.id).toBe(id); // Home's resume
    expect(r.getState().data.instances.filter((i) => i.id === id)).toHaveLength(1);
  });

  it('C · a paused rest timer persists; finishing clears it', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    apex.logSet(id, inst(apex, id).exercises[0].id, { kind: 'working', weight: 12.5, reps: 12 });
    apex.setRest(id, { endsAt: 0, total: 150, pausedLeft: 97 });
    await apex.flush();
    const b = await restart();
    expect(inst(b, id).rest).toEqual({ endsAt: 0, total: 150, pausedLeft: 97 });
    b.finishInstance(id);
    expect(inst(b, id).rest).toBeUndefined();
  });

  it('summary counts exercises completed out of today’s session', async () => {
    const { apex, tick } = setup();
    await apex.init();
    const id = apex.openTemplate('gym', 'push-v1')!;
    logAll(apex, tick, id, 'incline-db-bench', [[12.5, 12]]);
    logAll(apex, tick, id, 'machine-fly', [[40, 12]]);
    apex.finishInstance(id);
    const d = apex.getState().data;
    expect(workoutSummary(inst(apex, id), d.instances, d.records).exercises).toEqual({ done: 2, total: 8 });
  });
});
