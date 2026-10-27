// APEX Nutrition: targets, day type, meal plan, daily totals and weight trend — pure functions over
// the athlete's own data. Every number here is an estimate: the athlete adjusts it from their weight
// trend, training, hunger and recovery. Nothing in this file needs the AI.
import { addMacros, foodById, gramsOf, macrosOf, MEALS, ZERO, type Food, type Macros, type MealSlot, type MealTemplate, type PreGymWindow } from './foods';
import { itemsOn, plannedBasketball } from './profile';
import { dayFor } from './schedule';
import type { ApexData, ISODate, ISODateTime, SessionInstance } from './types';
import { addDays, clamp, daysBetween, roundTo, sum, weekdayIndex } from './util';

export type Sex = 'male' | 'female';
export type Lifestyle = 'low' | 'moderate' | 'high';

export interface NutritionProfile {
  /** Set when the athlete finished Nutrition setup. */
  setupAt?: ISODateTime;
  age?: number;
  /** When the age was given; it moves on from there. */
  ageAsOf?: ISODate;
  /** Only for the BMR equation. Unset → a labelled estimate between the two equations. */
  sex?: Sex;
  /** Activity outside training: study, work, walking. */
  lifestyle?: Lifestyle;
  diet?: 'non-vegetarian';
  /** Never suggested (matched against food names, aliases and tags). */
  avoid?: string[];
  budget?: 'budget' | 'moderate';
  /** The athlete's own targets; any value set replaces APEX's calculated one. */
  override?: Partial<Record<keyof Macros, number>>;
  /** Weight-trend adjustments the athlete applied, oldest first. */
  adjustments?: { date: ISODate; kcal: number }[];
}

/** Per-day planner choices: which suggestion to show, how long before the gym the pre-gym meal is. */
export interface NutritionDay {
  swaps?: Partial<Record<MealSlot, number>>;
  preGym?: PreGymWindow;
}

export interface NutritionData {
  profile: NutritionProfile;
  days: Record<ISODate, NutritionDay>;
}

/** Food the athlete logged: the numbers at logging time are kept, even if the food table changes. */
export interface FoodEntry extends Macros {
  id: string;
  date: ISODate;
  meal: MealSlot;
  /** null = a custom food the athlete described. */
  foodId: string | null;
  name: string;
  qty: number;
  unit: string;
  grams: number | null;
  loggedAt: ISODateTime;
  /** Logged from this suggested meal (template id). */
  plan?: string;
}

export const MAIN_MEALS: MealSlot[] = ['breakfast', 'lunch', 'snacks', 'dinner'];
export const MEAL_LABEL: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner', preGym: 'Pre-gym' };
export const WINDOW_LABEL: Record<PreGymWindow, string> = { under45: 'Under 45 min', '1to2h': '1–2 hours', '2to3h': '2–3 hours' };
export const LIFESTYLE: Record<Lifestyle, { factor: number; label: string; sub: string }> = {
  low: { factor: 1.3, label: 'Mostly sitting', sub: 'Desk study or work, little walking' },
  moderate: { factor: 1.4, label: 'Some moving', sub: 'Classes or work plus regular walking' },
  high: { factor: 1.55, label: 'On my feet', sub: 'Active job or lots of walking' },
};

/** Diet rules APEX applies until the athlete changes them. Body measurements have no defaults: the athlete enters them. */
export const DIET_DEFAULTS = { diet: 'non-vegetarian', avoid: ['beef'], budget: 'moderate', lifestyle: 'moderate' } as const;

export const emptyNutrition = (): NutritionData => ({ profile: {}, days: {} });

// ---------- weight (from the body log Progress already keeps) ----------

