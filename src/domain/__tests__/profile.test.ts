import { describe, expect, it } from '@jest/globals';
import { adaptGym } from '../adaptation';
import {
  adaptationData, cleanItem, fromUnits, incrementKg, inferBasketballDays, inferGymTime, migrateAthleteContext, nextQuestion, profileFacts,
  questionState, scheduleNotes, stepIn, toUnits, weeklySchedule, type AthleteProfile, type ScheduleItem,
} from '../profile';
import { recommendProgression } from '../progression';
import { buildContext, contextFromSessions } from '../strain';
import type { ApexData, BasketballSession, SessionInstance } from '../types';
import { addDays } from '../util';
import { bball, completedGym, freshData, gymTemplate } from '../../test-utils';

const TODAY = '2026-10-07'; // Wednesday
const NOW = new Date(2026, 9, 7, 18);
const at = (p: Partial<ApexData>): ApexData => ({ ...freshData(), ...p });
const withProfile = (profile: AthleteProfile, p: Partial<ApexData> = {}) => at({ ...p, profile: { schedule: [], ...profile } });
const ask = (d: ApexData, s: Parameters<typeof nextQuestion>[1], now = NOW, instance?: SessionInstance, today = TODAY) => nextQuestion(d, s, now, { today, instance })?.key;
const practice = (date: string): BasketballSession => bball({ id: `bb-${date}`, date, durationMin: 60, rpe: 7 });
const item = (p: Partial<ScheduleItem> & Pick<ScheduleItem, 'day' | 'kind'>): ScheduleItem => ({ id: `i-${p.day}-${p.kind}-${p.time ?? ''}`, enabled: true, ...p });
const gymInst = (outcome: string) => ({ kind: 'gym', decision: { outcome } }) as SessionInstance;

describe('profile model', () => {
  it('a fresh install invents nothing: no basketball, an empty schedule, nothing known but the program', () => {
    const d = freshData();
    expect(d.profile).toEqual({ schedule: [] });
    expect(d.plan.days.some((x) => x.basketball)).toBe(false);
    expect(profileFacts(d)).toMatchObject({ goal: false, sport: false, units: false, basketballDays: false, gymDays: true, gymTime: false, bodyweight: false });
  });

  it('tracks individual facts, not a completion percentage', () => {
    const f = profileFacts(withProfile({ goal: 'both', heightCm: 188, targetBodyweightKg: 85 }));
    expect(f).toMatchObject({ goal: true, sport: false, units: false, height: true, targets: true, focus: false });
  });

  it('schedule items are validated; every detail is optional', () => {
    expect(cleanItem({ id: 'a', day: 1, kind: 'basketball' })).toEqual({ id: 'a', day: 1, kind: 'basketball', enabled: true });
    expect(cleanItem({ id: 'b', day: 1, kind: 'basketball', label: '  Practice  ', time: '07:00', durationMin: 90, intensity: 'hard', enabled: false }))
      .toEqual({ id: 'b', day: 1, kind: 'basketball', label: 'Practice', time: '07:00', durationMin: 90, intensity: 'hard', enabled: false });
    expect(cleanItem({ id: 'c', day: 7, kind: 'basketball' })).toBeUndefined();
    expect(cleanItem({ id: 'd', day: 1, kind: 'swim' as ScheduleItem['kind'] })).toBeUndefined();
    expect(cleanItem({ id: 'e', day: 1, kind: 'other', time: '25 o’clock', durationMin: 2 })).toEqual({ id: 'e', day: 1, kind: 'other', enabled: true });
  });
});

