// Athlete context, learned progressively. The profile is allowed to be mostly empty: every
// fact is optional and the app works without it. Questions are asked only when a decision
// needs the answer, inferred patterns are offered as suggestions — never written silently —
// and nothing here ever counts as training: only logged sessions are load and history.
//
// What is NOT stored here, because it already lives elsewhere:
//   which gym / plyo session runs on which day → the program plan (plan.days, rotations)
//   bodyweight and measurements                → bodyMetrics
//   jump test results                          → performance
//   effort scale, auto rest                    → settings
import type { ApexData, ISODate, ISODateTime, SessionInstance } from './types';
import { addDays, daysBetween, toISODate, weekdayIndex } from './util';

export type Goal = 'performance' | 'muscle' | 'both';
export type Sport = 'basketball' | 'other' | 'none';
export type Units = 'kg' | 'lb';
export type Experience = 'new' | 'intermediate' | 'advanced';
export type Focus = 'strength' | 'size' | 'jump' | 'speed' | 'general';
export type TimeSlot = 'morning' | 'midday' | 'afternoon' | 'evening';
/** A part of the day, an approximate 'HH:MM', or 'varies' (the athlete trains at different times). */
export type TrainingTime = TimeSlot | 'varies' | string;
export type GymAfterBasketball = 'yes' | 'no' | 'sometimes' | 'unsure';

// ---------- the recurring week ----------

export type ScheduleKind = 'basketball' | 'gym' | 'plyo' | 'conditioning' | 'other';
export type Intensity = 'light' | 'moderate' | 'hard';

/**
 * One recurring activity on one weekday. Several can share a day; array order is the athlete's
 * order. Gym and plyo items only add timing to the program's session that day — the program
 * decides which template it is. Disabled items are kept (e.g. off-season) but ignored.
 */
export interface ScheduleItem {
  id: string;
  day: number; // 0 = Monday … 6 = Sunday
  kind: ScheduleKind;
  label?: string; // "Practice", "Pickup", "Track"
  time?: TrainingTime; // unset = any time
  durationMin?: number;
  intensity?: Intensity;
  enabled: boolean;
}

export type QuestionKey =
  | 'goal' | 'sport' | 'units' | 'focus' | 'gymTime' | 'basketballDays' | 'basketballWeekday' | 'useBasketballLoad'
  | 'gymAfterBasketball' | 'bodyweight' | 'basketballToday' | 'suggestBasketballDays' | 'suggestGymTime';

export interface PromptRecord {
  at: ISODateTime; // last NOT NOW / SKIP
  count: number; // times put off
  skipped?: boolean; // SKIP: don't ask again unless a decision genuinely needs it later
}

export interface AthleteProfile {
  goal?: Goal;
  sport?: Sport;
  units?: Units;
  experience?: Experience;
  /** What the athlete is mainly trying to improve right now. */
  focus?: Focus;
  /** Usual gym time; a schedule item's own time wins for its day. */
  gymTime?: TrainingTime;
  gymAfterBasketball?: GymAfterBasketball;
  /** false = leave logged basketball out of gym adaptation. Unset = Apex's default (use it). */
  useBasketballLoad?: boolean;
  heightCm?: number;
  targetBodyweightKg?: number;
  verticalTargetCm?: number;
  /** The recurring week. Undefined = never set (older data is migrated on load). */
  schedule?: ScheduleItem[];
  /** Set when the athlete gave or confirmed their basketball days. */
  basketballDaysConfirmedAt?: ISODateTime;
  /** Weekdays the athlete said they don't usually play — never asked about again. */
  basketballNotUsual?: number[];
  prompts?: Partial<Record<QuestionKey, PromptRecord>>;
  /** Last time a question was answered or put off — Home asks at most one thing per half day. */
  lastPromptAt?: ISODateTime;
}

// ---------- units: weights are stored in kg; lb is a display and input preference ----------

export const LB_PER_KG = 2.20462;
export const toUnits = (kg: number, u: Units = 'kg') => (u === 'lb' ? kg * LB_PER_KG : kg);
export const fromUnits = (v: number, u: Units = 'kg') => (u === 'lb' ? +(v / LB_PER_KG).toFixed(4) : v);
/** Plate step in the athlete's units: 2.5 kg stays 2.5 kg; in lb it becomes 5 lb (2.5 lb for small jumps). */
export const stepIn = (incrementKg: number, u: Units = 'kg') => (u === 'lb' ? (incrementKg >= 2 ? 5 : 2.5) : incrementKg);
/** The same step back in kg, so progression adds whole plates in the athlete's units. */
export const incrementKg = (incrementKgValue: number, u: Units = 'kg') => (u === 'lb' ? stepIn(incrementKgValue, u) / LB_PER_KG : incrementKgValue);

