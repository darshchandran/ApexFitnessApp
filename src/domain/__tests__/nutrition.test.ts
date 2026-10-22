import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { createApex } from '../../services/apex';
import { amountText, FOODS, foodById, gramsOf, macrosOf, MEALS, searchFoods } from '../foods';
import { dayPlan, dayType, mifflin, nutritionTargets, roundQty, STARTING_PROFILE, totalsOf, trainingAverage, weightTrend, type FoodEntry } from '../nutrition';
import type { ApexData } from '../types';
import { addDays, weekdayIndex } from '../util';

// Wed 7 Oct 2026: Legs on the program
const NOW = new Date(2026, 9, 7, 9);
const TODAY = '2026-10-07';

async function athlete(edit?: (a: ReturnType<typeof createApex>) => void) {
  const a = createApex(memoryStore(), () => NOW);
  await a.init();
  a.saveNutrition({ profile: { age: 20, ageAsOf: TODAY, lifestyle: 'moderate', diet: 'non-vegetarian', avoid: ['beef'], budget: 'moderate' }, heightCm: 178, targetKg: 75, weightKg: 68 });
  edit?.(a);
  return a;
}
const data = (a: ReturnType<typeof createApex>) => a.getState().data;
const targetsOf = (d: ApexData, date = TODAY) => {
  const t = nutritionTargets(d, date);
  if (!t.ok) throw new Error(`missing ${t.missing}`);
  return t.targets;
};

describe('the food table', () => {
  it('never contains beef, and every value is a plausible estimate (kcal ≈ 4·P + 4·C + 9·F)', () => {
    for (const f of FOODS) {
      expect(JSON.stringify(f).toLowerCase()).not.toMatch(/beef/);
      const est = 4 * f.per100.protein + 4 * f.per100.carbs + 9 * f.per100.fat;
      expect(Math.abs(est - f.per100.kcal)).toBeLessThanOrEqual(Math.max(15, f.per100.kcal * 0.12));
      expect(f.units.length).toBeGreaterThan(0);
      expect(f.units.every((u) => u.grams > 0)).toBe(true);
      expect(['reference', 'recipe']).toContain(f.source);
    }
    // meal suggestions use only foods in the table, never a supplement
    for (const t of MEALS) for (const [id, q] of t.items) expect([foodById(id), q > 0]).toEqual([expect.anything(), true]);
    expect(JSON.stringify(FOODS).toLowerCase()).not.toMatch(/whey|protein powder|supplement/);
  });

  it('finds foods by Hindi names and plurals; serving sizes convert to grams', () => {
    expect(searchFoods('dahi')[0].id).toBe('curd');
    expect(searchFoods('anda')[0].id).toBe('egg');
    expect(searchFoods('chapati')[0].id).toBe('roti');
    expect(searchFoods('chicken').map((x) => x.id)).toEqual(expect.arrayContaining(['chicken-breast', 'chicken-curry']));
    const egg = foodById('egg')!;
    expect(gramsOf(egg, 2)).toBe(100);
    expect(macrosOf(egg, 100)).toEqual({ kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 });
    const dal = foodById('dal')!;
    expect(gramsOf(dal, 1, 'katori')).toBe(150);
    expect(macrosOf(dal, 150).kcal).toBe(165);
    expect(gramsOf(dal, 80, 'g')).toBe(80);
    expect(gramsOf(dal, 1, 'cup')).toBeUndefined();
    expect([amountText(2, 'egg'), amountText(1, 'katori'), amountText(150, 'g')]).toEqual(['2 eggs', '1 katori', '150 g']);
  });
});