describe('migration', () => {
  it('older data — basketball on the plan, flat "other" days — becomes schedule items, once', () => {
    const base = freshData();
    const legacy = {
      ...base,
      plan: { ...base.plan, days: base.plan.days.map((x, i) => (i === 1 ? { ...x, basketball: '07:00' } : i === 2 ? { ...x, basketball: 'any' } : x)) },
      profile: { goal: 'both', otherDays: [6], basketballDaysConfirmedAt: NOW.toISOString() } as AthleteProfile,
    } as ApexData;
    const m = migrateAthleteContext(legacy)!;
    expect(m.profile.schedule!.map((x) => [x.day, x.kind, x.time])).toEqual([[1, 'basketball', '07:00'], [2, 'basketball', undefined], [6, 'other', undefined]]);
    expect(m.plan.days.some((x) => 'basketball' in x)).toBe(false);
    expect('otherDays' in m.profile).toBe(false);
    expect(m.profile).toMatchObject({ goal: 'both', basketballDaysConfirmedAt: NOW.toISOString() }); // nothing else lost
    expect(m.plan.days.map((x) => x.gym)).toEqual(base.plan.days.map((x) => x.gym)); // the program is untouched
    expect(migrateAthleteContext(m)).toBeUndefined();
  });

  it('data from before profiles existed gets an empty schedule', () => {
    const m = migrateAthleteContext({ ...freshData(), profile: {} })!;
    expect(m.profile.schedule).toEqual([]);
  });
});

describe('schedule', () => {
  it('a day holds several activities in the athlete’s order; program sessions come from the program', () => {
    const d = withProfile({ gymTime: 'evening', schedule: [
      item({ day: 1, kind: 'basketball', label: 'Practice', time: '07:00', durationMin: 90, intensity: 'hard' }),
      item({ day: 1, kind: 'gym', time: '18:30' }),
      item({ day: 1, kind: 'conditioning', enabled: false }),
    ] });
    const tue = weeklySchedule(d)[1];
    expect(tue.map((e) => [e.kind, e.source, e.enabled])).toEqual([['basketball', 'schedule', true], ['gym', 'program', true], ['conditioning', 'schedule', false]]);
    expect(tue[1]).toMatchObject({ templateId: 'pull', time: '18:30' }); // which session: the program; when: the schedule
    expect(tue[0]).toMatchObject({ label: 'Practice', durationMin: 90, intensity: 'hard' });
    const mon = weeklySchedule(d)[0];
    expect(mon.map((e) => e.kind)).toEqual(['gym', 'plyo']); // program only, usual gym time
    expect(mon[0]).toMatchObject({ rotationId: 'rot-push', time: 'evening' });
    expect(weeklySchedule(d)[6]).toEqual([]); // rest
  });
});

