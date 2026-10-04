// Recent training context → per-area strain. Pure and deterministic.
//
//   today      load already done today (sessions completed or logged before the planned one)
//   residual   load above the athlete's normal day over the previous 4 days, fading with time
//   accumulation  the 7-day total when it runs above the athlete's own baseline
//
// score = today + residual + accumulation, in units of "one hard day" for that area.
import { APEX_CONFIG, type ApexConfig } from './config';
import { bandFor, bandFromLevel, bandRank, dayLoads, maxBand, readinessScore, type DayLoad } from './load';
import type { ApexData, AreaStrainSnapshot, BasketballSession, BodyArea, ISODate, LoadBand, MuscleGroup, RecoveryLog, SessionInstance } from './types';
import { clamp, daysBetween, sum } from './util';
import { scheduleNotes } from './profile';
import { weeklySets } from './volume';

/** Everything the engine looks at. Built from stored data, or from raw sessions in tests. */
export interface TrainingContext {
  date: ISODate;
  days: DayLoad[]; // [0] = date (today) … [27]
  historyDays: number; // days of logged history up to and including today
  todayBasketball: BasketballSession[];
  recovery?: RecoveryLog;
  priorDayBand: LoadBand;
  weeklySets: Record<MuscleGroup, number>;
  /** Notes from the athlete's schedule for today. Explanation only: they never add load. */
  planned: string[];
}

export function contextFromSessions(input: { date: ISODate; basketball?: BasketballSession[]; instances?: SessionInstance[]; recovery?: RecoveryLog; planned?: string[] }, cfg: ApexConfig = APEX_CONFIG): TrainingContext {
  const basketball = input.basketball ?? [];
  const instances = input.instances ?? [];
  const days = dayLoads({ basketball, instances }, input.date, cfg.history, cfg);
  const dates = [...basketball.map((b) => b.date), ...instances.filter((i) => i.status === 'completed').map((i) => i.date)].filter((d) => d <= input.date);
  const earliest = dates.sort()[0];
  return {
    date: input.date,
    days,
    historyDays: earliest ? daysBetween(earliest, input.date) + 1 : 0,
    todayBasketball: basketball.filter((b) => b.date === input.date),
    recovery: input.recovery,
    priorDayBand: bandFor(days[1]?.total ?? 0, cfg.dailyBands),
    weeklySets: weeklySets(instances, input.date),
    planned: input.planned ?? [],
  };
}

export const buildContext = (data: ApexData, date: ISODate, cfg: ApexConfig = APEX_CONFIG) =>
  contextFromSessions({ date, basketball: data.basketball, instances: data.instances, recovery: data.recovery.find((r) => r.date === date), planned: scheduleNotes(data, date) }, cfg);

// ---------- windows ----------

const at = (d: DayLoad | undefined, a: BodyArea) => d?.areas[a] ?? 0;
const range = (days: DayLoad[], a: BodyArea, from: number, to: number) => sum(days.slice(from, to + 1).map((d) => at(d, a)));

/** Sums over the days before today (today itself is separate). d7 = the 7 days before today. */
export interface LoadWindows { today: number; d1: number; d3: number; d7: number; d14: number; d28: number }

export function loadWindows(days: DayLoad[], area: BodyArea, cfg: ApexConfig = APEX_CONFIG): LoadWindows {
  const w = cfg.windows;
  return {
    today: at(days[0], area),
    d1: range(days, area, 1, w.d1),
    d3: range(days, area, 1, w.d3),
    d7: range(days, area, 1, w.d7),
    d14: range(days, area, 1, w.d14),
    d28: range(days, area, 1, w.d28),
  };
}

/** The athlete's usual week for an area: weeks 2–4 back once there's enough history. */
export function weeklyBaseline(days: DayLoad[], area: BodyArea, historyDays: number, cfg: ApexConfig = APEX_CONFIG) {
  const fallback = cfg.defaultWeekly[area];
  if (historyDays < cfg.minHistoryDays) return { weekly: fallback, fromHistory: false };
  const last = Math.min(cfg.history, historyDays) - 1;
  const span = last - 7 + 1;
  if (span < 7) return { weekly: fallback, fromHistory: false };
  const weekly = (range(days, area, 7, last) / span) * 7;
  return { weekly: Math.max(weekly, fallback * 0.5), fromHistory: true };
}

export type Trend = 'up' | 'flat' | 'down';

export interface AreaStrain extends AreaStrainSnapshot {
  area: BodyArea;
  residual: number;
  accumulation: number;
  accumulated: LoadBand; // 7-day load vs the athlete's baseline
  trend: Trend;
  prev7: number;
  repeatSets: number; // direct working sets in the last 2 days (gym)
}

