import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import type { PlyometricInstance, WorkoutInstance } from '../../domain/types';
import { createApex, progressOverview, todayOverview } from '../apex';

function setup(y: number, m: number, d: number) {
  const store = memoryStore();
  const c = { now: new Date(y, m - 1, d, 18) };
  const at = (day: number, hour = 18) => { c.now = new Date(y, m - 1, day, hour); };
  const apex = createApex(store, () => c.now);
  const restart = async () => { const b = createApex(store, () => c.now); await b.init(); return b; };
  return { apex, at, restart };
}
const gym = (a: ReturnType<typeof createApex>) => todayOverview(a.getState().data, a.today()).gym as WorkoutInstance;
const plyo = (a: ReturnType<typeof createApex>) => todayOverview(a.getState().data, a.today()).plyo as PlyometricInstance;

describe('acceptance through stored data', () => {
  it('Mon legs → Tue/Wed hard basketball → Thu rest → Fri legs is reduced, across a restart', async () => {
    const { apex, at, restart } = setup(2026, 10, 12); // Mon 12 Oct: Push rotation day; train Legs instead
    await apex.init();
    const legsId = apex.planSession('gym', 'legs')!;
    const legs = gym(apex);
    expect(legs.id).toBe(legsId);
    // every programmed set at failure (weights differ per set, so none is a double tap)
    for (const e of legs.exercises) {
      for (let k = 0; k < e.prescribed.sets; k++) apex.logSet(legsId, e.id, { kind: 'working', weight: 60 + k, reps: 8, rir: 0 });
    }
    apex.finishInstance(legsId);

    at(13, 8);
    apex.logBasketball({ durationMin: 60, rpe: 8, jumping: 3, sprinting: 3 });
    at(14, 8);
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3, changeOfDirection: 3 });
    await apex.flush();

    at(16, 18); // Friday
    const b = await restart();
    b.planSession('gym', 'legs');
    const fri = gym(b);
    expect(fri.decision.volumeFactor).toBeLessThan(0.9);
    expect(fri.decision.reasons[0]).toMatch(/Wed: basketball 90 min @ RPE 9/);
    expect(fri.decision.inputs!.recent.length).toBeGreaterThan(0);
    expect(b.getState().data.templates.find((x) => x.id === 'legs')!.exercises.map((e) => e.sets)).toEqual([3, 3, 3, 3, 2, 2, 3, 2]);

    b.planSession('gym', 'pull');
    expect(gym(b).decision.outcome).toBe('normal');
  });
});

describe('athlete control', () => {
  it('KEEP PLAN restores the template as written; ADAPT returns to the recommendation', async () => {
    const { apex } = setup(2026, 10, 7); // Wednesday = Legs
    await apex.init();
    apex.logBasketball({ durationMin: 60, rpe: 8 });
    const adapted = gym(apex);
    expect(adapted.decision.volumeFactor).toBeLessThan(1);
    const total = (w: WorkoutInstance) => w.exercises.reduce((n, e) => n + e.prescribed.sets, 0);
    expect(total(adapted)).toBeLessThan(21);

    apex.setPlanMode(adapted.id, 'kept');
    const kept = gym(apex);
    expect(kept.id).toBe(adapted.id);
    expect(kept.plan).toBe('kept');
    expect(total(kept)).toBe(21);
    expect(kept.decision.volumeFactor).toBeLessThan(1); // recommendation still on record

    apex.logBasketball({ durationMin: 30, rpe: 5, date: apex.today() }); // re-adaptation keeps the athlete's choice
    expect(gym(apex).plan).toBe('kept');
    expect(total(gym(apex))).toBe(21);

    apex.setPlanMode(adapted.id, 'adapted');
    expect(total(gym(apex))).toBeLessThan(21);
  });

  it('a recovery day sets the session aside without completing it or advancing the rotation', async () => {
    const { apex, at } = setup(2026, 10, 5); // Monday: Push rotation
    await apex.init();
    const w = gym(apex);
    expect(w.templateName).toBe('Push V1');
    apex.takeRecoveryDay(w.id);
    expect(gym(apex).status).toBe('skipped');
    apex.refreshToday();
    expect(gym(apex).status).toBe('skipped'); // not regenerated behind the athlete's back
    apex.undoRecoveryDay(w.id);
    expect(gym(apex).status).toBe('planned');
    apex.takeRecoveryDay(w.id);
    at(8); // Thursday: still Push V1, nothing was completed
    apex.refreshToday();
    expect(gym(apex).templateName).toBe('Push V1');
  });

  it('session RPE at finish is stored and raises plyometric load', async () => {
    const { apex } = setup(2026, 10, 5); // Monday: Vertical Power
    await apex.init();
    const p = plyo(apex);
    apex.logPlyo(p.id, p.exercises[0].id, { reps: 3, value: 55 });
    apex.finishInstance(p.id, { sessionRpe: 9 });
    expect(plyo(apex).sessionRpe).toBe(9);
    apex.finishInstance(p.id, { sessionRpe: 2 }); // idempotent: the stored session is final
    expect(plyo(apex).sessionRpe).toBe(9);
  });
});

describe('progress overview', () => {
  it('exposes regional load with trend, muscle volume vs targets and data-driven insights', async () => {
    const { apex } = setup(2026, 10, 7);
    await apex.init();
    const o = progressOverview(apex.getState().data, apex.today());
    expect(o.regions.map((r) => r.area)).toEqual(['lower', 'upper', 'trunk', 'jump']);
    expect(o.volume).toHaveLength(10);
    expect(o.insights).toEqual([]);
  });
});
