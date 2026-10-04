import { describe, expect, it } from '@jest/globals';
import { adaptGym, adaptPlyo } from '../adaptation';
import { gymExercise, plyoExercise } from '../catalog';
import { APEX_CONFIG } from '../config';
import { generateGymInstance, generatePlyoInstance } from '../generate';
import { insights } from '../insights';
import { basketballLoad, contactWeight, dayLoads, gymLoad, plyoLoad, prescribedContacts } from '../load';
import { fatigueFor, recommendProgression } from '../progression';
import { areaStrain, computeStrain, loadWindows, weeklyBaseline } from '../strain';
import * as T from '../templates';
import type { BasketballSession, RecoveryLog, SessionInstance, SetLog, WorkoutTemplate } from '../types';
import { addDays } from '../util';
import { muscleVolume, volumeStatus, weeklySets } from '../volume';
import { bball, completedGym, ctxOf, deepFreeze, freshData, gymTemplate } from '../../test-utils';

const FRI = '2026-10-16';
const day = (date: string, k: number) => addDays(date, -k);
const bb = (date: string, p: Partial<BasketballSession> & Pick<BasketballSession, 'durationMin' | 'rpe'>) => bball({ date, loggedAt: `${date}T09:00:00.000Z`, ...p, id: `bb-${date}-${p.durationMin}-${p.rpe}` });
const lowerOf = (s: BasketballSession) => basketballLoad(s).areas.lower!;
const plyoT = (id: string) => freshData().plyoTemplates.find((t) => t.id === id)!;
const contacts = (t: ReturnType<typeof plyoT>, ctx: ReturnType<typeof ctxOf>) =>
  prescribedContacts(generatePlyoInstance(t, adaptPlyo(t, ctx, { primerId: 'low-fatigue-primer' }), { date: ctx.date, now: '' }));

/** Monday legs at failure, then two hard practices, a rest day, and Friday. */
function acceptance(recovery?: Omit<RecoveryLog, 'date'>) {
  const mon = completedGym('legs', '2026-10-12', {
    'smith-squat': [[90, 8, 0], [90, 8, 0], [90, 7, 0]],
    'romanian-deadlift': [[100, 8, 0], [100, 8, 0], [100, 8, 0]],
    'leg-press': [[180, 10, 0], [180, 10, 0], [180, 9, 0]],
    'seated-leg-curl': [[55, 12, 0], [55, 12, 0], [55, 11, 0]],
    'bulgarian-deadlift': [[24, 10, 0], [24, 10, 0]],
    'leg-extension': [[60, 12, 0], [60, 12, 0]],
    'barbell-calf-raise': [[80, 12, 0], [80, 12, 0], [80, 12, 0]],
    'tibialis-raise': [[10, 15, 0], [10, 15, 0]],
  });
  const basketball = [
    bb('2026-10-13', { durationMin: 60, rpe: 8, jumping: 3, sprinting: 3 }),
    bb('2026-10-14', { durationMin: 90, rpe: 9, jumping: 3, changeOfDirection: 3 }),
  ];
  return ctxOf({ date: FRI, basketball, instances: [mon], recovery: recovery && { ...recovery, date: FRI } });
}