describe('calorie and macro targets', () => {
  it('the starting profile: a labelled estimate while sex isn’t set — maintenance, a modest surplus, macros', async () => {
    const t = targetsOf(data(await athlete()));
    const female = mifflin(68, 178, 20, 'female');
    const male = mifflin(68, 178, 20, 'male');
    expect(t.bmrRange).toEqual([Math.round(female), Math.round(male)]);
    expect(t.bmr).toBe(Math.round((female + male) / 2));
    expect(t.maintenance).toBe(Math.round(t.bmr * 1.4)); // no training logged yet
    expect(t.surplus).toBe(250); // ~10%, within 200–400
    expect(t.kcal).toBe(Math.round((t.maintenance + t.surplus) / 10) * 10);
    expect(t.protein).toBe(120); // 1.8 g/kg × 68 kg, to 5 g
    expect(t.fat).toBe(70); // ~25% of calories
    expect(t.carbs * 4 + t.protein * 4 + t.fat * 9).toBeLessThanOrEqual(t.kcal + 20);
    expect(t.notes.join(' ')).toMatch(/estimates[\s\S]*Sex isn’t set[\s\S]*No training logged/);
    expect(STARTING_PROFILE).toMatchObject({ age: 20, heightCm: 178, weightKg: 68, targetKg: 75, avoid: ['beef'] });
  });

  it('with sex set it uses that equation; nothing is calculated without age, height or a weight', async () => {
    const a = await athlete();
    a.saveNutrition({ profile: { ...data(a).nutrition.profile, sex: 'male' } });
    expect(targetsOf(data(a))).toMatchObject({ bmr: Math.round(mifflin(68, 178, 20, 'male')), bmrRange: null });
    const fresh = createApex(memoryStore(), () => NOW);
    await fresh.init();
    expect(nutritionTargets(data(fresh), TODAY)).toEqual({ ok: false, missing: ['age', 'height', 'weight'] });
    fresh.saveNutrition({ profile: { age: 20 }, heightCm: 178 });
    expect(nutritionTargets(data(fresh), TODAY)).toEqual({ ok: false, missing: ['weight'] });
  });

  it('counts logged training once, averaged over 14 days — never planned sessions', async () => {
    const base = targetsOf(data(await athlete()));
    // basketball is on the schedule today but not logged: nothing is added
    const planned = await athlete((a) => a.updateProfile({ schedule: [{ id: 's1', day: 2, kind: 'basketball', time: 'evening', durationMin: 90, enabled: true }] }));
    expect(targetsOf(data(planned)).maintenance).toBe(base.maintenance);
    // a logged 90-minute game (RPE 8): ≈ (7.8 − 1) MET × 68 kg × 1.5 h, spread over 14 days
    const logged = await athlete((a) => a.logBasketball({ durationMin: 90, rpe: 8, sessionType: 'game' } as never));
    const t = targetsOf(data(logged));
    expect(t.trainingSessions).toBe(1);
    expect(t.trainingPerDay).toBe(Math.round(Math.round(6.8 * 68 * 1.5) / 14));
    expect(t.maintenance - base.maintenance).toBe(t.trainingPerDay); // smoothed: not +694 on the day
    expect(trainingAverage(data(logged), addDays(TODAY, 14), 68).sessions).toBe(0); // gone after 14 days
    // targets move gently: the day after, the same training gives the same target
    expect(Math.abs(targetsOf(data(logged), addDays(TODAY, 1)).kcal - t.kcal)).toBeLessThanOrEqual(10);
  });

  it('the athlete’s own values replace APEX’s; trend adjustments add up, bounded', async () => {
    const a = await athlete();
    a.saveNutrition({ profile: { ...data(a).nutrition.profile, override: { kcal: 2800, protein: 140 } } });
    const t = targetsOf(data(a));
    expect(t).toMatchObject({ kcal: 2800, protein: 140, overridden: ['kcal', 'protein'] });
    expect(t.carbs).toBe(Math.round((2800 - 140 * 4 - t.fat * 9) / 4 / 5) * 5);
    a.saveNutrition({ profile: { ...data(a).nutrition.profile, override: { kcal: 99999 } } }); // out of range: dropped
    expect(targetsOf(data(a)).overridden).toEqual([]);
    a.saveNutrition({ profile: { ...data(a).nutrition.profile, adjustments: [{ date: TODAY, kcal: 150 }, { date: TODAY, kcal: 150 }] } });
    const b = targetsOf(data(a));
    expect(b.adjustment).toBe(300);
    expect(b.notes.join(' ')).toMatch(/\+300 kcal from weight-trend adjustments/);
  });
});

describe('training-day classification', () => {
  it('from APEX’s own plan, schedule and logs: gym, basketball, combined, rest', async () => {
    const legs = await athlete();
    expect(dayType(data(legs), TODAY, TODAY).kind).toBe('gym'); // Legs is planned today
    const both = await athlete((a) => a.logBasketball({ durationMin: 60, rpe: 6 } as never));
    expect(dayType(data(both), TODAY, TODAY)).toMatchObject({ kind: 'combined', basketball: { done: true } });
    const rest = await athlete((a) => { const g = data(a).instances.find((i) => i.date === TODAY && i.kind === 'gym')!; const p = data(a).instances.find((i) => i.date === TODAY && i.kind === 'plyometric'); a.takeRecoveryDay(g.id); if (p) a.takeRecoveryDay(p.id); });
    expect(dayType(data(rest), TODAY, TODAY).kind).toBe('rest'); // a recovery day isn't a gym day
    // an earlier day counts only what was logged
    expect(dayType(data(legs), addDays(TODAY, -7), TODAY).kind).toBe('rest');
    const free = [1, 2, 3, 4, 5, 6].map((n) => addDays(TODAY, n)).find((x) => dayType(data(legs), x, TODAY).kind === 'rest')!;
    const sat = await athlete((a) => a.updateProfile({ schedule: [{ id: 'b', day: weekdayIndex(free), kind: 'basketball', time: 'morning', enabled: true }] }));
    expect(dayType(data(sat), free, TODAY)).toMatchObject({ kind: 'basketball', basketball: { planned: true, done: false, time: 'morning' } });
  });
});

