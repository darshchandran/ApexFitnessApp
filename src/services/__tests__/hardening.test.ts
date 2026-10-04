import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { createApex, todayOverview, DOUBLE_TAP_MS } from '../apex';
import type { PlyometricInstance, WorkoutInstance } from '../../domain/types';
import { plyoLoad, templateContacts } from '../../domain/load';
import { seedGymTemplates, seedPlyoTemplates } from '../../domain/seed';
import { deepFreeze } from '../../test-utils';

function setup(y: number, m: number, d: number, store = memoryStore()) {
  const c = { now: new Date(y, m - 1, d, 18) };
  const tick = (msec = 120_000) => { c.now = new Date(c.now.getTime() + msec); };
  const apex = createApex(store, () => c.now);
  return { apex, store, c, tick, restart: async () => { const b = createApex(store, () => c.now); await b.init(); return b; } };
}
const gym = (apex: ReturnType<typeof createApex>) => todayOverview(apex.getState().data, apex.today()).gym as WorkoutInstance;
const plyo = (apex: ReturnType<typeof createApex>) => todayOverview(apex.getState().data, apex.today()).plyo as PlyometricInstance;
const WED = [2026, 10, 7] as const; // Legs + basketball
const MON = [2026, 10, 5] as const; // Push rotation + Vertical Power

describe('double submission', () => {
  it('rapid LOG SET taps store one set; a real next set is stored', async () => {
    const { apex, tick } = setup(...WED);
    await apex.init();
    const w = gym(apex);
    const ex = w.exercises[0].id;
    const a = apex.logSet(w.id, ex, { kind: 'working', weight: 80, reps: 8, rir: 2 });
    const b = apex.logSet(w.id, ex, { kind: 'working', weight: 80, reps: 8, rir: 2 });
    tick(DOUBLE_TAP_MS - 1);
    const c = apex.logSet(w.id, ex, { kind: 'working', weight: 80, reps: 8, rir: 2 });
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(gym(apex).exercises[0].sets).toHaveLength(1);
    tick(90_000);
    apex.logSet(w.id, ex, { kind: 'working', weight: 80, reps: 8, rir: 2 });
    expect(gym(apex).exercises[0].sets).toHaveLength(2);
  });

  it('rejects invalid numbers', async () => {
    const { apex } = setup(...WED);
    await apex.init();
    const w = gym(apex);
    const ex = w.exercises[0].id;
    for (const bad of [{ weight: 80, reps: 0 }, { weight: -5, reps: 8 }, { weight: NaN, reps: 8 }, { weight: 80, reps: Infinity }]) {
      expect(apex.logSet(w.id, ex, { kind: 'working', ...bad })).toBeUndefined();
    }
    expect(gym(apex).exercises[0].sets).toHaveLength(0);
    expect(gym(apex).status).toBe('planned'); // a rejected set doesn't start the session
  });

  it('finishing twice saves once and creates no duplicate records', async () => {
    const { apex, c, tick } = setup(...WED);
    await apex.init();
    const w1 = gym(apex);
    apex.logSet(w1.id, w1.exercises[0].id, { kind: 'working', weight: 80, reps: 8 });
    apex.finishInstance(w1.id);
    c.now = new Date(2026, 9, 14, 18);
    apex.refreshToday();
    const w2 = gym(apex);
    apex.logSet(w2.id, w2.exercises[0].id, { kind: 'working', weight: 85, reps: 8 });
    const first = apex.finishInstance(w2.id);
    const completedAt = gym(apex).completedAt;
    tick(500);
    const second = apex.finishInstance(w2.id);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(apex.getState().data.records).toHaveLength(first.length);
    expect(gym(apex).completedAt).toBe(completedAt);
  });

  it('save practice, add exercise and plan session are idempotent under rapid taps', async () => {
    const { apex } = setup(...WED);
    await apex.init();
    apex.logBasketball({ durationMin: 60, rpe: 8 });
    apex.logBasketball({ durationMin: 60, rpe: 8 });
    expect(apex.getState().data.basketball).toHaveLength(1);
    const w = gym(apex);
    apex.addExerciseToInstance(w.id, 'hip-thrust');
    apex.addExerciseToInstance(w.id, 'hip-thrust');
    expect(gym(apex).exercises.filter((e) => e.exerciseId === 'hip-thrust')).toHaveLength(1);
    const a = apex.planSession('plyometric', 'deload');
    const b = apex.planSession('plyometric', 'deload');
    expect(b).toBe(a);
  });
});