describe('acceptance: Mon legs → Tue + Wed hard basketball → Thu rest → Fri', () => {
  const fresh = ctxOf({ date: FRI });

  it('Friday legs is not treated as a fresh lower body', () => {
    const ctx = acceptance();
    const d = adaptGym(gymTemplate('legs'), ctx).decision;
    expect(adaptGym(gymTemplate('legs'), fresh).decision.volumeFactor).toBe(1);
    expect(d.outcome === 'reduced' || d.outcome === 'heavily_reduced').toBe(true);
    expect(d.volumeFactor).toBeLessThan(0.9);
    expect(d.reasons[0]).toMatch(/Wed: basketball 90 min @ RPE 9/);
    expect(d.headline).toMatch(/lower-body load from/);
  });

  it('Friday pull keeps its volume', () => {
    const d = adaptGym(gymTemplate('pull'), acceptance()).decision;
    expect(d.volumeFactor).toBeGreaterThanOrEqual(0.95);
    expect(d.outcome).toBe('normal');
  });

  it('Friday plyometrics are reduced by the accumulated jumping', () => {
    const ctx = acceptance();
    const plan = adaptPlyo(plyoT('vertical-power'), ctx, { primerId: 'low-fatigue-primer' });
    expect(plan.decision.outcome).not.toBe('normal');
    expect(contacts(plyoT('vertical-power'), ctx)).toBeLessThan(46);
    expect(contacts(plyoT('vertical-power'), fresh)).toBe(46);
  });

  it('good recovery softens the reduction; poor recovery makes it more conservative', () => {
    const base = adaptGym(gymTemplate('legs'), acceptance()).decision.volumeFactor;
    const good = adaptGym(gymTemplate('legs'), acceptance({ sleepHours: 8.5, soreness: 1, energy: 5 })).decision;
    const poor = adaptGym(gymTemplate('legs'), acceptance({ sleepHours: 5, soreness: 4, energy: 2 })).decision;
    expect(good.volumeFactor).toBeGreaterThan(base);
    expect(good.volumeFactor).toBeLessThan(1); // still not a fresh day
    expect(poor.volumeFactor).toBeLessThan(base);
    expect(good.reasons).toContain('Good recovery check-in — reductions kept smaller.');
    expect(poor.reasons).toContain('Low recovery check-in — reductions go a little further.');
  });
});

describe('load windows', () => {
  // practices on known days before Friday
  const ks = [0, 1, 2, 3, 5, 8, 13, 20, 27];
  const sessions = ks.map((k) => bb(day(FRI, k), { durationMin: 60, rpe: 5, sessionType: 'shooting' }));
  const unit = lowerOf(sessions[0]);
  const ctx = ctxOf({ date: FRI, basketball: sessions });
  const w = loadWindows(ctx.days, 'lower');

  it('separates today from the 24 h, 3, 7, 14 and 28-day windows', () => {
    expect(w.today).toBeCloseTo(unit);
    expect(w.d1).toBeCloseTo(unit); // yesterday
    expect(w.d3).toBeCloseTo(3 * unit); // k = 1, 2, 3
    expect(w.d7).toBeCloseTo(4 * unit); // + k = 5
    expect(w.d14).toBeCloseTo(6 * unit); // + 8, 13
    expect(w.d28).toBeCloseTo(8 * unit); // + 20, 27
  });

  it('uses the athlete’s own baseline once there are 14+ days of history, a default before', () => {
    const base = weeklyBaseline(ctx.days, 'lower', ctx.historyDays);
    expect(ctx.historyDays).toBe(28);
    expect(base.fromHistory).toBe(true);
    // days 7–27: k = 8, 13, 20, 27 → 4 sessions over 21 days
    expect(base.weekly).toBeCloseTo(Math.max((4 * unit / 21) * 7, APEX_CONFIG.defaultWeekly.lower * 0.5));
    const short = ctxOf({ date: FRI, basketball: sessions.slice(0, 3) });
    expect(weeklyBaseline(short.days, 'lower', short.historyDays)).toEqual({ weekly: APEX_CONFIG.defaultWeekly.lower, fromHistory: false });
  });
});

describe('body-area load', () => {
  it('one exercise loads several areas: primary fully, secondary half, plus its region', () => {
    const w = completedGym('push-v1', FRI, { 'incline-db-bench': [[30, 10, 2]] });
    const l = gymLoad(w);
    expect(l.areas.chest).toBeCloseTo(12);
    expect(l.areas.shoulders).toBeCloseTo(6);
    expect(l.areas.triceps).toBeCloseTo(6);
    expect(l.areas.upper).toBeCloseTo(12);
    expect(l.areas.lower).toBeUndefined();
  });

  it('basketball jumping shifts load to calves, Achilles and jumping; sprinting to hamstrings', () => {
    const jumpy = basketballLoad(bball({ durationMin: 60, rpe: 7, jumping: 3, sprinting: 0, changeOfDirection: 0 })).areas;
    const sprinty = basketballLoad(bball({ durationMin: 60, rpe: 7, jumping: 0, sprinting: 3, changeOfDirection: 0 })).areas;
    expect(jumpy.elastic! / jumpy.lower!).toBeGreaterThan(sprinty.elastic! / sprinty.lower!);
    expect(sprinty.hamstrings! / sprinty.lower!).toBeGreaterThan(jumpy.hamstrings! / jumpy.lower!);
    expect(jumpy.jump).toBeGreaterThan(sprinty.jump!);
    expect(sprinty.sprint).toBeGreaterThan(jumpy.sprint!);
  });
});