describe('the meal plan', () => {
  it('four meals plus a separate pre-gym meal on a gym day, scaled to the target, in household amounts', async () => {
    const d = data(await athlete());
    const t = targetsOf(d);
    const p = dayPlan(d, TODAY, TODAY, t);
    expect(p.meals.map((m) => m.slot)).toEqual(['breakfast', 'lunch', 'snacks', 'dinner']);
    expect(p.preGym).toMatchObject({ slot: 'preGym', window: '1to2h' });
    const all = [...p.meals, p.preGym!];
    expect(p.totals.kcal).toBe(all.reduce((s, m) => s + m.kcal, 0));
    for (const m of all) {
      expect(m.kcal).toBe(m.items.reduce((s, i) => s + i.kcal, 0));
      expect(m.eaten).toBe(false);
      for (const i of m.items) expect(i.qty).toBe(roundQty(i.qty, i.unit)); // whole eggs and rotis, 10 g steps
    }
    expect(Math.abs(p.totals.kcal - t.kcal) / t.kcal).toBeLessThan(0.2);
    expect(JSON.stringify(p).toLowerCase()).not.toMatch(/beef/);
  });

  it('rest days have no pre-gym meal; basketball days get recovery snacks; swaps and timing change the suggestion', async () => {
    const restA = await athlete((a) => { for (const i of data(a).instances.filter((x) => x.date === TODAY)) a.takeRecoveryDay(i.id); });
    expect(dayPlan(data(restA), TODAY, TODAY, targetsOf(data(restA))).preGym).toBeUndefined();
    const bb = await athlete((a) => a.logBasketball({ durationMin: 90, rpe: 8 } as never));
    const snack = dayPlan(data(bb), TODAY, TODAY, targetsOf(data(bb))).meals.find((m) => m.slot === 'snacks')!;
    expect(MEALS.find((t) => t.id === snack.id)?.recovery).toBe(true);
    const a = await athlete();
    const before = dayPlan(data(a), TODAY, TODAY, targetsOf(data(a)));
    a.swapSuggestion(TODAY, 'lunch');
    const after = dayPlan(data(a), TODAY, TODAY, targetsOf(data(a)));
    expect(after.meals[1].id).not.toBe(before.meals[1].id);
    expect(after.meals[0].id).toBe(before.meals[0].id);
    a.setPreGymWindow(TODAY, 'under45');
    expect(MEALS.find((t) => t.id === dayPlan(data(a), TODAY, TODAY, targetsOf(data(a))).preGym!.id)?.window).toBe('under45');
  });
});

describe('daily totals', () => {
  it('adds what was logged — suggestions aren’t food until logged', () => {
    const e = (kcal: number, protein: number): FoodEntry => ({ id: String(kcal), date: TODAY, meal: 'lunch', foodId: null, name: 'x', qty: 1, unit: 'serving', grams: null, loggedAt: '', kcal, protein, carbs: 10, fat: 5 });
    expect(totalsOf([e(300, 20.2), e(450, 30.2)])).toEqual({ kcal: 750, protein: 50.4, carbs: 20, fat: 10 });
    expect(totalsOf([])).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });
});

describe('weight trend', () => {
  const weighing = async (kgs: [number, number][]) => {
    const a = await athlete();
    const d = data(a);
    return { ...d, bodyMetrics: kgs.map(([day, kg], i) => ({ id: `w${i}`, date: addDays(TODAY, -day), kind: 'bodyweight' as const, value: kg })) };
  };

  it('needs two weekly averages — a single weigh-in never moves the target', async () => {
    expect(weightTrend(await weighing([[0, 70]]), TODAY)).toMatchObject({ status: 'need-data', suggestion: 0 });
    // one heavy day (water, salt) doesn't change the steady trend
    const steady: [number, number][] = [[1, 68.4], [2, 68.4], [4, 68.4], [14, 68], [16, 68], [18, 68]];
    expect(weightTrend(await weighing(steady), TODAY)).toMatchObject({ status: 'on-track', suggestion: 0 });
    expect(weightTrend(await weighing([[0, 70.5], ...steady]), TODAY)).toMatchObject({ status: 'on-track', suggestion: 0, latest: { kg: 70.5 } });
  });

  it('on track at ~0.25–0.5% a week; flat → +150 kcal; too fast → −150 kcal; nothing within 14 days of a change', async () => {
    const week = (now: number, then: number): [number, number][] => [[0, now], [2, now], [4, now], [14, then], [16, then], [18, then]];
    expect(weightTrend(await weighing(week(68.4, 68)), TODAY)).toMatchObject({ status: 'on-track', suggestion: 0 }); // +0.2 kg/wk
    const flat = weightTrend(await weighing(week(68, 68)), TODAY);
    expect(flat).toMatchObject({ status: 'slow', suggestion: 150, ratePerWeek: 0 });
    expect(weightTrend(await weighing(week(69.6, 68)), TODAY)).toMatchObject({ status: 'fast', suggestion: -150 });
    const changed = await weighing(week(68, 68));
    changed.nutrition = { ...changed.nutrition, profile: { ...changed.nutrition.profile, adjustments: [{ date: addDays(TODAY, -5), kcal: 150 }] } };
    expect(weightTrend(changed, TODAY)).toMatchObject({ status: 'slow', suggestion: 0, note: expect.stringMatching(/give it time/) });
  });
});
