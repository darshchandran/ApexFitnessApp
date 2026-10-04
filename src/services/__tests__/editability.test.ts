import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { gymLoad, gymVolume } from '../../domain/load';
import { adaptationStatus, exerciseHistory, exerciseSeries, planVsActual, workoutSummary } from '../../domain/logbook';
import { recommendProgression } from '../../domain/progression';
import { seedGymTemplates } from '../../domain/seed';
import type { SetLog, WorkoutInstance } from '../../domain/types';
import { weeklySets } from '../../domain/volume';
import { deepFreeze } from '../../test-utils';
import { createApex, DOUBLE_TAP_MS, todayOverview } from '../apex';

// Tue 6 Oct 2026: Pull. Wed 7: Legs. Thu 8: Push rotation.
function setup(d = 6, store = memoryStore()) {
  const c = { now: new Date(2026, 9, d, 18) };
  const tick = (ms = 120_000) => { c.now = new Date(c.now.getTime() + ms); };
  const apex = createApex(store, () => c.now);
  const restart = async () => { const b = createApex(store, () => c.now); await b.init(); return b; };
  return { apex, c, tick, store, restart };
}
type A = ReturnType<typeof createApex>;
const gym = (a: A) => todayOverview(a.getState().data, a.today()).gym as WorkoutInstance;
const inst = (a: A, id: string) => a.getState().data.instances.find((i) => i.id === id) as WorkoutInstance;
const byEx = (w: WorkoutInstance, exerciseId: string) => w.exercises.filter((e) => e.exerciseId === exerciseId);
const actual = (sets: SetLog[]) => sets.map((s) => [s.kind, s.weight, s.reps, s.rir]);
const W = (weight: number, reps: number, rir?: number) => ({ kind: 'working' as const, weight, reps, rir });

describe('every set is its own record', () => {
  it('four different sets stay four different sets; editing set 3 touches only set 3', async () => {
    const { apex, tick, restart } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0];
    apex.addPrescribedSet(w.id, e.id); // today 4 sets, template 3
    for (const s of [W(30, 10, 2), W(32.5, 8, 1), W(32.5, 7, 0), W(30, 8, 1)]) { apex.logSet(w.id, e.id, s); tick(); }
    const logged = inst(apex, w.id).exercises[0].sets;
    expect(actual(logged)).toEqual([['working', 30, 10, 2], ['working', 32.5, 8, 1], ['working', 32.5, 7, 0], ['working', 30, 8, 1]]);

    apex.updateSet(w.id, e.id, logged[2].id, { weight: 35, reps: 6, rir: 1 });
    await apex.flush();
    const b = await restart();
    expect(actual(inst(b, w.id).exercises[0].sets)).toEqual([['working', 30, 10, 2], ['working', 32.5, 8, 1], ['working', 35, 6, 1], ['working', 30, 8, 1]]);
    expect(inst(b, w.id).exercises[0].prescribed.sets).toBe(4);
    expect(b.getState().data.templates.find((t) => t.id === 'pull')!.exercises[0].sets).toBe(3);
  });
});

describe('planned vs actual', () => {
  it('the completed workout keeps the plan and the real sets — never normalised to the prescription', async () => {
    const { apex, tick, restart } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0]; // Lat Pulldown, 3 × 8–12
    for (const s of [W(30, 8), W(32.5, 8), W(32.5, 6)]) { apex.logSet(w.id, e.id, s); tick(); }
    apex.finishInstance(w.id);
    await apex.flush();
    const b = await restart();
    const done = inst(b, w.id).exercises[0];
    expect(done.prescribed).toMatchObject({ sets: 3, repRange: [8, 12] });
    expect(done.templateSets).toBe(3);
    expect(actual(done.sets)).toEqual([['working', 30, 8, undefined], ['working', 32.5, 8, undefined], ['working', 32.5, 6, undefined]]);
    expect(exerciseHistory(b.getState().data.instances, 'lat-pulldown')[0].sets.map((s) => `${s.weight}×${s.reps}`)).toEqual(['30×8', '32.5×8', '32.5×6']);
  });
});