describe('basketball load', () => {
  it('scales with duration, RPE and session type; missing fields use the type’s defaults', () => {
    const quick = bball({ durationMin: 60, rpe: 7 }); // only the required fields
    const game = bball({ durationMin: 60, rpe: 7, sessionType: 'game' });
    expect(basketballLoad(quick).total).toBe(420);
    expect(basketballLoad(game).total).toBeCloseTo(420 * 1.15);
    expect(basketballLoad(bball({ durationMin: 90, rpe: 7 })).total).toBe(630);
    expect(basketballLoad(bball({ durationMin: 60, rpe: 9 })).total).toBe(540);
  });

  it('self-reported fatigue raises the region even when the numbers are modest', () => {
    const s = computeStrain(ctxOf({ basketball: [bball({ durationMin: 30, rpe: 4, upperFatigue: 3 })] }));
    expect(s.bands.upper).toBe('high');
    expect(s.bands.lower).toBe('low');
  });
});

describe('gym load', () => {
  const one = (id: string, set: [number, number, number?]) => gymLoad(completedGym('legs', FRI, { [id]: [set] })).total;

  it('harder sets, heavier sets and compound lifts count for more', () => {
    expect(one('smith-squat', [80, 8, 0])).toBeGreaterThan(one('smith-squat', [80, 8, 3]));
    expect(one('smith-squat', [100, 4, 2])).toBeGreaterThan(one('smith-squat', [80, 8, 2]));
    expect(one('smith-squat', [80, 10, 2])).toBeGreaterThan(one('leg-extension', [50, 10, 2]));
  });

  it('relative intensity applies only when the athlete has a best on the lift', () => {
    const w = completedGym('legs', FRI, { 'smith-squat': [[60, 8, 2]] });
    const withoutHistory = gymLoad(w).total;
    const light = gymLoad(w, { bestE1rm: () => 130 }).total;
    expect(light).toBeLessThan(withoutHistory);
  });
});

describe('plyometric load', () => {
  it('depth jumps outweigh pogos; single-leg and high jumps weigh more; RPE counts when given', () => {
    const depth = contactWeight(plyoExercise('depth-jump'), false, undefined);
    const pogo = contactWeight(plyoExercise('pogo-jump'), false, undefined);
    expect(depth).toBeGreaterThan(pogo * 3);
    expect(contactWeight(plyoExercise('cmj'), true, undefined)).toBeGreaterThan(contactWeight(plyoExercise('cmj'), false, undefined));
    expect(contactWeight(plyoExercise('cmj'), false, 60)).toBeGreaterThan(contactWeight(plyoExercise('cmj'), false, 40));
    const t = plyoT('deload');
    const inst = generatePlyoInstance(t, adaptPlyo(t, ctxOf({ date: FRI })), { date: FRI, now: '' });
    inst.status = 'completed';
    inst.exercises[0].logs = [{ id: 'a', reps: 10, completedAt: '' }];
    const plain = plyoLoad(inst);
    const hard = plyoLoad({ ...inst, sessionRpe: 9 });
    expect(plain.contacts).toBe(10);
    expect(hard.au).toBeGreaterThan(plain.au);
    expect(plain.areas.jump).toBeGreaterThan(0);
  });
});

