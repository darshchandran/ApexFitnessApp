import { describe, expect, it } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { dayLog, dayPlan, nutritionTargets } from '../../domain/nutrition';
import { createApex, todayOverview } from '../apex';

// Wed 7 Oct 2026: Legs on the program
function setup(store = memoryStore()) {
  const c = { now: new Date(2026, 9, 7, 9) };
  const apex = createApex(store, () => c.now);
  const restart = async () => { const b = createApex(store, () => c.now); await b.init(); return b; };
  return { apex, c, store, restart };
}
type A = ReturnType<typeof createApex>;
const TODAY = '2026-10-07';
const YESTERDAY = '2026-10-06';
const d = (a: A) => a.getState().data;
const log = (a: A, date = TODAY) => dayLog(d(a), date);
const plan = (a: A) => {
  const t = nutritionTargets(d(a), TODAY);
  if (!t.ok) throw new Error('no targets');
  return dayPlan(d(a), TODAY, TODAY, t.targets);
};
const setUp = (a: A) => a.saveNutrition({ profile: { age: 20, ageAsOf: TODAY, lifestyle: 'moderate', avoid: ['beef'] }, heightCm: 178, targetKg: 75, weightKg: 68 });

describe('nutrition setup', () => {
  it('stores the profile; height and target go to the athlete profile, weight to the body log', async () => {
    const { apex, restart } = setup();
    await apex.init();
    expect(nutritionTargets(d(apex), TODAY)).toEqual({ ok: false, missing: ['age', 'height', 'weight'] });
    setUp(apex);
    expect(d(apex).nutrition.profile).toMatchObject({ age: 20, lifestyle: 'moderate', avoid: ['beef'], setupAt: expect.any(String) });
    expect(d(apex).profile).toMatchObject({ heightCm: 178, targetBodyweightKg: 75 });
    expect(d(apex).bodyMetrics).toEqual([expect.objectContaining({ date: TODAY, kind: 'bodyweight', value: 68 })]);
    setUp(apex); // saving again doesn't add a second identical weigh-in
    expect(d(apex).bodyMetrics).toHaveLength(1);
    apex.saveNutrition({ profile: { ...d(apex).nutrition.profile, age: 500, sex: 'other' as never, lifestyle: 'extreme' as never } });
    expect(d(apex).nutrition.profile).not.toHaveProperty('sex');
    expect(d(apex).nutrition.profile).not.toHaveProperty('age'); // invalid values are dropped, never stored
    await apex.flush();
    expect((await restart()).getState().data.nutrition).toEqual(d(apex).nutrition);
  });
});

describe('food logging', () => {
  it('log a food in a serving size, edit it, remove it — totals follow', async () => {
    const { apex } = setup();
    await apex.init();
    const e = apex.logFood({ date: TODAY, meal: 'breakfast', foodId: 'egg', qty: 3 })!;
    expect(e).toMatchObject({ name: 'Egg (whole)', qty: 3, unit: 'egg', grams: 150, kcal: 215, meal: 'breakfast' });
    apex.logFood({ date: TODAY, meal: 'breakfast', foodId: 'roti', qty: 2 });
    expect(log(apex).byMeal.breakfast).toHaveLength(2);
    expect(log(apex).totals.kcal).toBe(e.kcal + log(apex).byMeal.breakfast[1].kcal);
    apex.updateFood(e.id, 2);
    expect(log(apex).byMeal.breakfast[0]).toMatchObject({ qty: 2, grams: 100, kcal: 143 });
    apex.updateFood(e.id, 80, 'g'); // another unit of the same food
    expect(log(apex).byMeal.breakfast[0]).toMatchObject({ qty: 80, unit: 'g', grams: 80 });
    apex.removeFood(e.id);
    expect(log(apex).entries.map((x) => x.foodId)).toEqual(['roti']);
  });

  it('a custom food: the athlete gives calories, macros are optional and scale with the quantity', async () => {
    const { apex } = setup();
    await apex.init();
    const e = apex.logFood({ date: TODAY, meal: 'snacks', qty: 1, custom: { name: '  Mess thali ', kcal: 650, protein: 18 } })!;
    expect(e).toMatchObject({ foodId: null, name: 'Mess thali', kcal: 650, protein: 18, carbs: 0, fat: 0, grams: null });
    apex.updateFood(e.id, 1.5);
    expect(log(apex).entries[0]).toMatchObject({ kcal: 975, protein: 27 });
  });

  it('rejects what can’t be trusted: unknown food or unit, future days, absurd amounts', async () => {
    const { apex } = setup();
    await apex.init();
    expect(apex.logFood({ date: TODAY, meal: 'lunch', foodId: 'beef-curry', qty: 1 })).toBeUndefined();
    expect(apex.logFood({ date: TODAY, meal: 'lunch', foodId: 'dal', qty: 1, unit: 'bucket' })).toBeUndefined();
    expect(apex.logFood({ date: '2026-10-08', meal: 'lunch', foodId: 'dal', qty: 1 })).toBeUndefined();
    expect(apex.logFood({ date: TODAY, meal: 'lunch', foodId: 'rice', qty: 4000, unit: 'g' })).toBeUndefined();
    expect(apex.logFood({ date: TODAY, meal: 'brunch' as never, foodId: 'dal', qty: 1 })).toBeUndefined();
    expect(apex.logFood({ date: TODAY, meal: 'lunch', qty: 1, custom: { name: '', kcal: 300 } })).toBeUndefined();
    expect(apex.logFood({ date: TODAY, meal: 'lunch', qty: 1, custom: { name: 'x', kcal: Number.NaN } })).toBeUndefined();
    expect(d(apex).foodLog).toEqual([]);
  });

  it('copies a previous day’s meal and keeps earlier days’ logs', async () => {
    const { apex } = setup();
    await apex.init();
    apex.logFood({ date: YESTERDAY, meal: 'lunch', foodId: 'rice', qty: 1 });
    apex.logFood({ date: YESTERDAY, meal: 'lunch', foodId: 'chicken-curry', qty: 1 });
    expect(apex.copyMeal(YESTERDAY, 'lunch', TODAY)).toBe(2);
    expect(log(apex).byMeal.lunch.map((x) => x.foodId)).toEqual(['rice', 'chicken-curry']);
    expect(log(apex, YESTERDAY).entries).toHaveLength(2);
    expect(log(apex).totals).toEqual(log(apex, YESTERDAY).totals);
    expect(apex.copyMeal(TODAY, 'lunch', '2026-10-09')).toBe(0); // never into the future
  });
});