describe('contextual questions', () => {
  it('first launch asks only for the goal — once', () => {
    expect(ask(freshData(), 'launch')).toBe('goal');
    expect(ask(withProfile({ goal: 'muscle' }), 'launch')).toBeUndefined();
    expect(ask(withProfile({ prompts: { goal: { at: NOW.toISOString(), count: 1 } } }), 'launch')).toBeUndefined();
  });

  it('a new athlete with a goal is not asked anything else until it is useful', () => {
    const d = withProfile({ goal: 'performance' });
    for (const s of ['home', 'practice', 'complete'] as const) expect(ask(d, s)).toBeUndefined();
  });

  it('asks the main sport once the athlete has actually used the app; home asks once per half day', () => {
    const d = withProfile({ goal: 'performance', basketballNotUsual: [2] }, { basketball: [practice(TODAY)] });
    expect(ask(d, 'home')).toBe('sport');
    const cooled = withProfile({ ...d.profile, lastPromptAt: new Date(2026, 9, 7, 9).toISOString() }, d);
    expect(ask(cooled, 'home')).toBeUndefined();
    expect(ask(cooled, 'home', new Date(2026, 9, 7, 22))).toBe('sport');
  });

  it('NOT NOW backs off 1 → 3 → 7 days; SKIP is respected; states read unknown → asked → skipped → known', () => {
    const base = { goal: 'performance' as const, basketballDaysConfirmedAt: NOW.toISOString(), basketballNotUsual: [2] };
    const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
    const snoozed = (count: number, skipped?: boolean) => withProfile({ ...base, prompts: { sport: { at: NOW.toISOString(), count, skipped } } }, { basketball: [practice(TODAY)] });
    expect(questionState(withProfile(base, { basketball: [practice(TODAY)] }), 'sport')).toBe('unknown');
    expect(questionState(snoozed(1), 'sport')).toBe('asked');
    expect(ask(snoozed(1), 'home', later(23))).toBeUndefined();
    expect(ask(snoozed(1), 'home', later(25))).toBe('sport');
    expect(ask(snoozed(2), 'home', later(25))).toBeUndefined();
    expect(ask(snoozed(2), 'home', later(73))).toBe('sport');
    expect(questionState(snoozed(4), 'sport')).toBe('skipped');
    expect(ask(snoozed(4), 'home', later(24 * 60))).toBeUndefined();
    expect(questionState(snoozed(1, true), 'sport')).toBe('skipped');
    expect(ask(snoozed(1, true), 'home', later(24 * 60))).toBeUndefined();
    expect(questionState(withProfile({ ...base, sport: 'basketball' }), 'sport')).toBe('known');
  });

  it('a skipped question comes back only where a decision needs it, and only after a long quiet period', () => {
    const skipped = { at: NOW.toISOString(), count: 1, skipped: true };
    const d = withProfile({ goal: 'both', sport: 'basketball', units: 'kg', prompts: { basketballDays: skipped } }, { basketball: [practice(TODAY)] });
    expect(ask(d, 'session', NOW, gymInst('reduced'))).toBe('useBasketballLoad'); // the next useful thing
    const monthOn = { ...d, basketball: [practice(addDays(TODAY, 31))] };
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(ask(monthOn, 'home', later, undefined, addDays(TODAY, 31))).not.toBe('basketballDays');
    expect(ask(monthOn, 'session', later, gymInst('reduced'), addDays(TODAY, 31))).toBe('basketballDays');
  });

  it('known values are never asked again: confirmed days, units, bodyweight, gym time', () => {
    const d = withProfile({ goal: 'both', sport: 'basketball', units: 'kg', basketballDaysConfirmedAt: NOW.toISOString(), gymTime: 'evening', schedule: [item({ day: 2, kind: 'basketball' })] }, {
      basketball: [practice(TODAY)],
      bodyMetrics: [{ id: 'bm', date: TODAY, kind: 'bodyweight', value: 82 }],
      instances: ['2026-09-29', '2026-10-01', '2026-10-03'].map((x) => completedGym('pull', x, {}, `w-${x}`)),
    });
    expect(ask(d, 'home')).toBeUndefined();
    expect(ask(d, 'body')).toBeUndefined();
    expect(ask(d, 'session', NOW, gymInst('reduced'))).toBe('useBasketballLoad');
    expect(ask(withProfile({ ...d.profile, useBasketballLoad: true }, d), 'session', NOW, gymInst('reduced'))).toBeUndefined();
  });

  it('a session only asks about basketball when basketball actually shaped it; units come before the first weights', () => {
    const d = withProfile({ goal: 'both', sport: 'basketball' }, { basketball: [practice(addDays(TODAY, -10))] });
    expect(ask(d, 'session', NOW, gymInst('normal'))).toBe('units');
    const known = withProfile({ ...d.profile, units: 'kg' }, d);
    expect(ask(known, 'session', NOW, gymInst('reduced'))).toBeUndefined(); // practice too long ago
    const recent = { ...known, basketball: [practice(TODAY)] };
    expect(ask(recent, 'session', NOW, gymInst('normal'))).toBeUndefined();
    expect(ask(recent, 'session', NOW, gymInst('reduced'))).toBe('basketballDays');
  });

  it('“Do you usually play on Wednesdays?” after a practice on a day the week doesn’t have — never twice', () => {
    const d = withProfile({ goal: 'both', sport: 'basketball' }, { basketball: [practice(TODAY)] });
    expect(nextQuestion(d, 'practice', NOW, { today: TODAY })).toMatchObject({ key: 'basketballWeekday', day: 2 });
    expect(ask(withProfile({ ...d.profile, schedule: [item({ day: 2, kind: 'basketball' })] }, d), 'practice')).not.toBe('basketballWeekday');
    expect(ask(withProfile({ ...d.profile, basketballNotUsual: [2] }, d), 'practice')).not.toBe('basketballWeekday');
  });

  it('gym-after-basketball is asked after practice on a day with both', () => {
    const gymToday = completedGym('pull', TODAY, {});
    const p = { goal: 'both' as const, basketballNotUsual: [2] };
    expect(ask(withProfile(p, { basketball: [practice(TODAY)], instances: [gymToday] }), 'practice')).toBe('gymAfterBasketball');
    expect(ask(withProfile(p, { basketball: [practice(TODAY)] }), 'practice')).toBeUndefined();
  });

  it('“How hard was basketball today?” only once the planned practice is over and something is still to come', () => {
    const gymLater = { ...completedGym('legs', TODAY, {}), status: 'planned' as const };
    const d = withProfile({ goal: 'both', schedule: [item({ day: 2, kind: 'basketball', time: 'morning' })] }, { instances: [gymLater] });
    expect(ask(d, 'home', new Date(2026, 9, 7, 9))).toBeUndefined(); // still morning
    expect(ask(d, 'home', new Date(2026, 9, 7, 12))).toBe('basketballToday');
    expect(ask({ ...d, basketball: [practice(TODAY)] }, 'home', new Date(2026, 9, 7, 12))).not.toBe('basketballToday');
    const putOff = withProfile({ ...d.profile, prompts: { basketballToday: { at: new Date(2026, 9, 7, 12).toISOString(), count: 1 } } }, d);
    expect(ask(putOff, 'home', new Date(2026, 9, 7, 13))).not.toBe('basketballToday');
    const disabled = withProfile({ goal: 'both', schedule: [item({ day: 2, kind: 'basketball', time: 'morning', enabled: false })] }, { instances: [gymLater] });
    expect(ask(disabled, 'home', new Date(2026, 9, 7, 12))).toBeUndefined();
  });

  it('gym time and training focus are asked once there is enough training for them to matter', () => {
    const sessions = (n: number) => ['2026-09-22', '2026-09-26', '2026-09-30', '2026-10-03'].slice(0, n)
      .map((x, k) => ({ ...completedGym('pull', x, {}, `w-${x}`), startedAt: new Date(new Date(`${x}T00:00:00`).setHours([7, 12, 17, 21][k])).toISOString() }));
    expect(ask(withProfile({ goal: 'both', sport: 'none' }, { instances: sessions(2) }), 'home')).toBeUndefined();
    expect(ask(withProfile({ goal: 'both', sport: 'none' }, { instances: sessions(3) }), 'home')).toBe('gymTime');
    expect(ask(withProfile({ goal: 'both', sport: 'none', gymTime: 'varies' }, { instances: sessions(4) }), 'home')).toBeUndefined();
    expect(ask(withProfile({ goal: 'both' }, { instances: sessions(1) }), 'complete')).toBeUndefined();
    expect(ask(withProfile({ goal: 'both' }, { instances: sessions(2) }), 'complete')).toBe('focus');
    expect(ask(withProfile({ goal: 'both', focus: 'jump' }, { instances: sessions(2) }), 'complete')).toBeUndefined();
  });

  it('bodyweight is asked only where bodyweight tracking lives', () => {
    expect(ask(withProfile({ goal: 'muscle' }), 'body')).toBe('bodyweight');
    expect(ask(withProfile({ goal: 'muscle' }), 'home')).toBeUndefined();
  });
});