describe('acute vs recent load', () => {
  it('flags a week well above the athlete’s own baseline and adds strain', () => {
    // three steady weeks of one practice every other day, then a week of daily hard practice
    const steady = Array.from({ length: 21 }, (_, i) => i + 7).filter((k) => k % 2 === 0)
      .map((k) => bb(day(FRI, k), { durationMin: 60, rpe: 6 }));
    const heavy = [1, 2, 3, 4, 5, 6].map((k) => bb(day(FRI, k), { durationMin: 75, rpe: 8 }));
    const normalWeek = [2, 4, 6].map((k) => bb(day(FRI, k), { durationMin: 60, rpe: 6 }));
    const spike = areaStrain(ctxOf({ date: FRI, basketball: [...steady, ...heavy] }), 'lower');
    const usual = areaStrain(ctxOf({ date: FRI, basketball: [...steady, ...normalWeek] }), 'lower');
    expect(spike.ratio).toBeGreaterThan(1.5);
    expect(spike.accumulated).toBe('extreme');
    expect(spike.accumulation).toBeGreaterThan(0);
    expect(spike.trend).toBe('up');
    expect(usual.ratio).toBeLessThan(1.2);
    expect(usual.accumulation).toBe(0);
    expect(spike.score).toBeGreaterThan(usual.score);
  });

  it('a daily practice the athlete is used to is not treated as accumulated fatigue', () => {
    const habitual = Array.from({ length: 28 }, (_, k) => k).filter((k) => k % 7 < 5)
      .map((k) => bb(day(FRI, k + 1), { durationMin: 60, rpe: 6 }));
    const s = areaStrain(ctxOf({ date: FRI, basketball: habitual }), 'lower');
    expect(s.accumulation).toBe(0);
    expect(s.accumulated).toBe('moderate');
  });
});

describe('weekly muscle volume', () => {
  it('counts direct sets fully and secondary groups half, once per group', () => {
    const w = completedGym('pull', FRI, {
      'lat-pulldown': [[60, 10], [60, 10], [60, 10]], // back + ½ biceps
      'chest-supported-row': [[40, 10], [40, 10]], // upper back + lats + rear delts → back once, ½ shoulders
    });
    const sets = weeklySets([w], FRI);
    expect(sets.back).toBe(5);
    expect(sets.biceps).toBe(1.5);
    expect(sets.shoulders).toBe(1);
  });

  it('labels each group against its target', () => {
    expect(volumeStatus(7, [8, 16])).toBe('under');
    expect(volumeStatus(12, [10, 20])).toBe('in range');
    expect(volumeStatus(19, [10, 18])).toBe('high');
    const v = muscleVolume([], FRI);
    expect(v.map((x) => x.group)).toEqual(['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes', 'calves', 'core']);
    expect(v.every((x) => x.status === 'under')).toBe(true);
  });
});

describe('exercise priority', () => {
  const hard = () => ctxOf({ basketball: [bball({ durationMin: 60, rpe: 8 })] });

  it('the athlete’s own priority wins over the default', () => {
    const legs = gymTemplate('legs');
    const now = legs.updatedAt;
    let t: WorkoutTemplate = T.updateExercise(legs, legs.exercises[0].id, { priority: 'optional' }, now); // squat → optional
    t = T.updateExercise(t, legs.exercises[3].id, { priority: 'primary' }, now); // leg curl → primary
    const plan = adaptGym(t, hard());
    const def = adaptGym(legs, hard());
    expect(plan.sets[legs.exercises[0].id]).toBe(0);
    expect(plan.decision.removed).toContain('Smith Machine Squat');
    expect(def.sets[legs.exercises[0].id]).toBeGreaterThan(0);
    expect(plan.sets[legs.exercises[3].id]).toBeGreaterThanOrEqual(def.sets[legs.exercises[3].id]);
  });

  it('a second heavy compound for the same muscle gives up more than the first', () => {
    const plan = adaptGym(gymTemplate('legs'), hard());
    const [squat, , press] = gymTemplate('legs').exercises;
    expect(plan.sets[press.id]).toBeLessThanOrEqual(plan.sets[squat.id]);
  });
});