describe('completed sessions are read-only', () => {
  it('ignores logging, deleting, timers and discard on history', async () => {
    const { apex, tick } = setup(...WED);
    await apex.init();
    const w = gym(apex);
    const set = apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8 })!;
    apex.finishInstance(w.id);
    const before = JSON.stringify(gym(apex));
    tick();
    expect(apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 90, reps: 8 })).toBeUndefined();
    apex.deleteSet(w.id, w.exercises[0].id, set.id);
    apex.setRest(w.id, { endsAt: 1, total: 90 });
    apex.setExerciseSkipped(w.id, w.exercises[1].id, true);
    apex.discardInstance(w.id);
    expect(JSON.stringify(gym(apex))).toBe(before);
  });
});

describe('state persistence', () => {
  it('an interrupted workout survives a restart: sets, notes, rest timer, adaptation', async () => {
    const { apex, restart, tick } = setup(...WED);
    await apex.init();
    apex.logBasketball({ durationMin: 60, rpe: 8 });
    const w = gym(apex);
    apex.startInstance(w.id);
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8, rir: 2 });
    tick();
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 7, rir: 1 });
    apex.setExerciseNotes(w.id, w.exercises[0].id, 'seat 4');
    apex.setRest(w.id, { endsAt: 1_900_000_000_000, total: 180 });
    await apex.flush();

    const b = await restart();
    const r = b.getState().data.instances.find((i) => i.id === w.id) as WorkoutInstance;
    expect(r.status).toBe('active');
    expect(r.exercises[0].sets.map((s) => `${s.weight}x${s.reps}`)).toEqual(['80x8', '80x7']);
    expect(r.exercises[0].notes).toBe('seat 4');
    expect(r.rest).toEqual({ endsAt: 1_900_000_000_000, total: 180 });
    expect(r.decision.outcome).toBe('heavily_reduced');
    expect(r.exercises.find((e) => e.name === 'Bulgarian Deadlift')!.status).toBe('removed');
  });

  it('rotation persists across restarts and only advances on completion', async () => {
    const { apex, c, restart } = setup(...MON);
    await apex.init();
    expect(gym(apex).templateName).toBe('Push V1');
    apex.refreshToday(); // regenerating must not advance anything
    expect(gym(apex).templateName).toBe('Push V1');
    const w = gym(apex);
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 30, reps: 10 });
    apex.finishInstance(w.id);
    await apex.flush();

    c.now = new Date(2026, 9, 8, 18); // Thu
    const b = await restart();
    expect(gym(b).templateName).toBe('Push V2');
    b.startInstance(gym(b).id); // started but abandoned: still not completed
    await b.flush();
    c.now = new Date(2026, 9, 12, 18); // next Mon
    const cApp = await restart();
    expect(gym(cApp).templateName).toBe('Push V2');
  });

  it('writes only the changed session when a set is logged', async () => {
    const store = memoryStore();
    const keys: string[] = [];
    const spy = { ...store, setItem: async (k: string, v: string) => { keys.push(k); await store.setItem(k, v); } };
    const { apex } = setup(...WED, spy);
    await apex.init();
    await apex.flush();
    keys.length = 0;
    const w = gym(apex);
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8 });
    await apex.flush();
    expect(keys).toEqual([`apex:v1:instance:${w.id}`]);
  });

  it('migrates the phase-1 single-document layout', async () => {
    const { apex: a, store } = setup(...WED);
    await a.init();
    const w = gym(a);
    a.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8 });
    await a.flush();
    const dump = store.dump();
    const legacy = memoryStore(Object.fromEntries(Object.entries(dump).filter(([k]) => !k.includes('instance'))));
    await legacy.setItem('apex:v1:instances', JSON.stringify(a.getState().data.instances));

    const { apex: b } = setup(...WED, legacy);
    await b.init();
    await b.flush();
    expect(gym(b).exercises[0].sets).toHaveLength(1);
    expect(legacy.dump()['apex:v1:instances']).toBeUndefined();
    expect(legacy.dump()[`apex:v1:instance:${w.id}`]).toBeDefined();
  });
});