describe('suggested versus consumed', () => {
  it('a suggestion counts only once it is marked eaten — once — and swapping never touches the log', async () => {
    const { apex } = setup();
    await apex.init();
    setUp(apex);
    const before = plan(apex);
    expect(log(apex).totals.kcal).toBe(0); // suggestions are on screen, nothing eaten
    const lunch = before.meals.find((m) => m.slot === 'lunch')!;
    expect(apex.eatSuggestion(TODAY, 'lunch')).toBe(lunch.items.length);
    expect(log(apex).byMeal.lunch.map((x) => x.plan)).toEqual(lunch.items.map(() => lunch.id));
    expect(log(apex).totals.kcal).toBe(lunch.kcal);
    expect(plan(apex).meals.find((m) => m.slot === 'lunch')!.eaten).toBe(true);
    expect(apex.eatSuggestion(TODAY, 'lunch')).toBe(0); // a double tap logs nothing more
    const logged = d(apex).foodLog;
    apex.swapSuggestion(TODAY, 'lunch');
    expect(d(apex).foodLog).toBe(logged);
    expect(plan(apex).meals.find((m) => m.slot === 'lunch')!.id).not.toBe(lunch.id);
    expect(apex.eatSuggestion('2026-10-08', 'lunch')).toBe(0); // tomorrow hasn't happened
  });

  it('the pre-gym meal is logged on its own, apart from the four meals', async () => {
    const { apex } = setup();
    await apex.init();
    setUp(apex);
    apex.setPreGymWindow(TODAY, 'under45');
    apex.setPreGymWindow(TODAY, 'tomorrow' as never); // ignored
    expect(d(apex).nutrition.days[TODAY]).toEqual({ preGym: 'under45' });
    apex.eatSuggestion(TODAY, 'preGym');
    expect(log(apex).byMeal.preGym.length).toBeGreaterThan(0);
    expect(log(apex).byMeal.breakfast).toEqual([]);
  });

  it('applies only the trend change APEX suggests', async () => {
    const { apex } = setup();
    await apex.init();
    setUp(apex);
    expect(apex.applyTrendAdjustment()).toBe(0); // one weigh-in: no trend, nothing applied
    expect(d(apex).nutrition.profile.adjustments).toBeUndefined();
  });
});

describe('persistence and migration', () => {
  it('the food log and planner choices survive a restart', async () => {
    const { apex, restart } = setup();
    await apex.init();
    setUp(apex);
    apex.eatSuggestion(TODAY, 'breakfast');
    apex.logFood({ date: TODAY, meal: 'dinner', foodId: 'fish-curry', qty: 1 });
    apex.swapSuggestion(TODAY, 'dinner');
    await apex.flush();
    const b = await restart();
    expect(b.getState().data.foodLog).toEqual(d(apex).foodLog);
    expect(b.getState().data.nutrition).toEqual(d(apex).nutrition);
  });

  it('data saved before Nutrition existed loads with an empty nutrition log; a corrupt row is dropped', async () => {
    const store = memoryStore();
    const { apex, restart } = setup(store);
    await apex.init();
    const w = todayOverview(d(apex), apex.today()).gym!;
    apex.startInstance(w.id);
    await apex.flush();
    const training = { instances: d(apex).instances, templates: d(apex).templates, plan: d(apex).plan };
    // an install from before this release
    expect(store.dump()).toHaveProperty(['apex:v1:foodLog']);
    await store.removeItem('apex:v1:nutrition');
    await store.removeItem('apex:v1:foodLog');
    const old = await restart();
    expect(old.getState().data.nutrition).toEqual({ profile: {}, days: {} });
    expect(old.getState().data.foodLog).toEqual([]);
    expect({ instances: old.getState().data.instances, templates: old.getState().data.templates, plan: old.getState().data.plan }).toEqual(training);
    // one bad row doesn't cost the athlete the rest of the log
    const good = old.logFood({ date: TODAY, meal: 'lunch', foodId: 'dal', qty: 1 })!;
    await old.flush();
    await store.setItem('apex:v1:foodLog', JSON.stringify([good, { ...good, id: 'bad', kcal: 'lots' }, { ...good, id: 'bad2', meal: 'brunch' }]));
    expect((await restart()).getState().data.foodLog).toEqual([good]);
  });

  it('nutrition never changes training: templates, the plan and today’s session stay as they were', async () => {
    const { apex } = setup();
    await apex.init();
    const before = { templates: d(apex).templates, plan: d(apex).plan, instances: d(apex).instances, basketball: d(apex).basketball };
    setUp(apex);
    apex.logFood({ date: TODAY, meal: 'lunch', foodId: 'rice', qty: 1 });
    apex.eatSuggestion(TODAY, 'dinner');
    apex.swapSuggestion(TODAY, 'snacks');
    expect({ templates: d(apex).templates, plan: d(apex).plan, instances: d(apex).instances, basketball: d(apex).basketball }).toEqual(before);
  });
});
