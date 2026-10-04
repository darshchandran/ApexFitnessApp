import { describe, expect, it } from '@jest/globals';
import { adaptGym, adaptPlyo, buildContext } from '../adaptation';
import { generateGymInstance, generatePlyoInstance } from '../generate';
import { prescribedContacts } from '../load';
import { bball, byExercise, completedGym, ctxOf, deepFreeze, emptyCtx, freshData, gymTemplate, TODAY } from '../../test-utils';

const legs = () => deepFreeze(gymTemplate('legs'));
const plyo = (id: string) => freshData().plyoTemplates.find((t) => t.id === id)!;
const today = (...basketball: ReturnType<typeof bball>[]) => ctxOf({ basketball });

// single sessions today, no history (mixed: jumping 2, sprinting 1, change of direction 2 → 75 % lower body)
const LIGHT = bball({ durationMin: 45, rpe: 4, sessionType: 'shooting' });
const MODERATE = bball({ durationMin: 60, rpe: 6 });
const HARD = bball({ durationMin: 60, rpe: 8 });
const BRUTAL = bball({ durationMin: 75, rpe: 8, sessionType: 'scrimmage', jumping: 3 });

describe('adaptGym — same-day basketball', () => {
  it('no load → programmed volume, template untouched', () => {
    const t = legs();
    const snapshot = JSON.stringify(t);
    const plan = adaptGym(t, emptyCtx());
    expect(plan.decision.outcome).toBe('normal');
    expect(plan.decision.volumeFactor).toBe(1);
    const inst = generateGymInstance(t, plan, { date: TODAY, now: '' });
    expect(byExercise(inst)).toEqual(Object.fromEntries(t.exercises.map((e) => [e.name, e.sets])));
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it('light practice → normal', () => {
    expect(adaptGym(legs(), today(LIGHT)).decision.outcome).toBe('normal');
  });

  it('moderate practice → legs reduced to roughly 80–90 %', () => {
    const { decision } = adaptGym(legs(), today(MODERATE));
    expect(decision.outcome).toBe('reduced');
    expect(decision.volumeFactor).toBeGreaterThanOrEqual(0.8);
    expect(decision.volumeFactor).toBeLessThanOrEqual(0.9);
  });

  it('hard practice → legs 50–70 %: key lifts kept, unilateral work removed, cheap work kept', () => {
    const t = legs();
    const plan = adaptGym(t, today(HARD));
    expect(plan.decision.outcome).toBe('heavily_reduced');
    expect(plan.decision.volumeFactor).toBeGreaterThanOrEqual(0.5);
    expect(plan.decision.volumeFactor).toBeLessThanOrEqual(0.7);
    const inst = generateGymInstance(t, plan, { date: TODAY, now: '' });
    const sets = byExercise(inst);
    expect(sets['Bulgarian Deadlift']).toBe(0);
    expect(inst.exercises.find((e) => e.name === 'Bulgarian Deadlift')!.status).toBe('removed');
    expect(sets['Smith Machine Squat']).toBe(2);
    expect(sets['Romanian Deadlift']).toBe(2);
    expect(sets['Tibialis Raises']).toBe(2);
    expect(plan.decision.headline).toBe('High lower-body load from today’s basketball');
    expect(plan.decision.reasons.join(' ')).toMatch(/60 min @ RPE 8/);
    expect(plan.decision.reasons.join(' ')).toMatch(/Lower-body volume ↓ \d+%/);
    expect(t.exercises.find((e) => e.name === 'Bulgarian Deadlift')!.sets).toBe(2);
  });

  it('is muscle specific: the same hard practice leaves Pull, Upper and Push at full volume', () => {
    for (const id of ['pull', 'upper', 'push-v1']) {
      const { decision } = adaptGym(gymTemplate(id), today(HARD));
      expect(decision.outcome).toBe('normal');
      expect(decision.volumeFactor).toBe(1);
    }
  });

  it('Lower keeps its core work while the leg work is cut', () => {
    const t = gymTemplate('lower');
    const plan = adaptGym(t, today(HARD));
    const sets = byExercise(generateGymInstance(t, plan, { date: TODAY, now: '' }));
    expect(sets['Cable Crunch']).toBe(3);
    expect(sets['Lunges']).toBe(0);
    expect(sets['Leg Press']).toBeLessThan(3);
    expect(plan.decision.areas!.find((a) => a.area === 'core')!.preserved).toBe(true);
    expect(plan.decision.reasons).toContain('Core work preserved.');
  });

  it('a game-level session on a leg day → alternative upper session from the athlete’s own templates', () => {
    const { decision } = adaptGym(legs(), today(BRUTAL), { alternatives: [gymTemplate('lower'), gymTemplate('upper')] });
    expect(decision.bands.lower).toBe('extreme');
    expect(decision.outcome).toBe('alternative');
    expect(decision.alternativeTemplateId).toBe('upper');
  });

  it('self-reported heavy legs floors the lower body at high even after a short session', () => {
    const short = bball({ durationMin: 20, rpe: 5, lowerFatigue: 3 });
    expect(adaptGym(legs(), today(short)).decision.bands.lower).toBe('high');
  });

  it('recent lower-body gym volume adds to today’s practice', () => {
    const yesterday = completedGym('legs', '2026-10-06', {
      'smith-squat': [[80, 8, 0], [80, 8, 0], [80, 8, 0]],
      'romanian-deadlift': [[90, 8, 0], [90, 8, 0], [90, 8, 0]],
      'leg-press': [[160, 10, 0], [160, 10, 0], [160, 10, 0]],
      'seated-leg-curl': [[50, 12, 0], [50, 12, 0], [50, 12, 0]],
      'leg-extension': [[50, 12, 0], [50, 12, 0]],
    });
    const alone = adaptGym(legs(), today(MODERATE)).decision;
    const stacked = adaptGym(legs(), ctxOf({ basketball: [MODERATE], instances: [yesterday] })).decision;
    expect(stacked.inputs!.strain.lower!.score).toBeGreaterThan(alone.inputs!.strain.lower!.score);
    expect(stacked.volumeFactor).toBeLessThan(alone.volumeFactor);
  });

  it('a low recovery check-in alone trims; together with high load it recommends a recovery day', () => {
    const poor = { date: TODAY, sleepHours: 4, soreness: 5, energy: 1 };
    const alone = adaptGym(gymTemplate('pull'), ctxOf({ recovery: poor })).decision;
    expect(alone.readiness).toBeLessThan(35);
    expect(alone.outcome).not.toBe('deferred');
    expect(alone.volumeFactor).toBeLessThan(1);
    const loaded = adaptGym(legs(), ctxOf({ basketball: [HARD], recovery: poor })).decision;
    expect(loaded.outcome).toBe('deferred');
  });

  it('is deterministic', () => {
    const ctx = today(HARD);
    expect(adaptGym(legs(), ctx)).toEqual(adaptGym(legs(), ctx));
  });
});

describe('adaptPlyo', () => {
  const vp = () => plyo('vertical-power'); // 46 contacts
  const contacts = (t: ReturnType<typeof plyo>, ctx = emptyCtx()) =>
    prescribedContacts(generatePlyoInstance(t, adaptPlyo(t, ctx, { primerId: 'low-fatigue-primer' }), { date: TODAY, now: '' }));

  it('no jumping → full contacts', () => {
    expect(adaptPlyo(vp(), emptyCtx()).decision.outcome).toBe('normal');
    expect(contacts(vp())).toBe(46);
  });

  it('moderate jumping → 35–40 contacts, highest-intensity jumps trimmed first', () => {
    const ctx = today(bball({ durationMin: 60, rpe: 6, jumping: 2 }));
    const plan = adaptPlyo(vp(), ctx);
    const n = contacts(vp(), ctx);
    expect(plan.decision.outcome).toBe('reduced');
    expect(n).toBeGreaterThanOrEqual(35);
    expect(n).toBeLessThanOrEqual(40);
    const box = vp().exercises[1];
    expect(plan.prescription[box.id]).toEqual({ sets: 4, reps: 3 }); // lower-intensity work untouched
  });

  it('high jumping → 20–30 contacts', () => {
    const ctx = today(bball({ durationMin: 60, rpe: 7, jumping: 3 }));
    const plan = adaptPlyo(vp(), ctx, { primerId: 'low-fatigue-primer' });
    expect(plan.decision.bands.jump).toBe('high');
    const n = contacts(vp(), ctx);
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(30);
  });

  it('high load removes depth jumps first and keeps pogos at low volume', () => {
    const ctx = today(bball({ durationMin: 60, rpe: 7, jumping: 3 }));
    const t = plyo('max-power');
    const plan = adaptPlyo(t, ctx);
    const depth = t.exercises.find((e) => e.name === 'Depth Jump')!;
    expect(plan.prescription[depth.id].removed).toBe(true);
    expect(plan.decision.removed).toContain('Depth Jump');
    const r = plyo('reactive');
    const rp = adaptPlyo(r, ctx);
    const pogo = r.exercises.find((e) => e.name === 'Pogo Jump')!;
    expect(rp.prescription[pogo.id].sets).toBeGreaterThanOrEqual(1);
    expect(rp.prescription[pogo.id].reps).toBeGreaterThanOrEqual(8);
  });

  it('very high jumping → primer, or skip when the primer is already planned', () => {
    const ctx = today(bball({ durationMin: 90, rpe: 8, jumping: 3 }));
    const a = adaptPlyo(vp(), ctx, { primerId: 'low-fatigue-primer' }).decision;
    expect(a.outcome).toBe('alternative');
    expect(a.alternativeTemplateId).toBe('low-fatigue-primer');
    expect(adaptPlyo(plyo('low-fatigue-primer'), ctx, { primerId: 'low-fatigue-primer' }).decision.outcome).toBe('deferred');
  });

  it('records programmed vs prescribed contacts', () => {
    const ctx = today(bball({ durationMin: 60, rpe: 6, jumping: 2 }));
    const d = adaptPlyo(vp(), ctx).decision;
    expect(d.plannedVolume).toBe(46);
    expect(d.prescribedVolume).toBe(contacts(vp(), ctx));
    expect(d.unit).toBe('contacts');
  });
});

describe('buildContext', () => {
  it('reads 28 days of history from stored data', () => {
    const d = freshData();
    d.basketball = [bball({ durationMin: 60, rpe: 7 }), bball({ durationMin: 60, rpe: 7, date: '2026-08-01' })];
    d.instances = [completedGym('pull', '2026-10-06', { 'lat-pulldown': [[60, 10, 2]] })];
    const ctx = buildContext(d, TODAY);
    expect(ctx.days).toHaveLength(28);
    expect(ctx.days[0].sessions.map((s) => s.kind)).toEqual(['basketball']);
    expect(ctx.days[1].areas.back).toBeGreaterThan(0);
    expect(ctx.days.some((x) => x.date === '2026-08-01')).toBe(false);
  });
});
