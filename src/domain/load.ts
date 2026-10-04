// Training load per session, split across body areas. Arbitrary units — Apex's internal
// training-management metric, NOT a validated physiological measurement. All weights: config.ts.
import { addAreas, exerciseAreaShares, MUSCLE_AREA } from './areas';
import { gymExercise, plyoExercise } from './catalog';
import { APEX_CONFIG, type ApexConfig } from './config';
import { e1rm } from './records';
import type {
  ApexData, AreaLoad, BasketballSession, BodyArea, DailyLoad, ISODate, Level, LoadBand, PlyoLog, PlyometricExercise,
  PlyometricInstance, PlyometricTemplate, RecoveryLog, SessionInstance, WorkoutInstance,
} from './types';
import { addDays, clamp, daysBetween, sum } from './util';

const BANDS: LoadBand[] = ['low', 'moderate', 'high', 'extreme'];
export const bandFor = (value: number, [m, h, e]: number[]): LoadBand =>
  value >= e ? 'extreme' : value >= h ? 'high' : value >= m ? 'moderate' : 'low';
export const bandRank = (b: LoadBand) => BANDS.indexOf(b);
export const maxBand = (a: LoadBand, b: LoadBand) => (bandRank(a) >= bandRank(b) ? a : b);
export const atLeast = (b: LoadBand, min: LoadBand) => bandRank(b) >= bandRank(min);
export const bandFromLevel = (l: Level | undefined): LoadBand => (l === 3 ? 'high' : l === 2 ? 'moderate' : 'low');

// ---------- Basketball ----------

export function basketballMovement(s: BasketballSession, cfg: ApexConfig = APEX_CONFIG) {
  const d = cfg.basketball.typeDefaults[s.sessionType ?? 'mixed'];
  return {
    running: s.running ?? d.running,
    sprinting: s.sprinting ?? d.sprinting,
    jumping: s.jumping ?? d.jumping,
    changeOfDirection: s.changeOfDirection ?? d.changeOfDirection,
  };
}

/** Uses whatever the athlete entered; missing movement fields fall back to the session type. */
export function basketballLoad(s: BasketballSession, cfg: ApexConfig = APEX_CONFIG) {
  const b = cfg.basketball;
  const m = basketballMovement(s, cfg);
  const total = s.rpe * s.durationMin * b.typeIntensity[s.sessionType ?? 'mixed'];
  const lowerShare = clamp(b.lowerShareBase + b.lowerSharePerLevel * (m.jumping + m.sprinting + m.changeOfDirection), b.lowerShareBase, b.lowerShareMax);
  const lower = total * lowerShare;
  const upper = total * (1 - lowerShare);
  const areas: AreaLoad = { lower };
  const weights = Object.entries(b.lowerSplit).map(([area, w]) => {
    let v = w.base;
    for (const k of ['jumping', 'sprinting', 'changeOfDirection', 'running'] as const) v += (w[k] ?? 0) * m[k];
    return [area as BodyArea, v] as const;
  });
  const wSum = sum(weights.map(([, v]) => v));
  for (const [area, v] of weights) areas[area] = (lower * v) / wSum;
  areas.trunk = upper * b.trunkShare;
  areas.upper = upper * (1 - b.trunkShare);
  for (const [area, share] of Object.entries(b.upperSplit)) areas[area as BodyArea] = areas.upper * share;
  const jumps = s.durationMin * b.jumpsPerMinute[m.jumping];
  const sprints = s.durationMin * b.sprintsPerMinute[m.sprinting];
  const cuts = s.durationMin * b.cutsPerMinute[m.changeOfDirection];
  Object.assign(areas, { jump: jumps, sprint: sprints, cod: cuts, explosive: jumps + sprints + cuts });
  return { total, lower, upper, jumps, lowerShare, areas };
}

// ---------- Gym ----------

const workingSets = (w: WorkoutInstance) =>
  w.exercises.filter((e) => e.status !== 'removed').flatMap((e) => e.sets.filter((s) => s.kind === 'working').map((s) => ({ e, s })));

export function gymVolume(w: WorkoutInstance) {
  const sets = workingSets(w);
  return {
    workingSets: sets.length,
    // load × reps; timed sets (carries) contribute sets but not tonnage
    volumeLoad: sum(sets.map(({ e, s }) => (gymExercise(e.exerciseId).unit === 'sec' ? 0 : s.weight * s.reps))),
  };
}

/**
 * Per working set: base × effort (RIR) × reps × exercise cost × relative intensity (when the
 * athlete has a previous best on the lift). Spread over the areas the exercise trains.
 */