describe('learning from logged activity', () => {
  const tueToThu = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-30', '2026-10-01', '2026-09-26'];

  it('repeated practice days become a suggestion; one-offs do not; the suggestion changes nothing by itself', () => {
    const d = withProfile({ goal: 'both', sport: 'basketball' }, { basketball: tueToThu.map(practice) });
    expect(inferBasketballDays(d, TODAY)).toEqual([1, 2, 3]);
    expect(inferBasketballDays(withProfile({}, { basketball: tueToThu.slice(0, 3).map(practice) }), TODAY)).toBeUndefined();
    const before = JSON.stringify(d);
    expect(nextQuestion(d, 'home', NOW, { today: TODAY })).toMatchObject({ key: 'suggestBasketballDays', days: [1, 2, 3] });
    expect(JSON.stringify(d)).toBe(before);
  });

  it('once confirmed and matching, the suggestion goes away', () => {
    const d = withProfile({ goal: 'both', sport: 'basketball', basketballDaysConfirmedAt: NOW.toISOString(), schedule: [1, 2, 3].map((day) => item({ day, kind: 'basketball' })) }, { basketball: tueToThu.map(practice) });
    expect(ask(d, 'home')).not.toBe('suggestBasketballDays');
  });

  it('a consistent gym start time is suggested; a scattered one is not', () => {
    const session = (date: string, h: number): SessionInstance => ({ ...completedGym('pull', date, {}, `w-${date}`), startedAt: new Date(new Date(`${date}T00:00:00`).setHours(h, 5)).toISOString() });
    const steady = ['2026-09-22', '2026-09-25', '2026-09-29', '2026-10-02', '2026-10-06'].map((x) => session(x, 19));
    expect(inferGymTime(steady, TODAY)).toBe('19:00');
    expect(inferGymTime(['2026-09-22', '2026-09-25', '2026-09-29', '2026-10-02'].map((x, k) => session(x, [7, 12, 17, 21][k])), TODAY)).toBeUndefined();
    expect(nextQuestion(withProfile({ goal: 'muscle', sport: 'none' }, { instances: steady }), 'home', NOW, { today: TODAY })).toMatchObject({ key: 'suggestGymTime', time: '19:00' });
    expect(ask(withProfile({ goal: 'muscle', sport: 'none', gymTime: 'evening' }, { instances: steady }), 'home')).toBeUndefined();
  });
});

