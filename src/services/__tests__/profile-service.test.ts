import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { dailyLoad } from '../../domain/load';
import { nextQuestion } from '../../domain/profile';
import { seedGymTemplates } from '../../domain/seed';
import type { WorkoutInstance } from '../../domain/types';
import { createApex, todayOverview } from '../apex';

// Wed 7 Oct 2026: Legs on the program
function setup(store = memoryStore(), d = 7, h = 18) {
  const c = { now: new Date(2026, 9, d, h) };
  const apex = createApex(store, () => c.now);
  const restart = async () => { const b = createApex(store, () => c.now); await b.init(); return b; };
  return { apex, c, store, restart, later: (hrs: number) => { c.now = new Date(c.now.getTime() + hrs * 3_600_000); } };
}
type A = ReturnType<typeof createApex>;
const gym = (a: A) => todayOverview(a.getState().data, a.today()).gym as WorkoutInstance;
const ask = (a: A, s: Parameters<typeof nextQuestion>[1], c: { now: Date }, instance?: WorkoutInstance) =>
  nextQuestion(a.getState().data, s, c.now, { today: a.today(), instance })?.key;
const schedule = (a: A) => a.getState().data.profile.schedule!;

describe('profile', () => {
  it('a fresh install runs with an empty profile, then with only a goal', async () => {
    const { apex } = setup();
    await apex.init();
    expect(apex.getState().data.profile).toEqual({ schedule: [] });
    apex.answerQuestion('goal', { goal: 'performance' });
    const w = gym(apex);
    expect(w.templateName).toBe('Legs');
    expect(apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 60, reps: 8 })).toBeDefined();
    apex.finishInstance(w.id);
    expect(gym(apex).status).toBe('completed');
  });

  it('create, update and persist every optional field across restarts', async () => {
    const { apex, restart } = setup();
    await apex.init();
    apex.updateProfile({ goal: 'muscle', sport: 'basketball', units: 'lb', experience: 'intermediate', focus: 'jump', gymTime: 'evening', heightCm: 190, targetBodyweightKg: 86, verticalTargetCm: 75, gymAfterBasketball: 'sometimes' });
    apex.updateProfile({ goal: 'both', heightCm: undefined });
    await apex.flush();
    const b = await restart();
    expect(b.getState().data.profile).toMatchObject({ goal: 'both', sport: 'basketball', units: 'lb', experience: 'intermediate', focus: 'jump', gymTime: 'evening', targetBodyweightKg: 86, verticalTargetCm: 75 });
    expect(b.getState().data.profile.heightCm).toBeUndefined();
  });

  it('migration: older stored data (basketball on the plan, flat "other" days) is converted once and saved', async () => {
    const store = memoryStore();
    const { apex, restart } = setup(store);
    await apex.init();
    await apex.flush();
    // write the old layout straight into storage
    const plan = JSON.parse((await store.getItem('apex:v1:plan'))!);
    plan.days[1].basketball = '07:00';
    plan.days[3].basketball = 'any';
    await store.setItem('apex:v1:plan', JSON.stringify(plan));
    await store.setItem('apex:v1:profile', JSON.stringify({ goal: 'both', otherDays: [6] }));
    const b = await restart();
    expect(schedule(b).map((i) => [i.day, i.kind, i.time])).toEqual([[1, 'basketball', '07:00'], [3, 'basketball', undefined], [6, 'other', undefined]]);
    expect(b.getState().data.plan.days.some((d) => 'basketball' in d)).toBe(false);
    await b.flush();
    const c = await restart();
    expect(schedule(c)).toHaveLength(3); // no duplicates on the next launch
    expect(JSON.parse((await store.getItem('apex:v1:plan'))!).days.some((d: object) => 'basketball' in d)).toBe(false);
  });

  it('a profile from before this phase (no profile key) still loads', async () => {
    const store = memoryStore();
    const { apex, restart } = setup(store);
    await apex.init();
    await apex.flush();
    await store.removeItem('apex:v1:profile');
    const b = await restart();
    expect(b.getState().data.profile).toEqual({ schedule: [] });
  });

  it('a damaged profile is reset on its own without losing training data', async () => {
    const store = memoryStore();
    const { apex, restart } = setup(store);
    await apex.init();
    apex.logBasketball({ durationMin: 60, rpe: 7 });
    await apex.flush();
    await store.setItem('apex:v1:profile', '{not json');
    const b = await restart();
    expect(b.getState().recovered).toContain('profile');
    expect(b.getState().data.profile.schedule).toEqual([]);
    expect(b.getState().data.basketball).toHaveLength(1);
  });
});