export function gymLoad(w: WorkoutInstance, opts: { bestE1rm?: (exerciseId: string) => number | undefined } = {}, cfg: ApexConfig = APEX_CONFIG) {
  const g = cfg.gym;
  const out = { total: 0, lower: 0, upper: 0, core: 0, lowerSets: 0, areas: {} as AreaLoad, directSets: {} as AreaLoad };
  for (const { e, s } of workingSets(w)) {
    const ex = gymExercise(e.exerciseId);
    const effort = clamp(1 + (g.rirReference - (s.rir ?? g.rirReference)) * g.perRir, ...g.effortClamp);
    const best = ex.unit === 'sec' ? undefined : opts.bestE1rm?.(e.exerciseId);
    const intensity = best && s.weight > 0 ? clamp(e1rm(s.weight, s.reps) / best, ...g.intensityClamp) : 1;
    const au = g.auPerSet * effort * g.repMod(s.reps) * g.costMod[ex.fatigueCost] * intensity;
    out.total += au;
    out[ex.region] += au;
    if (ex.region === 'lower') out.lowerSets += 1;
    addAreas(out.areas, exerciseAreaShares(ex, g.primaryShare, g.secondaryShare), au);
    const direct = MUSCLE_AREA[ex.primary];
    out.directSets[direct] = (out.directSets[direct] ?? 0) + 1;
  }
  return out;
}

// ---------- Plyometrics ----------

export const contactsFor = (sets: number, reps: number, perSide: boolean) => sets * reps * (perSide ? 2 : 1);

/** Landings in one logged set: per-side work counts both sides unless a single side was logged. */
export const logContacts = (l: PlyoLog, perSide: boolean) => l.reps * (perSide && !l.side ? 2 : 1);

/** Completed sets: a single-side log is half of a per-side set. */
export const plyoSetsDone = (logs: PlyoLog[]) => logs.reduce((n, l) => n + (l.side ? 0.5 : 1), 0);

export const templateContacts = (t: PlyometricTemplate) =>
  sum(t.exercises.map((e) => contactsFor(e.sets, e.reps, e.perSide)));

export const prescribedContacts = (p: PlyometricInstance) =>
  sum(p.exercises.filter((e) => e.status !== 'removed').map((e) => contactsFor(e.prescribed.sets, e.prescribed.reps, e.prescribed.perSide)));

/** Depth / drop style work: high-intensity reactive landings. */
export const isShock = (ex: PlyometricExercise) => ex.intensity === 3 && ex.categories.includes('reactive');

/** Per-contact weight: intensity tier × shock × single-leg × measured height. */
export function contactWeight(ex: PlyometricExercise, perSide: boolean, value: number | undefined, cfg: ApexConfig = APEX_CONFIG) {
  const p = cfg.plyo;
  const high = value !== undefined && (ex.metric === 'jumpHeight' || ex.metric === 'height') && value >= p.highJumpCm;
  return p.intensity[ex.intensity] * (isShock(ex) ? p.reactive : 1) * (ex.unilateral || perSide ? p.unilateral : 1) * (high ? p.highJump : 1);
}

export function plyoLoad(p: PlyometricInstance, cfg: ApexConfig = APEX_CONFIG) {
  let contacts = 0;
  let au = 0;
  let weighted = 0;
  let lateral = 0;
  const rpe = p.sessionRpe ? cfg.plyo.rpe(p.sessionRpe) : 1;
  for (const e of p.exercises) {
    const ex = plyoExercise(e.exerciseId);
    for (const l of e.logs) {
      const c = logContacts(l, e.prescribed.perSide);
      const w = contactWeight(ex, e.prescribed.perSide, l.value, cfg) * rpe;
      contacts += c;
      weighted += c * w;
      au += c * cfg.plyo.auPerContact * w;
      if (ex.categories.includes('lateral')) lateral += c * w;
    }
  }
  const areas: AreaLoad = { lower: au, jump: weighted, explosive: weighted, cod: lateral };
  for (const [area, share] of Object.entries(cfg.plyo.areaSplit)) areas[area as BodyArea] = au * share;
  return { contacts, au, areas };
}

// ---------- Daily series ----------

export interface SessionNote {
  date: ISODate;
  kind: 'basketball' | 'gym' | 'plyometric';
  label: string; // "Basketball 90 min @ RPE 9", "Legs", "Max Power"
  at: string; // sort key within the day
  areas: AreaLoad;
}