/** A stored kg weight as a number in the athlete's units: 61.235 kg → "135" lb. */
export function wt(kg: number, u: Units) {
  const v = toUnits(kg, u);
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB') : `${+v.toFixed(u === 'lb' ? 1 : 2)}`;
}
export const wtu = (kg: number, u: Units) => `${wt(kg, u)} ${u}`;

/** Engine text ("Keep 61.24 kg", "82.5 kg × 8") in the athlete's units. */
export const localize = (text: string, u: Units) => (u === 'kg' ? text : text.replace(/(\d+(?:\.\d+)?) kg\b/g, (_, n: string) => wtu(Number(n), u)));

// ---------- times ----------

const SLOT_HOUR: Record<TimeSlot, number> = { morning: 8, midday: 12, afternoon: 15, evening: 19 };
const SLOT_END: Record<TimeSlot, number> = { morning: 11, midday: 14, afternoon: 17, evening: 21 };
export const isClock = (t: string) => /^\d{2}:\d{2}$/.test(t);
export const validTime = (t: string): t is TrainingTime => isClock(t) || t === 'varies' || t in SLOT_HOUR;
/** Rough hour of day for ordering, or undefined when unknown or varying. */
export const hourOf = (t?: TrainingTime) => (!t || t === 'varies' ? undefined : isClock(t) ? Number(t.slice(0, 2)) + Number(t.slice(3)) / 60 : SLOT_HOUR[t as TimeSlot]);
export const slotOf = (time: string): TimeSlot => {
  const h = Number(time.slice(0, 2));
  return h < 11 ? 'morning' : h < 14 ? 'midday' : h < 17 ? 'afternoon' : 'evening';
};
const sameSlot = (a: TrainingTime | undefined, b: string) => !!a && a !== 'varies' && (isClock(a) ? Math.abs(Number(a.slice(0, 2)) - Number(b.slice(0, 2))) <= 1 : a === slotOf(b));

// ---------- schedule ----------

export const scheduleOf = (d: ApexData) => d.profile.schedule ?? [];
export const itemsOn = (d: ApexData, day: number, enabledOnly = true) => scheduleOf(d).filter((i) => i.day === day && (!enabledOnly || i.enabled));
/** Weekdays with an enabled basketball item. */
export const basketballDays = (d: ApexData) => [...new Set(scheduleOf(d).filter((i) => i.kind === 'basketball' && i.enabled).map((i) => i.day))].sort((a, b) => a - b);

export interface DayEntry {
  kind: ScheduleKind;
  /** 'program' = the program's gym/plyo session that day (timing from a matching item, if any). */
  source: 'program' | 'schedule';
  itemId?: string;
  templateId?: string;
  rotationId?: string;
  label?: string;
  time?: TrainingTime;
  durationMin?: number;
  intensity?: Intensity;
  enabled: boolean;
}

/**
 * The athlete's week: per day, the program's sessions plus their recurring activities, in their
 * order. One or many per day; a day with nothing enabled is a rest day. Nothing here is training.
 */
export function weeklySchedule(d: ApexData): DayEntry[][] {
  return d.plan.days.map((day, i) => {
    const items = scheduleOf(d).filter((x) => x.day === i);
    const out: DayEntry[] = [];
    for (const it of items) {
      const program = it.kind === 'gym' ? day.gym : it.kind === 'plyo' ? day.plyo : undefined;
      out.push({
        kind: it.kind, source: program ? 'program' : 'schedule', itemId: it.id, label: it.label, durationMin: it.durationMin, intensity: it.intensity, enabled: it.enabled,
        time: it.time ?? (it.kind === 'gym' ? d.profile.gymTime : undefined),
        ...(program && ('templateId' in program ? { templateId: program.templateId } : { rotationId: program.rotationId })),
      });
    }
    // program sessions without their own item still appear — the program is the source
    if (day.gym && !items.some((x) => x.kind === 'gym')) {
      out.push({ kind: 'gym', source: 'program', enabled: true, time: d.profile.gymTime, ...('templateId' in day.gym ? { templateId: day.gym.templateId } : { rotationId: day.gym.rotationId }) });
    }
    if (day.plyo && !items.some((x) => x.kind === 'plyo')) {
      out.push({ kind: 'plyo', source: 'program', enabled: true, ...('templateId' in day.plyo ? { templateId: day.plyo.templateId } : { rotationId: day.plyo.rotationId }) });
    }
    return out;
  });
}