describe('schedule', () => {
  it('several activities a day, optional times and durations, an incomplete week — all persisted', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const bb = apex.addScheduleItem({ day: 1, kind: 'basketball', label: 'Practice', time: '07:00', durationMin: 90, intensity: 'hard' })!;
    const g = apex.addScheduleItem({ day: 1, kind: 'gym', time: '18:30' })!;
    const c = apex.addScheduleItem({ day: 1, kind: 'conditioning' })!; // no time, no duration
    expect(apex.addScheduleItem({ day: 9, kind: 'basketball' })).toBeUndefined();
    await apex.flush();
    const b = await restart();
    expect(schedule(b).map((i) => i.id)).toEqual([bb, g, c]);
    expect(schedule(b)[0]).toMatchObject({ label: 'Practice', time: '07:00', durationMin: 90, intensity: 'hard', enabled: true });
    expect(schedule(b)[2].time).toBeUndefined();
    expect(b.getState().data.profile.basketballDaysConfirmedAt).toBeDefined(); // the athlete gave their practice day
  });

  it('edit, disable, reorder and remove', async () => {
    const { apex, restart } = setup();
    await apex.init();
    const a = apex.addScheduleItem({ day: 2, kind: 'basketball', time: 'morning' })!;
    const g = apex.addScheduleItem({ day: 2, kind: 'gym', time: 'evening' })!;
    apex.updateScheduleItem(a, { durationMin: 75, label: 'Team practice' });
    apex.updateScheduleItem(a, { time: undefined }); // clear a detail
    apex.updateScheduleItem(g, { enabled: false });
    apex.moveScheduleItem(g, -1);
    await apex.flush();
    const b = await restart();
    expect(schedule(b).map((i) => [i.kind, i.enabled])).toEqual([['gym', false], ['basketball', true]]);
    expect(schedule(b)[1]).toMatchObject({ durationMin: 75, label: 'Team practice' });
    expect(schedule(b)[1].time).toBeUndefined();
    b.removeScheduleItem(g);
    expect(schedule(b).map((i) => i.id)).toEqual([a]);
  });

  it('“usual days” answers keep existing details and don’t duplicate items', async () => {
    const { apex } = setup();
    await apex.init();
    apex.addScheduleItem({ day: 1, kind: 'basketball', time: '07:00' });
    apex.setBasketballDays([1, 2, 3]);
    apex.setBasketballDays([1, 3]);
    expect(schedule(apex).filter((i) => i.kind === 'basketball').map((i) => [i.day, i.time])).toEqual([[1, '07:00'], [3, undefined]]);
    apex.answerBasketballWeekday(5, true);
    apex.answerBasketballWeekday(5, true);
    apex.answerBasketballWeekday(6, false);
    expect(schedule(apex).filter((i) => i.day === 5)).toHaveLength(1);
    expect(apex.getState().data.profile.basketballNotUsual).toEqual([6]);
  });
});

describe('questions through the app', () => {
  it('shown when missing, NOT NOW keeps the app usable and it returns later, SKIP is respected, answering ends it', async () => {
    const { apex, c, later } = setup();
    await apex.init();
    apex.answerQuestion('goal', { goal: 'both' });
    apex.answerQuestion('sport', { sport: 'basketball' });
    apex.answerQuestion('units', { units: 'kg' });
    apex.logBasketball({ durationMin: 90, rpe: 9 });
    expect(ask(apex, 'session', c, gym(apex))).toBe('basketballDays');
    apex.deferQuestion('basketballDays');
    expect(ask(apex, 'session', c, gym(apex))).toBe('useBasketballLoad');
    const w = gym(apex);
    expect(apex.logSet(w.id, w.exercises[0].id, { kind: 'working', weight: 60, reps: 8 })).toBeDefined(); // still usable
    apex.deferQuestion('useBasketballLoad', true); // SKIP
    later(25);
    expect(ask(apex, 'home', c)).toBe('basketballDays'); // put-off question returns later, once
    apex.setBasketballDays([1, 2, 3]);
    later(25);
    expect(ask(apex, 'home', c)).toBeUndefined(); // answered: never again
    expect(apex.getState().data.profile.prompts?.useBasketballLoad?.skipped).toBe(true);
  });

  it('a practice on an unscheduled day asks about that day after logging; No is remembered', async () => {
    const { apex, c } = setup();
    await apex.init();
    apex.answerQuestion('sport', { sport: 'basketball' });
    apex.logBasketball({ durationMin: 60, rpe: 7 });
    expect(nextQuestion(apex.getState().data, 'practice', c.now, { today: apex.today() })).toMatchObject({ key: 'basketballWeekday', day: 2 });
    apex.answerBasketballWeekday(2, false);
    expect(ask(apex, 'practice', c)).not.toBe('basketballWeekday');
  });
});