describe('session-only exercise changes', () => {
  it('Bulgarian Deadlift → Lunges today: the template keeps Bulgarian Deadlift, history records Lunges', async () => {
    const { apex, tick } = setup(7); // Wed: Legs
    await apex.init();
    const w = gym(apex);
    const bulgarian = byEx(w, 'bulgarian-deadlift')[0];
    apex.substituteExercise(w.id, bulgarian.id, 'lunges'); // any exercise, not only close matches
    const swapped = inst(apex, w.id).exercises.find((e) => e.id === bulgarian.id)!;
    expect(swapped).toMatchObject({ exerciseId: 'lunges', name: 'Lunges', substitutedFrom: 'Bulgarian Deadlift', substitutedFromId: 'bulgarian-deadlift' });
    expect(swapped.prescribed).toEqual(bulgarian.prescribed);
    apex.logSet(w.id, bulgarian.id, W(20, 10));
    tick();
    apex.finishInstance(w.id);
    const d = apex.getState().data;
    expect(d.templates.find((t) => t.id === 'legs')!.exercises.find((e) => e.exerciseId === 'bulgarian-deadlift')).toBeDefined();
    expect(exerciseHistory(d.instances, 'lunges')).toHaveLength(1);
    expect(exerciseHistory(d.instances, 'bulgarian-deadlift')).toHaveLength(0);
    expect(workoutSummary(inst(apex, w.id), d.instances, d.records).substitutions).toEqual([{ from: 'Bulgarian Deadlift', to: 'Lunges' }]);
  });

  it('back to the original restores the planned exercise exactly', async () => {
    const { apex } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0];
    apex.substituteExercise(w.id, e.id, 'pull-up');
    apex.substituteExercise(w.id, e.id, 'lat-pulldown');
    const back = inst(apex, w.id).exercises[0];
    expect(back).toMatchObject({ exerciseId: 'lat-pulldown', name: 'Lat Pulldown', prescribed: e.prescribed, templateSets: 3 });
    expect(back.substitutedFrom).toBeUndefined();
    expect(back.substitutedFromId).toBeUndefined();
  });

  it('substituting after logging keeps what was done: logged sets stay, the swap takes the rest', async () => {
    const { apex, tick } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0]; // Lat Pulldown 3 sets
    apex.logSet(w.id, e.id, W(40, 10));
    tick();
    apex.substituteExercise(w.id, e.id, 'pull-up');
    let ex = inst(apex, w.id).exercises;
    expect(ex[0]).toMatchObject({ id: e.id, exerciseId: 'lat-pulldown', status: 'done', prescribed: { sets: 1 } });
    expect(actual(ex[0].sets)).toEqual([['working', 40, 10, undefined]]);
    expect(ex[1]).toMatchObject({ exerciseId: 'pull-up', substitutedFrom: 'Lat Pulldown', substitutedFromId: 'lat-pulldown', prescribed: { sets: 2 }, sets: [], templateSets: 0 });
    // and back again before logging anything on it: the slot is Lat Pulldown once more, history intact
    apex.substituteExercise(w.id, ex[1].id, 'lat-pulldown');
    ex = inst(apex, w.id).exercises;
    expect(ex[1]).toMatchObject({ exerciseId: 'lat-pulldown', name: 'Lat Pulldown', prescribed: { sets: 2 } });
    expect(ex[1].substitutedFrom).toBeUndefined();
    expect(actual(ex[0].sets)).toEqual([['working', 40, 10, undefined]]);
    expect(ex.reduce((n, x) => n + x.prescribed.sets, 0)).toBe(w.exercises.reduce((n, x) => n + x.prescribed.sets, 0)); // nothing gained or lost
  });

  it('an added exercise exists only in today’s session', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const w = gym(apex);
    const id = apex.addExerciseToInstance(w.id, 'ez-bar-curl')!;
    expect(apex.addExerciseToInstance(w.id, 'ez-bar-curl')).toBe(id); // double tap
    await apex.flush();
    const b = await restart();
    expect(inst(b, w.id).exercises.at(-1)).toMatchObject({ id, exerciseId: 'ez-bar-curl', templateSets: 0 });
    expect(b.getState().data.templates.find((t) => t.id === 'pull')!.exercises.some((e) => e.exerciseId === 'ez-bar-curl')).toBe(false);
  });
});