const VALID_KINDS: ScheduleKind[] = ['basketball', 'gym', 'plyo', 'conditioning', 'other'];
const VALID_INTENSITY: Intensity[] = ['light', 'moderate', 'hard'];

/** Clean an item from the UI or storage; undefined if it can't be a schedule item. */
export function cleanItem(x: Partial<ScheduleItem> & Pick<ScheduleItem, 'id'>): ScheduleItem | undefined {
  if (!Number.isInteger(x.day) || x.day! < 0 || x.day! > 6 || !x.kind || !VALID_KINDS.includes(x.kind)) return undefined;
  const label = x.label?.trim().slice(0, 30);
  return {
    id: x.id, day: x.day!, kind: x.kind, enabled: x.enabled !== false,
    ...(label && { label }),
    ...(x.time && validTime(x.time) && { time: x.time }),
    ...(x.durationMin && Number.isFinite(x.durationMin) && x.durationMin >= 5 && x.durationMin <= 600 && { durationMin: Math.round(x.durationMin) }),
    ...(x.intensity && VALID_INTENSITY.includes(x.intensity) && { intensity: x.intensity }),
  };
}

/**
 * Backward-compatible migration, run on load. Older builds kept basketball times on the
 * program plan and "other activity" days as a flat list; both become schedule items, and the
 * plan goes back to holding only the program. Returns undefined when there is nothing to do.
 */
export function migrateAthleteContext(d: ApexData): ApexData | undefined {
  const legacy = d.profile as AthleteProfile & { otherDays?: number[] };
  if (legacy.schedule !== undefined && !d.plan.days.some((x) => x.basketball) && legacy.otherDays === undefined) return undefined;
  const items: ScheduleItem[] = [...(legacy.schedule ?? [])];
  d.plan.days.forEach((day, i) => {
    if (day.basketball && !items.some((x) => x.day === i && x.kind === 'basketball')) {
      items.push({ id: `sch-basketball-${i}`, day: i, kind: 'basketball', enabled: true, ...(isClock(day.basketball) && { time: day.basketball }) });
    }
  });
  for (const i of legacy.otherDays ?? []) if (!items.some((x) => x.day === i && x.kind === 'other')) items.push({ id: `sch-other-${i}`, day: i, kind: 'other', enabled: true });
  const profile = { ...legacy };
  delete profile.otherDays;
  return {
    ...d,
    plan: { ...d.plan, days: d.plan.days.map((day) => { const rest = { ...day }; delete rest.basketball; return rest; }) },
    profile: { ...profile, schedule: items.sort((a, b) => a.day - b.day) },
  };
}

// ---------- what is known ----------

export const BASKETBALL_LOOKBACK = 28;
const bodyweightKnown = (d: ApexData) => d.bodyMetrics.some((m) => m.kind === 'bodyweight');
const playsBasketball = (d: ApexData) => d.profile.sport === 'basketball' || (d.profile.sport === undefined && (d.basketball.length > 0 || basketballDays(d).length > 0));
const used = (d: ApexData) => d.basketball.length > 0 || d.instances.some((i) => i.status === 'completed');
const gymTimeKnown = (d: ApexData) => d.profile.gymTime !== undefined || scheduleOf(d).some((i) => i.kind === 'gym' && i.enabled && !!i.time);

export type FactKey =
  | 'goal' | 'sport' | 'units' | 'experience' | 'focus' | 'basketballDays' | 'gymDays' | 'gymTime' | 'gymAfterBasketball'
  | 'useBasketballLoad' | 'bodyweight' | 'height' | 'targets';

