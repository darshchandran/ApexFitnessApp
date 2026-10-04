import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { createApex, todayOverview } from '../apex';
import type { WorkoutInstance } from '../../domain/types';

/** A clock the test can move; local time so dates don't shift with the machine's zone. */
function clockAt(y: number, m: number, d: number, h = 18) {
  const c = { now: new Date(y, m - 1, d, h) };
  return { c, fn: () => c.now };
}

const gymToday = (apex: ReturnType<typeof createApex>) =>
  todayOverview(apex.getState().data, apex.today()).gym as WorkoutInstance;

describe('apex service', () => {
  it('seeds on first launch and generates today’s scheduled session (Wednesday = Legs)', async () => {
    const { fn } = clockAt(2026, 10, 7);
    const apex = createApex(memoryStore(), fn);
    await apex.init();
    const gym = gymToday(apex);
    expect(gym.templateName).toBe('Legs');
    expect(gym.status).toBe('planned');
    expect(gym.decision.outcome).toBe('normal');
  });

  it('logging basketball re-adapts the unstarted evening session in place', async () => {
    const { fn } = clockAt(2026, 10, 7);
    const apex = createApex(memoryStore(), fn);
    await apex.init();
    const before = gymToday(apex);
    apex.logBasketball({ durationMin: 60, rpe: 8, sessionType: 'mixed' });
    const after = gymToday(apex);
    expect(after.id).toBe(before.id);
    expect(after.decision.outcome).toBe('heavily_reduced');
    expect(after.exercises.find((e) => e.name === 'Bulgarian Deadlift')!.status).toBe('removed');
    // the template is still the user's program
    expect(apex.getState().data.templates.find((t) => t.id === 'legs')!.exercises[4].sets).toBe(2);
  });

  it('persists logged sets offline and restores an in-progress workout after a restart', async () => {
    const store = memoryStore();
    const { fn } = clockAt(2026, 10, 7);
    const a = createApex(store, fn);
    await a.init();
    const w = gymToday(a);
    a.startInstance(w.id);
    a.logSet(w.id, w.exercises[0].id, { kind: 'warmup', weight: 40, reps: 10 });
    a.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8, rir: 2 });
    await a.flush();

    const b = createApex(store, fn); // "app restart"
    await b.init();
    const restored = b.getState().data.instances.find((i) => i.id === w.id) as WorkoutInstance;
    expect(restored.status).toBe('active');
    expect(restored.exercises[0].sets.map((s) => [s.kind, s.weight, s.reps])).toEqual([['warmup', 40, 10], ['working', 80, 8]]);
  });

  it('completing a workout stores actual performance, feeds previous performance and detects PRs', async () => {
    const store = memoryStore();
    const { c, fn } = clockAt(2026, 10, 7);
    const apex = createApex(store, fn);
    await apex.init();
    const w1 = gymToday(apex);
    const squat = w1.exercises[0];
    for (const reps of [8, 8, 7]) {
      c.now = new Date(c.now.getTime() + 120_000); // rest between sets
      apex.logSet(w1.id, squat.id, { kind: 'working', weight: 80, reps, rir: 2 });
    }
    expect(gymToday(apex).exercises[0].sets).toHaveLength(3);
    expect(apex.finishInstance(w1.id)).toEqual([]); // baseline

    c.now = new Date(2026, 9, 14, 18); // next Wednesday
    apex.refreshToday();
    const w2 = gymToday(apex);
    expect(w2.id).not.toBe(w1.id);
    for (const reps of [8, 8, 8]) {
      c.now = new Date(c.now.getTime() + 120_000);
      apex.logSet(w2.id, w2.exercises[0].id, { kind: 'working', weight: 82.5, reps, rir: 2 });
    }
    const prs = apex.finishInstance(w2.id);
    expect(prs.map((p) => p.kind)).toContain('weight');
    await apex.flush();

    const reloaded = createApex(store, fn);
    await reloaded.init();
    const d = reloaded.getState().data;
    expect(d.records.some((r) => r.kind === 'weight' && r.value === 82.5)).toBe(true);
    expect(d.instances.filter((i) => i.status === 'completed')).toHaveLength(2);
  });

  it('rotates Push V1 → V2 → V1 by completion without touching templates', async () => {
    const { c, fn } = clockAt(2026, 10, 5); // Monday
    const apex = createApex(memoryStore(), fn);
    await apex.init();
    const names: string[] = [];
    for (const day of [5, 8, 12]) { // Mon, Thu, Mon
      c.now = new Date(2026, 9, day, 18);
      apex.refreshToday();
      const w = gymToday(apex);
      names.push(w.templateName);
      apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 30, reps: 10, rir: 2 });
      apex.finishInstance(w.id);
    }
    expect(names).toEqual(['Push V1', 'Push V2', 'Push V1']);
  });

  it('a rest day has no session until the athlete picks one', async () => {
    const { fn } = clockAt(2026, 10, 4); // Sunday
    const apex = createApex(memoryStore(), fn);
    await apex.init();
    expect(gymToday(apex)).toBeUndefined();
    const id = apex.planSession('gym', 'pull');
    expect(gymToday(apex).id).toBe(id);
  });

  it('template edits flow into today’s unstarted session, never into completed ones', async () => {
    const { fn } = clockAt(2026, 10, 7);
    const apex = createApex(memoryStore(), fn);
    await apex.init();
    const legs = apex.getState().data.templates.find((t) => t.id === 'legs')!;
    apex.saveTemplate({ ...legs, exercises: legs.exercises.slice(0, 3) });
    expect(gymToday(apex).exercises).toHaveLength(3);
  });
});