describe('skipped sets and exercises', () => {
  it('a skipped set is kept as skipped — not logged, not deleted — and finishes the slot without volume', async () => {
    const { apex, tick, restart } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0];
    apex.logSet(w.id, e.id, W(40, 10));
    tick();
    const s = apex.skipSet(w.id, e.id)!;
    expect(apex.skipSet(w.id, e.id)).toBe(s); // double tap
    tick(DOUBLE_TAP_MS + 1);
    apex.logSet(w.id, e.id, W(40, 9));
    expect(apex.skipSet(w.id, e.id)).toBeUndefined(); // nothing left to skip
    let ex = inst(apex, w.id).exercises[0];
    expect(actual(ex.sets)).toEqual([['working', 40, 10, undefined], ['skipped', 0, 0, undefined], ['working', 40, 9, undefined]]);
    expect(ex.status).toBe('done');
    expect(gymVolume(inst(apex, w.id))).toEqual({ workingSets: 2, volumeLoad: 760 });
    expect(apex.logSet(w.id, e.id, { kind: 'skipped', weight: 0, reps: 0 })).toBeUndefined(); // skipping goes through skipSet
    apex.updateSet(w.id, e.id, s.id, { kind: 'working', weight: 40, reps: 10 }); // can't turn a skip into a fake set
    await apex.flush();
    const b = await restart();
    ex = inst(b, w.id).exercises[0];
    expect(ex.sets[1].kind).toBe('skipped');
    b.deleteSet(w.id, e.id, s.id); // undo
    expect(inst(b, w.id).exercises[0].sets.map((x) => x.kind)).toEqual(['working', 'working']);
    expect(inst(b, w.id).exercises[0].status).toBe('pending');
  });

  it('skipped exercises, Apex-removed exercises and completed ones stay distinguishable after finishing', async () => {
    const { apex, tick } = setup(7);
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3 }); // Apex removes Bulgarian Deadlift
    const w = gym(apex);
    const [squat, rdl] = w.exercises;
    apex.logSet(w.id, squat.id, W(60, 8));
    tick();
    apex.setExerciseSkipped(w.id, rdl.id, true);
    apex.finishInstance(w.id);
    const d = apex.getState().data;
    const done = inst(apex, w.id);
    expect(done.exercises.map((e) => e.status)).toEqual(expect.arrayContaining(['pending', 'skipped', 'removed']));
    const s = workoutSummary(done, d.instances, d.records);
    expect(s.skipped).toEqual(['Romanian Deadlift']);
    expect(s.removed).toEqual(['Bulgarian Deadlift']);
    expect(done.exercises.some((e) => e.exerciseId === 'hip-thrust')).toBe(false); // never prescribed
  });
});