/** Which pieces of athlete context are known — no percentages, no "profile complete" flag. */
export function profileFacts(d: ApexData): Record<FactKey, boolean> {
  const p = d.profile;
  return {
    goal: p.goal !== undefined,
    sport: p.sport !== undefined,
    units: p.units !== undefined,
    experience: p.experience !== undefined,
    focus: p.focus !== undefined,
    basketballDays: !!p.basketballDaysConfirmedAt,
    gymDays: d.plan.days.some((day) => !!day.gym), // the program is the athlete's gym schedule
    gymTime: gymTimeKnown(d),
    gymAfterBasketball: p.gymAfterBasketball !== undefined,
    useBasketballLoad: p.useBasketballLoad !== undefined,
    bodyweight: bodyweightKnown(d),
    height: p.heightCm !== undefined,
    targets: p.targetBodyweightKg !== undefined || p.verticalTargetCm !== undefined,
  };
}

// ---------- learning from what was actually logged ----------

/**
 * Weekdays the athlete actually logs basketball on: a day counts when it has practices in at
 * least two different weeks of the last four, from at least four practices in total.
 */
export function inferBasketballDays(d: ApexData, today: ISODate): number[] | undefined {
  const since = addDays(today, -(BASKETBALL_LOOKBACK - 1));
  const dates = [...new Set(d.basketball.map((b) => b.date).filter((x) => x >= since && x <= today))];
  if (dates.length < 4) return undefined;
  const weeksByDay = new Map<number, Set<number>>();
  for (const date of dates) {
    const day = weekdayIndex(date);
    const week = Math.floor(daysBetween(since, date) / 7);
    weeksByDay.set(day, (weeksByDay.get(day) ?? new Set()).add(week));
  }
  const days = [...weeksByDay.entries()].filter(([, w]) => w.size >= 2).map(([day]) => day).sort((a, b) => a - b);
  return days.length ? days : undefined;
}

/** Usual gym start time ('HH:00') from the last four weeks, when at least 4 sessions agree within an hour. */
export function inferGymTime(instances: SessionInstance[], today: ISODate): string | undefined {
  const since = addDays(today, -(BASKETBALL_LOOKBACK - 1));
  const hours = instances
    .filter((i) => i.kind === 'gym' && i.status === 'completed' && i.startedAt && i.date >= since && i.date <= today)
    .map((i) => new Date(i.startedAt!).getHours() + new Date(i.startedAt!).getMinutes() / 60)
    .sort((a, b) => a - b);
  if (hours.length < 4) return undefined;
  const median = hours[Math.floor(hours.length / 2)];
  if (hours.filter((h) => Math.abs(h - median) <= 1).length / hours.length < 0.75) return undefined;
  return `${String(Math.round(median) % 24).padStart(2, '0')}:00`;
}

// ---------- today, from the schedule — context only ----------

/** Today's basketball as the schedule plans it, and whether a practice has actually been logged. */
export function plannedBasketball(d: ApexData, date: ISODate) {
  const item = itemsOn(d, weekdayIndex(date)).find((i) => i.kind === 'basketball');
  const logged = d.basketball.some((b) => b.date === date);
  return item ? { item, logged } : undefined;
}

/**
 * Plain notes for today's decision record, from the schedule. They explain; they never add load
 * or change a prescription — a planned practice only counts once it is logged.
 */
export function scheduleNotes(d: ApexData, date: ISODate): string[] {
  const bb = plannedBasketball(d, date);
  if (!bb || bb.logged) return [];
  const gymItem = itemsOn(d, weekdayIndex(date)).find((i) => i.kind === 'gym');
  const bbHour = hourOf(bb.item.time);
  const gymHour = hourOf(gymItem?.time ?? d.profile.gymTime);
  if (bbHour !== undefined && gymHour !== undefined && bbHour > gymHour) return ['Basketball is planned later today — it isn’t counted until you log it.'];
  if (bbHour !== undefined && bbHour < 12) return ['Basketball planned this morning isn’t logged yet — log it and Apex adjusts this session.'];
  return ['Basketball is planned today — log it after practice and Apex re-adjusts.'];
}

// ---------- contextual questions ----------

/** Where the athlete is — each place has its own short list of things worth asking there. */
export type Situation = 'launch' | 'home' | 'session' | 'practice' | 'complete' | 'body';

export interface Question {
  key: QuestionKey;
  /** Why Apex is asking: the decision this answer improves. */
  why: string;
  /** For day questions and suggestions: the days or time offered — never applied without a tap. */
  days?: number[];
  day?: number;
  time?: string;
}