export interface DayLoad {
  date: ISODate;
  areas: AreaLoad;
  directSets: AreaLoad; // gym working sets by primary area
  basketball: number;
  gym: number;
  plyo: number;
  total: number;
  sessions: SessionNote[];
}

/** Best e1RM per lift from sessions completed before `date` — for relative intensity. */
function bestsBefore(instances: SessionInstance[]) {
  const rows: { date: ISODate; id: string; e1: number }[] = [];
  for (const i of instances) {
    if (i.kind !== 'gym' || i.status !== 'completed') continue;
    for (const e of i.exercises) for (const s of e.sets) if (s.kind === 'working' && s.weight > 0) rows.push({ date: i.date, id: e.exerciseId, e1: e1rm(s.weight, s.reps) });
  }
  return (date: ISODate) => (id: string) => {
    let best: number | undefined;
    for (const r of rows) if (r.id === id && r.date < date && (best === undefined || r.e1 > best)) best = r.e1;
    return best;
  };
}

/**
 * One entry per day, newest first: [0] = `date`, [1] = the day before … Only completed
 * sessions and logged basketball count — planned work is never load.
 */
export function dayLoads(input: { basketball: BasketballSession[]; instances: SessionInstance[] }, date: ISODate, days: number, cfg: ApexConfig = APEX_CONFIG): DayLoad[] {
  const out: DayLoad[] = Array.from({ length: days }, (_, k) => ({
    date: addDays(date, -k), areas: {}, directSets: {}, basketball: 0, gym: 0, plyo: 0, total: 0, sessions: [],
  }));
  const slot = (d: ISODate) => {
    const k = daysBetween(d, date);
    return k >= 0 && k < days ? out[k] : undefined;
  };
  for (const b of input.basketball) {
    const day = slot(b.date);
    if (!day) continue;
    const l = basketballLoad(b, cfg);
    addAreas(day.areas, l.areas);
    day.basketball += l.total;
    day.sessions.push({ date: b.date, kind: 'basketball', label: `Basketball ${b.durationMin} min @ RPE ${b.rpe}`, at: b.loggedAt, areas: l.areas });
  }
  const best = bestsBefore(input.instances);
  for (const i of input.instances) {
    if (i.status !== 'completed') continue;
    const day = slot(i.date);
    if (!day) continue;
    if (i.kind === 'gym') {
      const l = gymLoad(i, { bestE1rm: best(i.date) }, cfg);
      addAreas(day.areas, l.areas);
      addAreas(day.directSets, l.directSets);
      day.gym += l.total;
      day.sessions.push({ date: i.date, kind: 'gym', label: i.templateName, at: i.completedAt ?? i.date, areas: l.areas });
    } else {
      const l = plyoLoad(i, cfg);
      addAreas(day.areas, l.areas);
      day.plyo += l.au;
      day.sessions.push({ date: i.date, kind: 'plyometric', label: i.templateName, at: i.completedAt ?? i.date, areas: l.areas });
    }
  }
  for (const d of out) {
    d.total = d.basketball + d.gym + d.plyo;
    d.sessions.sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}

export function dailyLoad(data: ApexData, date: ISODate, cfg: ApexConfig = APEX_CONFIG): DailyLoad {
  const [d] = dayLoads(data, date, 1, cfg);
  return { date, basketball: Math.round(d.basketball), gym: Math.round(d.gym), plyo: Math.round(d.plyo), total: Math.round(d.total), band: bandFor(d.total, cfg.dailyBands) };
}

export function weekLoad(data: ApexData, endDate: ISODate, cfg: ApexConfig = APEX_CONFIG): DailyLoad[] {
  return dayLoads(data, endDate, 7, cfg).reverse().map((d) => ({
    date: d.date, basketball: Math.round(d.basketball), gym: Math.round(d.gym), plyo: Math.round(d.plyo), total: Math.round(d.total), band: bandFor(d.total, cfg.dailyBands),
  }));
}

/** 0–100 recovery check-in score. Undefined until the athlete checks in. */
export function readinessScore(r: RecoveryLog | undefined, priorDay: LoadBand, cfg: ApexConfig = APEX_CONFIG): number | undefined {
  if (!r) return undefined;
  const c = cfg.readiness;
  const sleep = Math.min(c.sleepMax, Math.max(0, c.sleepTarget - r.sleepHours) * c.perHourShort);
  const score = 100 - sleep - (r.soreness - 1) * c.perSoreness - (5 - r.energy) * c.perEnergy - c.priorDay[priorDay];
  return Math.round(clamp(score, 0, 100));
}