describe('warm-ups and rest', () => {
  it('warm-ups can be added, edited and removed, survive a restart and never count as working volume', async () => {
    const { apex, tick, restart } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0];
    const a = apex.logSet(w.id, e.id, { kind: 'warmup', weight: 20, reps: 12 })!;
    tick();
    const b0 = apex.logSet(w.id, e.id, { kind: 'warmup', weight: 30, reps: 8 })!;
    tick();
    apex.logSet(w.id, e.id, W(40, 10));
    apex.updateSet(w.id, e.id, a.id, { weight: 25, reps: 10 });
    apex.deleteSet(w.id, e.id, b0.id);
    await apex.flush();
    const b = await restart();
    const sets = inst(b, w.id).exercises[0].sets;
    expect(actual(sets)).toEqual([['warmup', 25, 10, undefined], ['working', 40, 10, undefined]]);
    expect(gymVolume(inst(b, w.id))).toEqual({ workingSets: 1, volumeLoad: 400 });
  });

  it('today’s rest changes today only and persists (the logger’s rest timer reads it from the session)', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const w = gym(apex);
    const e = w.exercises[0];
    apex.editPrescription(w.id, e.id, { restSec: 75 });
    await apex.flush();
    const b = await restart();
    expect(inst(b, w.id).exercises[0].prescribed.restSec).toBe(75);
    expect(b.getState().data.templates.find((t) => t.id === 'pull')!.exercises[0].restSec).toBe(e.prescribed.restSec);
    expect(e.prescribed.restSec).not.toBe(75);
  });
});

describe('template integrity', () => {
  it('every kind of session edit, finishing and a restart leave the templates identical to the seed', async () => {
    const { apex, tick, restart } = setup(7);
    await apex.init();
    const seed = JSON.stringify(seedGymTemplates(apex.getState().data.templates[0].createdAt));
    expect(JSON.stringify(apex.getState().data.templates)).toBe(seed);
    deepFreeze(apex.getState().data.templates); // any in-place write would throw
    apex.logBasketball({ durationMin: 60, rpe: 7 }); // adaptation in play too
    const w = gym(apex);
    const [a, b, c, d, e] = w.exercises;
    apex.editPrescription(w.id, a.id, { sets: 4, repRange: [5, 8], targetRir: 1, restSec: 200 });
    apex.logSet(w.id, a.id, { kind: 'warmup', weight: 40, reps: 8 }); tick();
    apex.logSet(w.id, a.id, W(60, 8, 2)); tick();
    apex.logSet(w.id, a.id, W(62.5, 6, 1)); tick();
    apex.skipSet(w.id, a.id); tick();
    apex.logSet(w.id, a.id, W(60, 7, 0)); tick();
    apex.addPrescribedSet(w.id, b.id);
    apex.removePrescribedSet(w.id, c.id);
    apex.substituteExercise(w.id, d.id, 'lying-leg-curl');
    apex.setExerciseSkipped(w.id, e.id, true);
    apex.toggleSuperset(w.id, b.id);
    apex.addExerciseToInstance(w.id, 'hip-thrust');
    apex.setExerciseNotes(w.id, a.id, 'Felt strong.');
    apex.setInstanceNotes(w.id, 'Gym was crowded.');
    apex.finishInstance(w.id);
    await apex.flush();
    const r = await restart();
    expect(JSON.stringify(r.getState().data.templates)).toBe(seed);
    // …while the session kept every change
    const done = inst(r, w.id);
    expect(done.exercises[0].prescribed).toMatchObject({ sets: 4, repRange: [5, 8], targetRir: 1, restSec: 200 });
    expect(done.exercises[0].sets.map((s) => s.kind)).toEqual(['warmup', 'working', 'working', 'skipped', 'working']);
    expect(done.exercises.find((x) => x.id === d.id)!.exerciseId).toBe('lying-leg-curl');
    expect(done.exercises.find((x) => x.id === e.id)!.status).toBe('skipped');
  });
});

describe('read-only history', () => {
  it('completed workouts reject set skips, substitutions and added exercises', async () => {
    const { apex } = setup();
    await apex.init();
    const w = gym(apex);
    apex.logSet(w.id, w.exercises[0].id, W(40, 10));
    apex.finishInstance(w.id);
    const frozen = JSON.stringify(inst(apex, w.id));
    expect(apex.skipSet(w.id, w.exercises[1].id)).toBeUndefined();
    apex.substituteExercise(w.id, w.exercises[1].id, 'pull-up');
    expect(apex.addExerciseToInstance(w.id, 'ez-bar-curl')).toBeUndefined();
    apex.editPrescription(w.id, w.exercises[1].id, { restSec: 30 });
    expect(JSON.stringify(inst(apex, w.id))).toBe(frozen);
  });
});