describe('error handling', () => {
  it('recovers from malformed saved data without crashing and keeps a backup', async () => {
    const { apex: a, store } = setup(...WED);
    await a.init();
    await a.flush();
    await store.setItem('apex:v1:templates', '{not json');
    await store.setItem('apex:v1:basketball', JSON.stringify([{ id: 'ok', durationMin: 60, rpe: 7, date: '2026-10-07' }, 'junk', null]));
    const idx = JSON.parse(store.dump()['apex:v1:instance-index']);
    await store.setItem(`apex:v1:instance:${idx[0]}`, '{"broken":');

    const { apex: b } = setup(...WED, store);
    await b.init();
    const s = b.getState();
    expect(s.recovered).toContain('templates');
    expect(s.data.templates.map((t) => t.name)).toContain('Legs'); // program restored
    expect(s.data.basketball.map((x) => x.id)).toEqual(['ok']); // bad rows dropped, good kept
    expect(Object.keys(store.dump()).some((k) => k.startsWith('apex:v1:corrupt:templates'))).toBe(true);
    expect(gym(b).templateName).toBe('Legs'); // today's session regenerated
  });

  it('surfaces a failed save, keeps data in memory, and recovers on the next write', async () => {
    const { apex, store, tick, restart } = setup(...WED);
    await apex.init();
    await apex.flush();
    const w = gym(apex);
    store.failWrites = true;
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8 });
    await apex.flush();
    expect(apex.getState().saveError).toBe(true);
    expect(gym(apex).exercises[0].sets).toHaveLength(1);

    store.failWrites = false;
    tick();
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 7 });
    await apex.flush();
    expect(apex.getState().saveError).toBe(false);
    const b = await restart();
    expect(gym(b).exercises[0].sets.map((s) => s.reps)).toEqual([8, 7]);
  });

  it('launches on defaults when storage itself is unavailable', async () => {
    const broken = { getItem: async () => { throw new Error('denied'); }, setItem: async () => { throw new Error('denied'); }, removeItem: async () => undefined };
    const apex = createApex(broken, () => new Date(2026, 9, 7, 18));
    await apex.init();
    await apex.flush();
    const s = apex.getState();
    expect(s.ready).toBe(true);
    expect(s.saveError).toBe(true);
    expect(gym(apex).templateName).toBe('Legs');
  });

  it('tolerates sessions that reference an exercise this build does not know', async () => {
    const { apex, restart } = setup(...WED);
    await apex.init();
    const w = gym(apex);
    apex.substituteExercise(w.id, w.exercises[0].id, 'retired-machine');
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 50, reps: 10 });
    apex.finishInstance(w.id);
    await apex.flush();
    const b = await restart();
    expect(() => todayOverview(b.getState().data, b.today())).not.toThrow();
    expect(gym(b).exercises[0].name).toBe('Unknown exercise');
  });
});

describe('templates are never mutated', () => {
  it('generate → adapt → start → log → substitute → add exercise leaves every template identical', async () => {
    const { apex, tick } = setup(...WED);
    await apex.init();
    const before = JSON.stringify(apex.getState().data.templates);
    deepFreeze(apex.getState().data.templates); // any in-place write would throw
    apex.logBasketball({ durationMin: 75, rpe: 9, jumping: 3 });
    const w = gym(apex);
    apex.startInstance(w.id);
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 80, reps: 8 });
    tick();
    apex.addPrescribedSet(w.id, w.exercises[0].id);
    apex.substituteExercise(w.id, w.exercises[1].id, 'hack-squat');
    apex.addExerciseToInstance(w.id, 'hip-thrust');
    apex.setExerciseSkipped(w.id, w.exercises[2].id, true);
    apex.finishInstance(w.id);
    expect(JSON.stringify(apex.getState().data.templates)).toBe(before);
    expect(apex.getState().data.templates).toEqual(seedGymTemplates(apex.getState().data.templates[0].createdAt));
  });
});