describe('actual training is authoritative', () => {
  it('the schedule creates no history and no load; logged sessions do', async () => {
    const { apex, c } = setup();
    await apex.init();
    apex.addScheduleItem({ day: 1, kind: 'basketball', time: '07:00', durationMin: 90, intensity: 'hard' }); // Tuesdays
    c.now = new Date(2026, 9, 13, 18); // the following Tuesday: nothing logged
    apex.refreshToday();
    const d = apex.getState().data;
    expect(dailyLoad(d, '2026-10-13').basketball).toBe(0);
    expect(d.basketball).toHaveLength(0);
    expect(d.instances.every((i) => i.status !== 'completed')).toBe(true);
    // actually played Wednesday instead: Wednesday carries the load, Tuesday still none
    c.now = new Date(2026, 9, 14, 18);
    apex.logBasketball({ durationMin: 90, rpe: 8 });
    expect(dailyLoad(apex.getState().data, '2026-10-14').basketball).toBeGreaterThan(0);
    expect(dailyLoad(apex.getState().data, '2026-10-13').basketball).toBe(0);
  });

  it('planned Legs, actually trained Upper: history and load follow what was done', async () => {
    const { apex } = setup();
    await apex.init();
    expect(gym(apex).templateName).toBe('Legs');
    const id = apex.planSession('gym', 'upper')!;
    const w = apex.getState().data.instances.find((i) => i.id === id) as WorkoutInstance;
    apex.logSet(id, w.exercises[0].id, { kind: 'working', weight: 30, reps: 10 });
    apex.finishInstance(id);
    const done = apex.getState().data.instances.filter((i) => i.status === 'completed');
    expect(done.map((i) => i.templateName)).toEqual(['Upper']);
    expect(dailyLoad(apex.getState().data, apex.today()).gym).toBeGreaterThan(0);
  });

  it('adaptation receives schedule context without counting it; logging the practice is what adapts', async () => {
    const { apex } = setup(memoryStore(), 7, 12);
    await apex.init();
    apex.addScheduleItem({ day: 2, kind: 'basketball', time: 'morning' }); // Wednesday practice
    const planned = gym(apex);
    expect(planned.decision.outcome).toBe('normal');
    expect(planned.decision.volumeFactor).toBe(1);
    expect(planned.decision.inputs?.context?.[0]).toMatch(/isn’t logged yet/);
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3 });
    const adapted = gym(apex);
    expect(adapted.decision.volumeFactor).toBeLessThan(1);
    expect(adapted.decision.inputs?.context).toBeUndefined(); // logged: no note needed
  });

  it('opting out of basketball in adaptation changes adaptation only; logged load stays', async () => {
    const { apex } = setup();
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3 });
    expect(gym(apex).decision.volumeFactor).toBeLessThan(1);
    apex.updateProfile({ useBasketballLoad: false });
    expect(gym(apex).decision.outcome).toBe('normal');
    expect(dailyLoad(apex.getState().data, apex.today()).basketball).toBeGreaterThan(0);
    apex.updateProfile({ useBasketballLoad: true });
    expect(gym(apex).decision.volumeFactor).toBeLessThan(1);
  });

  it('a started session keeps its decision when context changes', async () => {
    const { apex } = setup();
    await apex.init();
    apex.logBasketball({ durationMin: 90, rpe: 9, jumping: 3 });
    const w = gym(apex);
    apex.startInstance(w.id);
    const decision = gym(apex).decision;
    apex.updateProfile({ useBasketballLoad: false });
    apex.addScheduleItem({ day: 2, kind: 'basketball', time: 'evening' });
    expect(gym(apex).decision).toEqual(decision);
  });

  it('the push rotation and the templates are untouched by profile and schedule edits', async () => {
    const c = { now: new Date(2026, 9, 5, 18) }; // Monday: Push rotation
    const apex = createApex(memoryStore(), () => c.now);
    await apex.init();
    const tpl = JSON.stringify(apex.getState().data.templates);
    apex.updateProfile({ goal: 'muscle', focus: 'size', gymTime: 'evening' });
    apex.setBasketballDays([0, 1]);
    apex.addScheduleItem({ day: 0, kind: 'gym', time: '18:00' });
    apex.addScheduleItem({ day: 0, kind: 'other', label: 'Swim' });
    expect(gym(apex)).toMatchObject({ templateName: 'Push V1', rotationId: 'rot-push' });
    expect(JSON.stringify(apex.getState().data.templates)).toBe(tpl);
    expect(apex.getState().data.templates).toEqual(seedGymTemplates(apex.getState().data.templates[0].createdAt));
  });
});