describe('session order', () => {
  it('plyos after legs and basketball today are cut harder than after an upper day', () => {
    const date = FRI;
    const legsToday = completedGym('legs', date, { 'smith-squat': [[80, 8, 1], [80, 8, 1], [80, 8, 1]], 'leg-press': [[160, 10, 1], [160, 10, 1], [160, 10, 1]] });
    const upperToday = completedGym('upper', date, { 'lat-pulldown': [[60, 10, 1], [60, 10, 1], [60, 10, 1]], 'chest-press': [[60, 10, 1], [60, 10, 1], [60, 10, 1]] });
    const practice = bb(date, { durationMin: 60, rpe: 7 });
    const afterLegs = contacts(plyoT('vertical-power'), ctxOf({ date, basketball: [practice], instances: [legsToday] }));
    const afterUpper = contacts(plyoT('vertical-power'), ctxOf({ date, basketball: [practice], instances: [upperToday] }));
    expect(afterLegs).toBeLessThan(afterUpper);
  });

  it('a second upper session on the same day is trimmed; after legs it is not', () => {
    const date = FRI;
    const upperDone = completedGym('upper', date, {
      'incline-db-bench': [[30, 10, 1], [30, 10, 1], [30, 10, 1]], 'lat-pulldown': [[60, 10, 1], [60, 10, 1], [60, 10, 1]],
      'chest-supported-row': [[40, 10, 1], [40, 10, 1], [40, 10, 1]], 'chest-press': [[60, 10, 1], [60, 10, 1], [60, 10, 1]],
      'lateral-machine-raise': [[20, 15, 1], [20, 15, 1]], 'cable-face-pull': [[20, 15, 1], [20, 15, 1]],
      'ez-bar-curl': [[30, 10, 1], [30, 10, 1]], 'single-arm-triceps-ext': [[10, 12, 1], [10, 12, 1]],
    }, 'w-upper-am');
    const legsDone = completedGym('legs', date, { 'smith-squat': [[80, 8, 1], [80, 8, 1], [80, 8, 1]] }, 'w-legs-am');
    expect(adaptGym(gymTemplate('upper'), ctxOf({ date, instances: [upperDone] })).decision.volumeFactor).toBeLessThan(1);
    expect(adaptGym(gymTemplate('upper'), ctxOf({ date, instances: [legsDone] })).decision.volumeFactor).toBe(1);
  });

  it('chest trained hard yesterday trims today’s chest work and leaves back alone', () => {
    const push = completedGym('push-v1', day(FRI, 1), {
      'incline-db-bench': [[30, 10, 1], [30, 10, 1], [30, 10, 1]], 'machine-fly': [[50, 12, 1], [50, 12, 1], [50, 12, 1]],
    });
    const plan = adaptGym(gymTemplate('upper'), ctxOf({ date: FRI, instances: [push] }));
    const u = gymTemplate('upper').exercises;
    const chestSets = plan.sets[u[0].id] + plan.sets[u[3].id];
    expect(chestSets).toBeLessThan(6);
    expect(plan.sets[u[1].id]).toBe(3); // lat pulldown untouched
    expect(plan.decision.reasons.join(' ')).toMatch(/Chest trained in the last two days/);
  });
});

describe('progression under fatigue', () => {
  const sets = (...xs: [number, number, number][]): SetLog[] => xs.map(([weight, reps, rir], i) => ({ id: String(i), kind: 'working', weight, reps, rir, completedAt: '' }));
  const good = sets([80, 8, 2], [80, 8, 2], [80, 8, 2]);
  const poor = sets([80, 5, 0], [80, 5, 0], [80, 4, 0]);

  it('progresses on a normal day, holds on a high-fatigue day or a heavy week', () => {
    expect(recommendProgression({ repRange: [6, 8], increment: 2.5, previous: good }).action).toBe('increase');
    const today = recommendProgression({ repRange: [6, 8], increment: 2.5, previous: good, fatigue: { band: 'high' } });
    expect(today.action).toBe('hold');
    expect(today.reason).toMatch(/recent load on this area is high/);
    expect(recommendProgression({ repRange: [6, 8], increment: 2.5, previous: good, fatigue: { band: 'low', accumulated: 'high' } }).action).toBe('hold');
  });

  it('reads the lift’s fatigue from the recorded decision: legs held on the acceptance Friday, pull still progresses', () => {
    const ctx = acceptance();
    const legsDecision = adaptGym(gymTemplate('legs'), ctx).decision;
    const pullDecision = adaptGym(gymTemplate('pull'), ctx).decision;
    const squat = fatigueFor(legsDecision, gymExercise('smith-squat'));
    const pulldown = fatigueFor(pullDecision, gymExercise('lat-pulldown'));
    expect(squat.band).not.toBe('low');
    expect(recommendProgression({ repRange: [6, 10], increment: 2.5, previous: sets([80, 10, 2], [80, 10, 2]), fatigue: pulldown }).action).toBe('increase');
    const legsRec = recommendProgression({ repRange: [6, 10], increment: 2.5, previous: sets([80, 10, 2], [80, 10, 2]), fatigue: { ...squat, band: 'high' } });
    expect(legsRec.action).toBe('hold');
  });

  it('a poor session lowers the load on a fresh week but is read as fatigue in a heavy one', () => {
    expect(recommendProgression({ repRange: [6, 8], increment: 2.5, previous: poor }).action).toBe('decrease');
    const tired = recommendProgression({ repRange: [6, 8], increment: 2.5, previous: poor, fatigue: { band: 'high', accumulated: 'high' } });
    expect(tired).toMatchObject({ action: 'maintain', weight: 80 });
    expect(tired.reason).toMatch(/likely fatigue/);
  });
});