/** One value per day (the mean if weighed more than once), oldest first. */
export function weighIns(d: ApexData): { date: ISODate; kg: number }[] {
  const byDay = new Map<ISODate, number[]>();
  for (const m of d.bodyMetrics) if (m.kind === 'bodyweight' && Number.isFinite(m.value) && m.value > 0) byDay.set(m.date, [...(byDay.get(m.date) ?? []), m.value]);
  return [...byDay].map(([date, v]) => ({ date, kg: sum(v) / v.length })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The median weigh-in in a window: one heavy or light day (water, salt, a big meal) can't move it. */
const medianIn = (w: { date: ISODate; kg: number }[], from: ISODate, to: ISODate) => {
  const xs = w.filter((x) => x.date >= from && x.date <= to).map((x) => x.kg).sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length ? { kg: xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2, n: xs.length } : undefined;
};

/** The weight targets use: the week's median once there are 3 weigh-ins in it, else the latest. */
export function workingWeight(d: ApexData, date: ISODate): number | undefined {
  const w = weighIns(d).filter((x) => x.date <= date);
  const week = medianIn(w, addDays(date, -6), date);
  return week && week.n >= 3 ? week.kg : w.at(-1)?.kg;
}

export type TrendStatus = 'need-data' | 'losing' | 'slow' | 'on-track' | 'fast';

export interface WeightTrend {
  latest?: { date: ISODate; kg: number };
  /** This week's median weigh-in (3+ weigh-ins). */
  weekKg?: number;
  /** kg per week, from two weekly medians two weeks apart. */
  ratePerWeek?: number;
  /** % of bodyweight per week. */
  ratePct?: number;
  status: TrendStatus;
  /** kcal APEX suggests changing the target by (0 = keep). Never from a single weigh-in. */
  suggestion: number;
  note: string;
}

/**
 * Trend, not fluctuation: this week's median weigh-in against the median two weeks earlier, each from
 * at least 3 weigh-ins. Aim for about 0.25–0.5% of bodyweight a week; a suggestion is ±150 kcal at
 * most and waits 14 days after the last change.
 */
export function weightTrend(d: ApexData, today: ISODate): WeightTrend {
  const w = weighIns(d).filter((x) => x.date <= today);
  const latest = w.at(-1);
  const recent = medianIn(w, addDays(today, -6), today);
  const earlier = medianIn(w, addDays(today, -20), addDays(today, -14));
  const weekKg = recent && recent.n >= 3 ? recent.kg : undefined;
  if (!recent || !earlier || recent.n < 3 || earlier.n < 3) {
    return { latest, weekKg, status: 'need-data', suggestion: 0, note: 'Weigh in at least 3 times a week, at the same time of day, for two weeks to see a trend. A single weigh-in moves with water, food and salt.' };
  }
  const ratePerWeek = (recent.kg - earlier.kg) / 2;
  const ratePct = (ratePerWeek / earlier.kg) * 100;
  const status: TrendStatus = ratePct < -0.1 ? 'losing' : ratePct < 0.15 ? 'slow' : ratePct <= 0.75 ? 'on-track' : 'fast';
  const last = d.nutrition.profile.adjustments?.at(-1);
  const waiting = !!last && daysBetween(last.date, today) < 14;
  const raw = status === 'losing' || status === 'slow' ? 150 : status === 'fast' ? -150 : 0;
  const suggestion = waiting ? 0 : raw;
  const note = status === 'on-track' ? 'Gaining at a steady, gradual rate — keep the target.'
    : status === 'fast' ? 'Gaining faster than about 0.75% a week — likely more fat than muscle.'
      : status === 'slow' ? 'Weight is about flat over two weeks.'
        : 'Weight is going down over two weeks.';
  return { latest, weekKg, ratePerWeek, ratePct, status, suggestion, note: raw && waiting ? `${note} A change was made in the last 14 days — give it time first.` : note };
}

// ---------- training energy (logged sessions only) ----------

type SessionKcal = { kind: 'basketball' | 'gym' | 'plyo'; minutes: number; kcal: number };

const minutesOf = (i: SessionInstance, fallback: number) => {
  const m = i.startedAt && i.completedAt ? (Date.parse(i.completedAt) - Date.parse(i.startedAt)) / 60_000 : NaN;
  return Number.isFinite(m) && m >= 10 && m <= 180 ? m : fallback;
};

/**
 * Energy of the training logged on a date, above resting (the BMR already counts resting): MET
 * values from the Compendium of Physical Activities ranges — basketball from about 4.5 (shooting)
 * to 8 (games), scaled by session RPE; resistance training 5; plyometrics 7. Planned sessions don't
 * count; each logged session counts once.
 */
export function trainingKcal(d: ApexData, date: ISODate, kg: number): SessionKcal[] {
  const net = (met: number, minutes: number) => Math.round((met - 1) * kg * (minutes / 60));
  const bb = d.basketball.filter((b) => b.date === date && b.durationMin > 0).map((b): SessionKcal => ({ kind: 'basketball', minutes: b.durationMin, kcal: net(clamp(3 + 0.6 * b.rpe, 4.5, 9), b.durationMin) }));
  const done = d.instances.filter((i) => i.date === date && i.status === 'completed');
  const gym = done.flatMap((i): SessionKcal[] => {
    if (i.kind === 'gym') {
      const sets = i.exercises.flatMap((e) => e.sets).filter((s) => s.kind === 'working').length;
      const minutes = minutesOf(i, sets * 3);
      return minutes ? [{ kind: 'gym', minutes, kcal: net(5, minutes) }] : [];
    }
    const minutes = minutesOf(i, 20);
    return [{ kind: 'plyo', minutes, kcal: net(7, minutes) }];
  });
  return [...bb, ...gym];
}

const WINDOW = 14;

/** Average daily training energy over the 14 days ending on `date`: smooth, so targets don't jump. */
export function trainingAverage(d: ApexData, date: ISODate, kg: number) {
  const sessions = Array.from({ length: WINDOW }, (_, i) => trainingKcal(d, addDays(date, -i), kg)).flat();
  return { perDay: Math.round(sum(sessions.map((s) => s.kcal)) / WINDOW), sessions: sessions.length };
}

// ---------- targets ----------

export interface NutritionTargets extends Macros {
  bmr: number;
  /** [female equation, male equation] while sex isn't set. */
  bmrRange: [number, number] | null;
  lifestyleFactor: number;
  trainingPerDay: number;
  trainingSessions: number;
  maintenance: number;
  surplus: number;
  adjustment: number;
  weightKg: number;
  overridden: (keyof Macros)[];
  notes: string[];
}

export type Missing = 'age' | 'height' | 'weight';
export type TargetsResult = { ok: true; targets: NutritionTargets } | { ok: false; missing: Missing[] };

export const ageOn = (p: NutritionProfile, date: ISODate) =>
  p.age === undefined ? undefined : p.age + (p.ageAsOf ? Math.max(0, Math.floor(daysBetween(p.ageAsOf, date) / 365.25)) : 0);

/** Mifflin–St Jeor resting energy. */
export const mifflin = (kg: number, cm: number, age: number, sex: Sex) => 10 * kg + 6.25 * cm - 5 * age + (sex === 'male' ? 5 : -161);

/**
 * Daily targets for gradual gain. maintenance = BMR × lifestyle factor + average logged training;
 * target = maintenance + a modest surplus (≈10%, 200–400 kcal) + any trend adjustments the athlete
 * applied. Protein 1.8 g/kg (within the common 1.6–2.2 g/kg for muscle gain), fat ≈25% of calories
 * (at least 0.8 g/kg), carbohydrate the rest. The athlete's own values replace any of them.
 */
export function nutritionTargets(d: ApexData, date: ISODate): TargetsResult {
  const p = d.nutrition.profile;
  const age = ageOn(p, date);
  const cm = d.profile.heightCm;
  const kg = workingWeight(d, date);
  const missing: Missing[] = [...(age === undefined ? ['age' as const] : []), ...(!cm ? ['height' as const] : []), ...(!kg ? ['weight' as const] : [])];
  if (missing.length || age === undefined || !cm || !kg) return { ok: false, missing };

  const female = mifflin(kg, cm, age, 'female');
  const male = mifflin(kg, cm, age, 'male');
  const bmr = Math.round(p.sex === 'male' ? male : p.sex === 'female' ? female : (female + male) / 2);
  const factor = LIFESTYLE[p.lifestyle ?? 'moderate'].factor;
  const training = trainingAverage(d, date, kg);
  const maintenance = Math.round(bmr * factor + training.perDay);
  const surplus = clamp(roundTo(maintenance * 0.1, 50), 200, 400);
  const adjustment = clamp(sum((p.adjustments ?? []).map((a) => a.kcal)), -600, 600);
  const o = p.override ?? {};
  const kcal = o.kcal ?? roundTo(maintenance + surplus + adjustment, 10);
  const protein = o.protein ?? roundTo(1.8 * kg, 5);
  const fat = o.fat ?? roundTo(Math.max((0.25 * kcal) / 9, 0.8 * kg), 5);
  const carbs = o.carbs ?? Math.max(0, roundTo((kcal - protein * 4 - fat * 9) / 4, 5));
  const overridden = (['kcal', 'protein', 'carbs', 'fat'] as const).filter((k) => o[k] !== undefined);

  const notes = [
    'These are estimates, not prescriptions. Adjust them from your weight trend, training, hunger and recovery.',
    `Resting energy (BMR) ${bmr} kcal from the Mifflin–St Jeor equation, × ${factor} for daily life outside training.`,
    ...(p.sex ? [] : [`Sex isn’t set, so BMR is the middle of the male and female equations (${Math.round(female)}–${Math.round(male)} kcal). Add it in Nutrition profile for a closer estimate.`]),
    training.sessions
      ? `Training: ${training.sessions} logged session${training.sessions === 1 ? '' : 's'} in the last 14 days, about ${training.perDay} kcal a day on average. Planned sessions count once they’re logged.`
      : 'No training logged in the last 14 days, so none is added yet. It’s added as you log sessions.',
    `Gain: +${surplus} kcal a day (about 10% over maintenance) for a gradual gain of roughly 0.25–0.5% of bodyweight a week.`,
    ...(adjustment ? [`Includes ${adjustment > 0 ? '+' : ''}${adjustment} kcal from weight-trend adjustments you applied.`] : []),
    'Protein 1.8 g per kg of bodyweight (common range for muscle gain: 1.6–2.2 g/kg); fat about 25% of calories; carbohydrate makes up the rest.',
    ...(overridden.length ? [`Your own value replaces APEX’s for: ${overridden.map((k) => (k === 'kcal' ? 'calories' : k)).join(', ')}.`] : []),
  ];
  return {
    ok: true,
    targets: {
      kcal, protein, carbs, fat, bmr, bmrRange: p.sex ? null : [Math.round(female), Math.round(male)], lifestyleFactor: factor,
      trainingPerDay: training.perDay, trainingSessions: training.sessions, maintenance, surplus, adjustment, weightKg: +kg.toFixed(1), overridden, notes,
    },
  };
}

/** Why a day has no targets — so the screen can say so while still showing what was eaten. */
export type TargetsGap =
  | { kind: 'setup' }
  /** Targets use the latest weigh-in on or before the day; `first` = the first weigh-in after it, if any. */
  | { kind: 'no-weigh-in'; first?: ISODate }
  | { kind: 'missing'; missing: Missing[] };

export function targetsGap(d: ApexData, t: TargetsResult, date: ISODate): TargetsGap | undefined {
  if (t.ok) return undefined;
  if (!d.nutrition.profile.setupAt) return { kind: 'setup' };
  if (t.missing.length === 1 && t.missing[0] === 'weight') return { kind: 'no-weigh-in', first: weighIns(d).find((w) => w.date > date)?.date };
  return { kind: 'missing', missing: t.missing };
}

// ---------- the day: training type ----------

export type DayKind = 'gym' | 'basketball' | 'combined' | 'rest';
export interface DayType {
  kind: DayKind;
  gym: { planned: boolean; done: boolean; time?: string };
  basketball: { planned: boolean; done: boolean; time?: string };
}

export const DAY_LABEL: Record<DayKind, string> = { gym: 'Gym day', basketball: 'Basketball day', combined: 'Gym + basketball', rest: 'Rest day' };

/**
 * From APEX's own training data — no second schedule. Today and later: what is planned or done
 * (a session set aside as a recovery day doesn't count). Earlier days: only what was logged.
 */
export function dayType(d: ApexData, date: ISODate, today: ISODate): DayType {
  const inst = d.instances.filter((i) => i.date === date);
  const plan = dayFor(d.plan, date);
  const gymDone = inst.some((i) => i.status === 'completed');
  const gymOpen = inst.length ? inst.some((i) => i.status === 'planned' || i.status === 'active') : !!(plan.gym || plan.plyo);
  const bbDone = d.basketball.some((b) => b.date === date);
  const bbItem = plannedBasketball(d, date)?.item;
  const ahead = date >= today;
  const gym = gymDone || (ahead && gymOpen);
  const basketball = bbDone || (ahead && !!bbItem);
  const gymTime = itemsOn(d, weekdayIndex(date)).find((i) => i.kind === 'gym')?.time ?? d.profile.gymTime;
  return {
    kind: gym && basketball ? 'combined' : gym ? 'gym' : basketball ? 'basketball' : 'rest',
    gym: { planned: ahead && gymOpen, done: gymDone, ...(gym && gymTime && { time: gymTime }) },
    basketball: { planned: ahead && !!bbItem, done: bbDone, ...(bbItem?.time && { time: bbItem.time }) },
  };
}

// ---------- food log ----------

export const entriesOn = (d: ApexData, date: ISODate) => d.foodLog.filter((e) => e.date === date);
export const totalsOf = (entries: FoodEntry[]): Macros => entries.reduce<Macros>((t, e) => addMacros(t, e), ZERO);

export function dayLog(d: ApexData, date: ISODate) {
  const entries = entriesOn(d, date);
  const byMeal = Object.fromEntries((['breakfast', 'lunch', 'snacks', 'dinner', 'preGym'] as MealSlot[]).map((s) => [s, entries.filter((e) => e.meal === s)])) as Record<MealSlot, FoodEntry[]>;
  return { entries, byMeal, totals: totalsOf(entries) };
}

export const remaining = (target: Macros, eaten: Macros): Macros => ({
  kcal: target.kcal - eaten.kcal, protein: +(target.protein - eaten.protein).toFixed(1), carbs: +(target.carbs - eaten.carbs).toFixed(1), fat: +(target.fat - eaten.fat).toFixed(1),
});

// ---------- the meal plan (suggestions only) ----------

export interface PlannedItem extends Macros {
  foodId: string;
  name: string;
  qty: number;
  unit: string;
  grams: number;
}

export interface PlannedMeal extends Macros {
  slot: MealSlot;
  id: string;
  name: string;
  items: PlannedItem[];
  /** The kcal APEX aimed this meal at. */
  target: number;
  /** Logged from this suggestion today. */
  eaten: boolean;
  /** Other suggestions there are for this meal today. */
  options: number;
}

export interface DayPlan {
  day: DayType;
  meals: PlannedMeal[];
  /** Only on gym days. Separate from the four meals. */
  preGym?: PlannedMeal & { window: PreGymWindow };
  totals: Macros;
  /** Protein the suggestions fall short of the target by (0 = none). */
  proteinGap: number;
}

const SHARE_GYM: Record<MealSlot, number> = { breakfast: 0.24, lunch: 0.28, snacks: 0.14, dinner: 0.24, preGym: 0.1 };
const SHARE_OTHER: Record<MealSlot, number> = { breakfast: 0.26, lunch: 0.3, snacks: 0.18, dinner: 0.26, preGym: 0 };
const PIECES = new Set(['egg', 'white', 'roti', 'idli', 'dosa', 'slice', 'banana', 'apple', 'orange', 'date', 'paratha', 'potato']);

/** Household-friendly quantities: whole eggs and rotis, half katoris, 10 g steps. */
export function roundQty(qty: number, unit: string) {
  if (PIECES.has(unit)) return Math.max(1, Math.round(qty));
  if (unit === 'g' || unit === 'ml') return Math.max(10, roundTo(qty, unit === 'ml' ? 50 : 10));
  return Math.max(0.5, roundTo(qty, 0.5));
}

const avoids = (food: Food, avoid: string[]) => {
  const words = [food.id, food.name, ...(food.aliases ?? []), ...food.tags].map((x) => x.toLowerCase());
  return avoid.some((a) => words.some((w) => w.includes(a.toLowerCase())));
};

export function plannedMeal(t: MealTemplate, target: number, eaten: boolean, options: number): PlannedMeal {
  const base = sum(t.items.map(([id, q]) => macrosOf(foodById(id)!, gramsOf(foodById(id)!, q)!).kcal));
  const k = t.slot === 'preGym' ? clamp(target / base, 0.7, 1.5) : clamp(target / base, 0.6, 1.8);
  const items = t.items.map(([id, q]): PlannedItem => {
    const food = foodById(id)!;
    const unit = food.units[0].unit;
    const qty = roundQty(q * k, unit);
    const grams = gramsOf(food, qty, unit)!;
    return { foodId: id, name: food.name, qty, unit, grams, ...macrosOf(food, grams) };
  });
  return { slot: t.slot, id: t.id, name: t.name, items, target: Math.round(target), eaten, options, ...items.reduce<Macros>((s, i) => addMacros(s, i), ZERO) };
}

/**
 * Suggested meals for a day, scaled to its calorie target: on gym days a separate pre-gym meal for
 * the time available before training; after basketball, recovery snacks. Choices rotate by date and
 * can be swapped; nothing counts as eaten until the athlete logs it.
 */
export function dayPlan(d: ApexData, date: ISODate, today: ISODate, target: Macros): DayPlan {
  const day = dayType(d, date, today);
  const p = d.nutrition.profile;
  const choices = d.nutrition.days[date] ?? {};
  const avoid = p.avoid ?? ['beef'];
  const gymDay = day.kind === 'gym' || day.kind === 'combined';
  const share = gymDay ? SHARE_GYM : SHARE_OTHER;
  const entries = entriesOn(d, date);
  const allowed = (t: MealTemplate) => t.items.every(([id]) => { const f = foodById(id); return !!f && !avoids(f, avoid) && (p.budget !== 'budget' || f.cost === 1); });
  const n = daysBetween('2026-01-05', date); // a Monday: suggestions rotate day by day
  const pick = (slot: MealSlot, list: MealTemplate[]) => {
    if (!list.length) return undefined;
    const i = (((n + (choices.swaps?.[slot] ?? 0)) % list.length) + list.length) % list.length;
    const t = list[i];
    return plannedMeal(t, target.kcal * share[slot], entries.some((e) => e.plan === t.id && e.meal === slot), list.length);
  };
  const recovery = day.kind === 'basketball' || day.kind === 'combined';
  const meals = MAIN_MEALS.flatMap((slot) => {
    const all = MEALS.filter((t) => t.slot === slot && allowed(t));
    const list = slot === 'snacks' ? all.filter((t) => !!t.recovery === recovery) : all;
    const meal = pick(slot, list.length ? list : all);
    return meal ? [meal] : [];
  });
  const window = choices.preGym ?? '1to2h';
  const pre = gymDay ? pick('preGym', MEALS.filter((t) => t.slot === 'preGym' && t.window === window && allowed(t))) : undefined;
  const totals = [...meals, ...(pre ? [pre] : [])].reduce<Macros>((s, x) => addMacros(s, x), ZERO);
  return { day, meals, ...(pre && { preGym: { ...pre, window } }), totals, proteinGap: Math.max(0, Math.round(target.protein - totals.protein)) };
}