describe('progression, PRs, load and adaptation stay correct', () => {
  it('only real working sets feed PRs, e1RM, volume, load and progression', async () => {
    const { apex, tick, c } = setup();
    await apex.init();
    const w1 = gym(apex);
    const e1 = w1.exercises[0];
    for (const s of [W(40, 10, 2), W(40, 10, 2), W(40, 10, 2)]) { apex.logSet(w1.id, e1.id, s); tick(); }
    expect(apex.finishInstance(w1.id)).toEqual([]); // first session = baseline, never a PR

    c.now = new Date(2026, 9, 13, 18); // next Tuesday: Pull again
    apex.refreshToday();
    const w2 = gym(apex);
    const e2 = w2.exercises[0];
    apex.logSet(w2.id, e2.id, { kind: 'warmup', weight: 60, reps: 3 }); tick(); // heavy warm-up: not a PR
    apex.logSet(w2.id, e2.id, W(40, 8, 1)); tick();
    apex.skipSet(w2.id, e2.id); tick(); // skipped: not a PR, not volume
    apex.logSet(w2.id, e2.id, W(40, 8, 1)); tick();
    expect(apex.finishInstance(w2.id)).toEqual([]);
    const d = apex.getState().data;
    const done = inst(apex, w2.id);
    expect(done.status).toBe('completed');
    expect(gymVolume(done)).toEqual({ workingSets: 2, volumeLoad: 640 });
    expect(gymLoad(done).total).toBeGreaterThan(0);
    expect(weeklySets(d.instances, apex.today()).back).toBeGreaterThan(0);
    const h = exerciseHistory(d.instances, 'lat-pulldown');
    expect(exerciseSeries(h, 'weight').map((p) => p.value)).toEqual([40, 40]);
    expect(exerciseSeries(h, 'reps').map((p) => p.value)).toEqual([30, 16]);
    const s = workoutSummary(done, d.instances, d.records);
    expect(s.skippedSets).toBe(1);
    expect(s.sets).toBe(2);
    const rec = s.progressions.find((p) => p.exerciseId === 'lat-pulldown')!.rec;
    expect(rec).toEqual(recommendProgression({ repRange: [8, 12], increment: 2.5, previous: done.exercises[0].sets.filter((x) => x.kind === 'working') }));
  });

  it('manual edits on an adapted session keep Apex’s decision and its label', async () => {
    const { apex, tick } = setup(7);
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3 });
    const w = gym(apex);
    const decision = w.decision;
    expect(adaptationStatus(w)).toBe('Adapted');
    apex.addPrescribedSet(w.id, w.exercises[0].id);
    apex.substituteExercise(w.id, w.exercises[1].id, 'hip-thrust');
    apex.logSet(w.id, w.exercises[0].id, W(60, 8)); tick();
    apex.skipSet(w.id, w.exercises[0].id);
    apex.logBasketball({ durationMin: 20, rpe: 3, date: apex.today() }); // re-adaptation must not touch it
    apex.finishInstance(w.id);
    const done = inst(apex, w.id);
    expect(done.decision).toEqual(decision);
    expect(adaptationStatus(done)).toBe('Adapted');
    const v = planVsActual(done);
    expect(v.planned).toBe(21); // the template's plan
    expect(v.prescribed).toBe(w.exercises.filter((e) => e.status !== 'removed').reduce((n, e) => n + e.prescribed.sets, 0) + 1); // Apex's + the athlete's extra set
    expect(v.done).toBe(1); // a skipped set is not "done"
  });
});