describe('plyometrics end to end', () => {
  it('46-contact template adapts to 35–40, template unchanged, completion stores actual contacts', async () => {
    const { apex, tick } = setup(...MON);
    await apex.init();
    expect(plyo(apex).templateName).toBe('Vertical Power');
    apex.logBasketball({ durationMin: 60, rpe: 8 }); // mixed → moderate jumping
    const p = plyo(apex);
    const tpl = apex.getState().data.plyoTemplates.find((t) => t.id === 'vertical-power')!;
    expect(templateContacts(tpl)).toBe(46);
    const contacts = p.exercises.reduce((n, e) => n + e.prescribed.sets * e.prescribed.reps * (e.prescribed.perSide ? 2 : 1), 0);
    expect(contacts).toBeGreaterThanOrEqual(35);
    expect(contacts).toBeLessThanOrEqual(40);
    expect(p.decision.outcome).toBe('reduced');
    expect(p.decision.plannedVolume).toBe(46);
    expect(p.decision.prescribedVolume).toBe(contacts);

    apex.logPlyo(p.id, p.exercises[0].id, { reps: 3, value: 61 });
    tick();
    apex.logPlyo(p.id, p.exercises[0].id, { reps: 3, value: 63 });
    apex.finishInstance(p.id);
    const done = plyo(apex);
    expect(done.exercises[0].logs.map((l) => l.value)).toEqual([61, 63]);
    expect(apex.getState().data.plyoTemplates.find((t) => t.id === 'vertical-power')).toEqual(seedPlyoTemplates(tpl.createdAt)[1]);
  });

  it('per-side work: both sides count double, a single side counts once and as half a set', async () => {
    const { apex, tick } = setup(...WED);
    await apex.init();
    apex.planSession('plyometric', 'deload'); // lateral bound 2 × 3/side
    const p = plyo(apex);
    const lb = p.exercises[2];
    expect(lb.prescribed.perSide).toBe(true);
    apex.logPlyo(p.id, lb.id, { reps: 3, value: 240 }); // both sides
    tick();
    apex.logPlyo(p.id, lb.id, { reps: 3, value: 235, side: 'L' });
    tick();
    apex.logPlyo(p.id, lb.id, { reps: 3, value: 228, side: 'R' });
    expect(plyo(apex).exercises[2].status).toBe('done'); // 1 + ½ + ½ = 2 sets
    apex.finishInstance(p.id);
    expect(plyoLoad(plyo(apex)).contacts).toBe(6 + 3 + 3);
    expect(plyo(apex).exercises[2].logs.map((l) => l.side ?? 'both')).toEqual(['both', 'L', 'R']);
  });
});

describe('home reflects the day as it unfolds', () => {
  it('planned → light practice (unchanged) → hard practice (adapted) → completed', async () => {
    const { apex, tick } = setup(...WED);
    await apex.init();
    expect(gym(apex).decision.outcome).toBe('normal');

    apex.logBasketball({ durationMin: 45, rpe: 4, sessionType: 'shooting' });
    expect(gym(apex).decision.outcome).toBe('normal');
    tick(60_000);
    apex.logBasketball({ durationMin: 75, rpe: 8, sessionType: 'scrimmage' });
    const o = todayOverview(apex.getState().data, apex.today());
    expect(o.basketball.sessions).toHaveLength(2);
    expect(['heavily_reduced', 'alternative']).toContain(o.gym!.decision.outcome);
    expect(o.gym!.decision.volumeFactor).toBeLessThan(0.75);

    const w = gym(apex);
    apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 70, reps: 8 });
    apex.finishInstance(w.id);
    const after = todayOverview(apex.getState().data, apex.today());
    expect(after.gym!.status).toBe('completed');
    expect(after.load.gym).toBeGreaterThan(0);
  });

  it('the same hard practice leaves Pull untouched and steers plyos to the primer', async () => {
    const { apex } = setup(2026, 10, 6); // Tue = Pull
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 8, jumping: 3 });
    expect(gym(apex).templateName).toBe('Pull');
    expect(gym(apex).decision.outcome).toBe('normal');
    apex.planSession('plyometric', 'vertical-power');
    expect(plyo(apex).decision.outcome).toBe('alternative');
    expect(plyo(apex).decision.alternativeTemplateId).toBe('low-fatigue-primer');
    apex.useAlternative(plyo(apex).id);
    expect(plyo(apex).templateName).toBe('Low-Fatigue Primer');
  });
});