const ORDER: Record<Situation, QuestionKey[]> = {
  launch: ['goal'],
  home: ['basketballToday', 'goal', 'sport', 'suggestBasketballDays', 'basketballDays', 'basketballWeekday', 'suggestGymTime', 'gymTime'],
  session: ['units', 'basketballDays', 'useBasketballLoad'],
  practice: ['basketballWeekday', 'gymAfterBasketball', 'suggestBasketballDays'],
  complete: ['focus'],
  body: ['bodyweight'],
};

/** NOT NOW backs off: ask again after 1, then 3, then 7 days; after that it's treated like SKIP. */
export const SNOOZE_DAYS = [1, 3, 7];
/** SKIP is respected — except where a decision genuinely needs the answer, and only after a long quiet period. */
export const SKIP_REASK_DAYS = 30;
const NEED: Situation[] = ['session'];
/** Home asks at most one thing per half day. */
export const HOME_COOLDOWN_H = 12;

const hoursSince = (iso: string | undefined, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Infinity);

export type QuestionState = 'unknown' | 'asked' | 'skipped' | 'known';

const KNOWN: Partial<Record<QuestionKey, (d: ApexData) => boolean>> = {
  goal: (d) => d.profile.goal !== undefined,
  sport: (d) => d.profile.sport !== undefined,
  units: (d) => d.profile.units !== undefined,
  focus: (d) => d.profile.focus !== undefined,
  gymTime: gymTimeKnown,
  basketballDays: (d) => !!d.profile.basketballDaysConfirmedAt,
  useBasketballLoad: (d) => d.profile.useBasketballLoad !== undefined,
  gymAfterBasketball: (d) => d.profile.gymAfterBasketball !== undefined,
  bodyweight: bodyweightKnown,
};

/** unknown → asked (put off) / skipped → known. A known fact is never asked again. */
export function questionState(d: ApexData, key: QuestionKey): QuestionState {
  if (KNOWN[key]?.(d)) return 'known';
  const r = d.profile.prompts?.[key];
  return !r ? 'unknown' : r.skipped || r.count > SNOOZE_DAYS.length ? 'skipped' : 'asked';
}

/** Questions about the same thing share one snooze — putting off the week also puts off "on Tuesdays?". */
const TOPIC: Partial<Record<QuestionKey, QuestionKey>> = { basketballWeekday: 'basketballDays' };

function available(d: ApexData, key: QuestionKey, situation: Situation, now: Date): boolean {
  const topic = TOPIC[key];
  if (topic && !available(d, topic, situation, now)) return false;
  const r = d.profile.prompts?.[key];
  if (!r) return true;
  if (r.skipped || r.count > SNOOZE_DAYS.length) return NEED.includes(situation) && hoursSince(r.at, now) >= SKIP_REASK_DAYS * 24;
  return hoursSince(r.at, now) >= SNOOZE_DAYS[r.count - 1] * 24;
}

const WEEKDAY = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
export const weekdayPlural = (day: number) => WEEKDAY[day];

/**
 * The one question worth asking here, now — or nothing. Every rule says what Apex needs and why;
 * anything already known (profile, schedule, program, logs) is never asked again.
 */