describe('schedule context for adaptation — never load', () => {
  it('a planned practice not logged yet is a note in the decision; the numbers don’t move', () => {
    const d = withProfile({ schedule: [item({ day: 2, kind: 'basketball', time: '07:00' })] });
    expect(scheduleNotes(d, TODAY)).toEqual(['Basketball planned this morning isn’t logged yet — log it and Apex adjusts this session.']);
    const ctx = buildContext(adaptationData(d), TODAY);
    expect(ctx.days[0].total).toBe(0);
    const legs = gymTemplate('legs');
    const withNote = adaptGym(legs, ctx);
    const without = adaptGym(legs, contextFromSessions({ date: TODAY }));
    expect(withNote.sets).toEqual(without.sets);
    expect(withNote.decision.volumeFactor).toBe(without.decision.volumeFactor);
    expect(withNote.decision.reasons.at(-1)).toMatch(/isn’t logged yet/);
    expect(withNote.decision.inputs!.context).toEqual(scheduleNotes(d, TODAY));
  });

  it('order matters: practice after the gym session is "later today"; logged or disabled practice needs no note', () => {
    const later = withProfile({ gymTime: 'morning', schedule: [item({ day: 2, kind: 'basketball', time: 'evening' })] });
    expect(scheduleNotes(later, TODAY)[0]).toMatch(/later today/);
    expect(scheduleNotes({ ...later, basketball: [practice(TODAY)] }, TODAY)).toEqual([]);
    expect(scheduleNotes(withProfile({ schedule: [item({ day: 2, kind: 'basketball', enabled: false })] }), TODAY)).toEqual([]);
  });

  it('logged practices count; opting out keeps them out of adaptation only', () => {
    const d = withProfile({}, { basketball: [bball({ durationMin: 90, rpe: 9 })] });
    expect(buildContext(adaptationData(d), TODAY).todayBasketball).toHaveLength(1);
    const out = { ...d, profile: { ...d.profile, useBasketballLoad: false } };
    expect(buildContext(adaptationData(out), TODAY).todayBasketball).toHaveLength(0);
    expect(out.basketball).toHaveLength(1);
  });
});

describe('units', () => {
  it('stores kg, shows lb, and progresses lb lifters in whole plates', () => {
    const kg = fromUnits(135, 'lb');
    expect(+toUnits(kg, 'lb').toFixed(1)).toBe(135);
    expect(stepIn(2.5, 'lb')).toBe(5);
    expect(stepIn(1.25, 'lb')).toBe(2.5);
    const rec = recommendProgression({
      repRange: [6, 10], increment: incrementKg(2.5, 'lb'),
      previous: [10, 10, 10].map((reps, i) => ({ id: `s${i}`, kind: 'working' as const, weight: kg, reps, rir: 2, completedAt: '' })),
    });
    expect(rec.action).toBe('increase');
    expect(+toUnits(rec.weight!, 'lb').toFixed(1)).toBe(140);
  });
});