describe('templates are never mutated', () => {
  it('adapting, keeping the plan and generating leave frozen templates intact', () => {
    const d = freshData();
    const g = deepFreeze(d.templates);
    const p = deepFreeze(d.plyoTemplates);
    const snapshot = JSON.stringify([g, p]);
    const ctx = acceptance({ sleepHours: 5, soreness: 4, energy: 2 });
    for (const t of g) {
      const plan = adaptGym(t, ctx, { alternatives: g });
      generateGymInstance(t, plan, { date: FRI, now: '' });
      generateGymInstance(t, plan, { date: FRI, now: '', plan: 'kept' });
    }
    for (const t of p) {
      const plan = adaptPlyo(t, ctx, { primerId: 'low-fatigue-primer' });
      generatePlyoInstance(t, plan, { date: FRI, now: '' });
    }
    expect(JSON.stringify([g, p])).toBe(snapshot);
  });

  it('keeping the plan prescribes the template as written but records the recommendation', () => {
    const ctx = acceptance();
    const t = gymTemplate('legs');
    const plan = adaptGym(t, ctx);
    const kept = generateGymInstance(t, plan, { date: FRI, now: '', plan: 'kept' });
    expect(kept.plan).toBe('kept');
    expect(kept.exercises.map((e) => e.prescribed.sets)).toEqual(t.exercises.map((e) => e.sets));
    expect(kept.decision.volumeFactor).toBeLessThan(1);
  });
});

describe('explanations', () => {
  it('say what changed and why in plain words, never engine internals', () => {
    const full: WorkoutTemplate = {
      ...gymTemplate('upper'), id: 'full', name: 'Full Body',
      exercises: [
        { id: 'a', exerciseId: 'smith-squat', name: 'Smith Machine Squat', sets: 3, warmupSets: 0, repRange: [6, 10], restSec: 180, targetRir: 2 },
        { id: 'b', exerciseId: 'romanian-deadlift', name: 'Romanian Deadlift', sets: 3, warmupSets: 0, repRange: [6, 10], restSec: 180, targetRir: 2 },
        { id: 'c', exerciseId: 'incline-db-bench', name: 'Incline Dumbbell Bench Press', sets: 3, warmupSets: 0, repRange: [6, 10], restSec: 150, targetRir: 2 },
        { id: 'd', exerciseId: 'lat-pulldown', name: 'Lat Pulldown', sets: 3, warmupSets: 0, repRange: [8, 12], restSec: 120, targetRir: 2 },
      ],
    };
    const d = adaptGym(full, ctxOf({ basketball: [bball({ durationMin: 60, rpe: 8 })] })).decision;
    expect(d.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^Lower-body volume ↓ \d+%\.$/), 'Upper-body work preserved.']));
    expect(d.areas!.find((x) => x.area === 'upper')!.preserved).toBe(true);
    expect(d.modified!.length).toBeGreaterThan(0);
    const text = [d.headline, ...d.reasons].join(' ');
    expect(text).not.toMatch(/score|strain|ratio|coefficient|threshold|acute|chronic|\bAU\b|injur|NaN|undefined/i);
    for (const s of [acceptance(), acceptance({ sleepHours: 5, soreness: 5, energy: 1 })]) {
      for (const t of freshData().templates) {
        const r = adaptGym(t, s, { alternatives: freshData().templates }).decision;
        expect([r.headline, ...r.reasons].join(' ')).not.toMatch(/score|strain|ratio|coefficient|threshold|acute|chronic|\bAU\b|injur|NaN|undefined/i);
      }
    }
  });
});