export function areaStrain(ctx: TrainingContext, area: BodyArea, cfg: ApexConfig = APEX_CONFIG): AreaStrain {
  const { days } = ctx;
  const ref = cfg.dayRef[area];
  const base = weeklyBaseline(days, area, ctx.historyDays, cfg);
  const normal = base.weekly / 7;
  const today = at(days[0], area);
  const residual = sum(cfg.residualWeights.map((w, k) => Math.max(0, at(days[k + 1], area) - normal) * w)) / ref;
  const acute7 = range(days, area, 0, 6);
  const prev7 = range(days, area, 7, 13);
  const ratio = acute7 / base.weekly;
  const acc = cfg.accumulation;
  const accumulation = Math.min(acc.cap, Math.max(0, ratio - acc.ratioStart) * acc.weight);
  const repeatSets = (days[1]?.directSets[area] ?? 0) + (days[2]?.directSets[area] ?? 0) * 0.5;
  const repeat = repeatSets >= cfg.repeatMuscle.sets ? cfg.repeatMuscle.strain : 0;
  const score = today / ref + residual + accumulation + repeat;
  const b = cfg.bands;
  const ab = cfg.accumulatedBands;
  const change = prev7 > 0 ? (acute7 - prev7) / prev7 : acute7 > 0 ? 1 : 0;
  return {
    area,
    score: round2(score),
    band: bandFor(score, [b.moderate, b.high, b.extreme]),
    today: Math.round(today),
    acute7: Math.round(acute7),
    baseline: Math.round(base.weekly),
    ratio: round2(ratio),
    residual: round2(residual),
    accumulation: round2(accumulation),
    accumulated: bandFor(ratio, [ab.moderate, ab.high, ab.extreme]),
    trend: change > cfg.trend.change ? 'up' : change < -cfg.trend.change ? 'down' : 'flat',
    prev7: Math.round(prev7),
    repeatSets,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

const ALL_AREAS: BodyArea[] = [
  'lower', 'quads', 'hamstrings', 'glutes', 'calves', 'elastic',
  'upper', 'chest', 'back', 'shoulders', 'biceps', 'triceps',
  'trunk', 'jump', 'sprint', 'cod', 'explosive',
];

export interface Strain {
  areas: Record<BodyArea, AreaStrain>;
  /** Region summary used across the app (kept compatible with earlier phases). */
  bands: { lower: LoadBand; upper: LoadBand; jump: LoadBand; systemic: LoadBand };
  readiness?: number;
  /** Multiplies every reduction: < 1 good recovery, > 1 poor. 1 without a check-in. */
  recoveryScale: number;
}

/** Raise an area to at least `floor` (self-reported fatigue / soreness): the athlete knows something the numbers don't. */
function floorTo(s: AreaStrain, floor: LoadBand, cfg: ApexConfig): AreaStrain {
  if (bandRank(floor) <= bandRank(s.band)) return s;
  const b = cfg.bands;
  const min = floor === 'extreme' ? b.extreme : floor === 'high' ? b.high : b.moderate;
  return { ...s, band: floor, score: Math.max(s.score, min) };
}

export function computeStrain(ctx: TrainingContext, cfg: ApexConfig = APEX_CONFIG): Strain {
  const areas = Object.fromEntries(ALL_AREAS.map((a) => [a, areaStrain(ctx, a, cfg)])) as Record<BodyArea, AreaStrain>;
  const reportedLower = ctx.todayBasketball.reduce<LoadBand>((acc, b) => maxBand(acc, bandFromLevel(b.lowerFatigue)), 'low');
  const reportedUpper = ctx.todayBasketball.reduce<LoadBand>((acc, b) => maxBand(acc, bandFromLevel(b.upperFatigue)), 'low');
  const sore: LoadBand = (ctx.recovery?.soreness ?? 0) >= 4 ? 'moderate' : 'low';
  areas.lower = floorTo(floorTo(areas.lower, reportedLower, cfg), sore, cfg);
  areas.upper = floorTo(floorTo(areas.upper, reportedUpper, cfg), sore, cfg);
  areas.jump = floorTo(areas.jump, reportedLower === 'high' ? 'moderate' : 'low', cfg);

  const readiness = readinessScore(ctx.recovery, ctx.priorDayBand, cfg);
  const r = cfg.adaptation.recovery;
  const recoveryScale = readiness === undefined ? 1 : round2(clamp(1 + (r.pivot - readiness) * r.perPoint, ...r.clamp));
  const systemic = bandFor(ctx.days[0]?.total ?? 0, cfg.dailyBands);
  return {
    areas,
    bands: { lower: areas.lower.band, upper: areas.upper.band, jump: areas.jump.band, systemic },
    readiness,
    recoveryScale,
  };
}

/** Volume to remove at a given strain score, before per-exercise weighting. */
export function reductionFor(score: number, cfg: ApexConfig = APEX_CONFIG) {
  const r = cfg.adaptation.reduction;
  return clamp((score - r.start) * r.slope, 0, r.max);
}