export function nextQuestion(d: ApexData, situation: Situation, now: Date, opts: { today: ISODate; instance?: SessionInstance }): Question | undefined {
  const p = d.profile;
  const cooling = situation === 'home' && hoursSince(p.lastPromptAt, now) < HOME_COOLDOWN_H;
  const recentBasketball = d.basketball.some((b) => b.date <= opts.today && daysBetween(b.date, opts.today) <= 3);
  const scheduled = basketballDays(d);
  const completedGym = d.instances.filter((i) => i.kind === 'gym' && i.status === 'completed').length;

  const need: Record<QuestionKey, () => Question | undefined> = {
    goal: () => (p.goal === undefined && (situation !== 'launch' || !p.prompts?.goal)
      ? { key: 'goal', why: 'Puts what matters to you first.' } : undefined),
    sport: () => (p.sport === undefined && used(d) ? { key: 'sport', why: 'So Apex only asks about the sport you play.' } : undefined),
    units: () => (p.units === undefined && opts.instance?.kind === 'gym' ? { key: 'units', why: 'Weights are shown and entered in these units.' } : undefined),
    focus: () => (p.focus === undefined && completedGym >= 2 ? { key: 'focus', why: 'Shapes what your progress highlights first.' } : undefined),
    gymTime: () => (!gymTimeKnown(d) && completedGym >= 3 && !inferGymTime(d.instances, opts.today)
      ? { key: 'gymTime', why: 'With practice times, it tells Apex which comes first on a two-session day.' } : undefined),
    basketballDays: () => {
      if (p.basketballDaysConfirmedAt || !playsBasketball(d)) return undefined;
      // in a session, only when today's plan was actually shaped by recent basketball
      if (situation === 'session' && !(recentBasketball && opts.instance && opts.instance.decision.outcome !== 'normal')) return undefined;
      if (situation === 'home' && !d.basketball.length) return undefined;
      return { key: 'basketballDays', why: 'Shown on your week. Only practices you log count as load.', days: scheduled };
    },
    basketballWeekday: () => {
      // a practice logged this week on a day the schedule doesn't have: "Do you usually play on Tuesdays?"
      const notUsual = new Set(p.basketballNotUsual ?? []);
      const recent = d.basketball.filter((b) => b.date <= opts.today && daysBetween(b.date, opts.today) <= 6).map((b) => weekdayIndex(b.date));
      const day = recent.reverse().find((x) => !scheduled.includes(x) && !notUsual.has(x));
      return day === undefined ? undefined : { key: 'basketballWeekday', why: 'Adds it to your usual week. Only practices you log count as load.', day };
    },
    useBasketballLoad: () => (p.useBasketballLoad === undefined && recentBasketball && opts.instance && opts.instance.decision.outcome !== 'normal'
      ? { key: 'useBasketballLoad', why: 'Today’s gym session was adjusted for your logged basketball.' } : undefined),
    gymAfterBasketball: () => {
      if (p.gymAfterBasketball !== undefined) return undefined;
      const practiced = d.basketball.some((b) => b.date === opts.today);
      const gymToday = d.instances.some((i) => i.kind === 'gym' && i.date === opts.today && i.status !== 'skipped');
      return practiced && gymToday ? { key: 'gymAfterBasketball', why: 'Part of your usual training day. What you log still decides the load.' } : undefined;
    },
    bodyweight: () => (!bodyweightKnown(d) ? { key: 'bodyweight', why: 'Only if you want bodyweight-based progress tracking.' } : undefined),
    basketballToday: () => {
      // practice was planned for earlier today and nothing is logged: the one number Apex is missing
      const bb = plannedBasketball(d, opts.today);
      if (!bb || bb.logged) return undefined;
      const t = bb.item.time;
      const over = t && t !== 'varies' ? (isClock(t) ? Number(t.slice(0, 2)) + 1.5 : SLOT_END[t as TimeSlot]) : 13;
      const gymLeft = d.instances.some((i) => i.date === opts.today && (i.status === 'planned' || i.status === 'active'));
      return now.getHours() >= over && gymLeft ? { key: 'basketballToday', why: 'Today’s session adjusts to it once it’s logged.' } : undefined;
    },
    suggestBasketballDays: () => {
      const days = inferBasketballDays(d, opts.today);
      if (!days) return undefined;
      const same = days.length === scheduled.length && days.every((x, i) => x === scheduled[i]);
      if (same && p.basketballDaysConfirmedAt) return undefined;
      return { key: 'suggestBasketballDays', why: 'Based on the practices you logged in the last four weeks.', days };
    },
    suggestGymTime: () => {
      const time = inferGymTime(d.instances, opts.today);
      if (!time || sameSlot(p.gymTime, time) || p.gymTime === 'varies') return undefined;
      return { key: 'suggestGymTime', why: 'Based on when you started your recent gym sessions.', time };
    },
  };

  for (const key of ORDER[situation]) {
    // today's missing practice is about today, not about the profile: it skips the Home cooldown
    if (cooling && key !== 'basketballToday') continue;
    if (key === 'basketballToday') {
      const r = p.prompts?.basketballToday;
      if (r && toISODate(new Date(r.at)) === opts.today) continue; // put off for today only
    } else if (situation !== 'launch' && !available(d, key, situation, now)) continue;
    const q = need[key]();
    if (q) return q;
  }
  return undefined;
}

// ---------- adaptation input ----------

/**
 * What the adaptation engine sees. Profile context never adds load: only logged sessions count,
 * and a planned basketball day with nothing logged is no load at all. The athlete can opt out of
 * basketball shaping gym sessions; logged practices still count everywhere else.
 */
export const adaptationData = (d: ApexData): ApexData => (d.profile.useBasketballLoad === false ? { ...d, basketball: [] } : d);