describe('determinism + missing data', () => {
  it('same history, template, recovery and config → identical decisions', () => {
    const a = adaptGym(gymTemplate('legs'), acceptance({ sleepHours: 6, soreness: 3, energy: 3 }), { alternatives: freshData().templates });
    const b = adaptGym(gymTemplate('legs'), acceptance({ sleepHours: 6, soreness: 3, energy: 3 }), { alternatives: freshData().templates });
    expect(a).toEqual(b);
    const pa = adaptPlyo(plyoT('max-power'), acceptance(), { primerId: 'low-fatigue-primer' });
    expect(pa).toEqual(adaptPlyo(plyoT('max-power'), acceptance(), { primerId: 'low-fatigue-primer' }));
  });

  it('works with no recovery data, no history and no optional basketball fields', () => {
    const ctx = ctxOf({ basketball: [{ id: 'x', sport: 'basketball', date: '2026-10-07', loggedAt: '2026-10-07T08:00:00Z', durationMin: 60, rpe: 7 }] });
    const s = computeStrain(ctx);
    expect(s.readiness).toBeUndefined();
    expect(s.recoveryScale).toBe(1);
    const d = adaptGym(gymTemplate('legs'), ctx).decision;
    expect(Number.isFinite(d.volumeFactor)).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(dayLoads({ basketball: [], instances: [] }, FRI, 28).every((x) => x.total === 0)).toBe(true);
  });

  it('unknown exercises in history do not break load calculations', () => {
    const w = completedGym('legs', FRI, { 'smith-squat': [[80, 8, 2]] });
    const odd: SessionInstance = { ...w, exercises: [{ ...w.exercises[0], exerciseId: 'retired-machine' }] };
    expect(gymExercise('retired-machine').name).toBe('Unknown exercise');
    expect(() => computeStrain(ctxOf({ date: FRI, instances: [odd] }))).not.toThrow();
  });
});

describe('insights', () => {
  it('come from stored data only', () => {
    expect(insights(ctxOf({ date: FRI }), [])).toEqual([]);
    const steadyChest = [0, 7, 14].map((k) => completedGym('push-v1', day(FRI, k), {
      'incline-db-bench': [[30, 10], [30, 10], [30, 10]], 'machine-fly': [[50, 12], [50, 12], [50, 12]], 'seated-db-shoulder-press': [[22, 10], [22, 10], [22, 10]],
      'cable-overhead-triceps-ext': [[25, 12], [25, 12], [25, 12]], 'lateral-machine-raise': [[20, 15], [20, 15], [20, 15]],
    }, `push-${k}`));
    const lines = insights(ctxOf({ date: FRI, instances: steadyChest }), steadyChest).map((i) => i.text);
    expect(lines.some((t) => /^Shoulders volume has been consistent for 3 weeks — about 8 sets a week\.$/.test(t))).toBe(true);
  });

  it('notice a lower-body load increase week over week', () => {
    const lastWeek = [8, 10, 12].map((k) => bb(day(FRI, k), { durationMin: 60, rpe: 6 }));
    const thisWeek = [1, 2, 3, 4].map((k) => bb(day(FRI, k), { durationMin: 75, rpe: 8 }));
    const lines = insights(ctxOf({ date: FRI, basketball: [...lastWeek, ...thisWeek] }), []).map((i) => i.text);
    expect(lines.some((t) => /^Lower-body load is up \d+% on the previous 7 days\.$/.test(t))).toBe(true);
  });

  it('notice consecutive weeks of progression on a template', () => {
    const weeks = [[21, 70], [14, 72.5], [7, 75], [0, 77.5]].map(([k, w]) => completedGym('pull', day(FRI, k), { 'lat-pulldown': [[w, 10], [w, 10]] }, `pull-${k}`));
    const lines = insights(ctxOf({ date: FRI, instances: weeks }), weeks).map((i) => i.text);
    expect(lines.some((t) => /^Pull: 4 weeks in a row of progress on Lat Pulldown\.$/.test(t))).toBe(true);
  });
});
