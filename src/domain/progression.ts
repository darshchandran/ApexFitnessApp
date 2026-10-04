// Double progression on the prescribed rep range. Every recommendation says why.
import { MUSCLE_AREA } from './areas';
import { APEX_CONFIG, type ApexConfig } from './config';
import { atLeast, bandFor, maxBand } from './load';
import type { AdaptationDecision, Exercise, LoadBand, SetLog } from './types';
import { roundTo } from './util';

export type ProgressionAction = 'establish' | 'increase' | 'add_reps' | 'maintain' | 'decrease' | 'hold';

export interface Recommendation {
  action: ProgressionAction;
  weight?: number;
  reps: number;
  reason: string;
}

const fmtKg = (w: number) => `${+w.toFixed(2)} kg`;

export function describeSets(sets: SetLog[]) {
  const reps = sets.map((s) => s.reps).join('/');
  const rirs = sets.map((s) => s.rir).filter((r): r is number => r !== undefined);
  if (!rirs.length) return reps;
  const lo = Math.min(...rirs);
  const hi = Math.max(...rirs);
  return `${reps} @ ${lo === hi ? lo : `${lo}–${hi}`} RIR`;
}

/**
 * `fatigue` is the context for the area this lift trains: today's strain band and the 7-day
 * load relative to the athlete's usual week. A hard basketball week holds the load steady
 * instead of pushing it — and doesn't read a tired session as lost strength.
 */
export function recommendProgression(args: {
  repRange: [number, number];
  increment: number;
  previous: SetLog[];
  loadBand?: LoadBand;
  fatigue?: { band: LoadBand; accumulated?: LoadBand };
}, cfg: ApexConfig = APEX_CONFIG): Recommendation {
  const [lo, hi] = args.repRange;
  const prev = args.previous.filter((s) => s.kind === 'working');
  if (!prev.length) {
    return { action: 'establish', reps: hi, reason: `No history yet — pick a weight you can move for ${lo}–${hi} reps at 2 RIR.` };
  }
  const weight = Math.max(...prev.map((s) => s.weight));
  const top = prev.filter((s) => s.weight === weight);
  const minReps = Math.min(...top.map((s) => s.reps));
  const minRir = Math.min(...top.map((s) => s.rir ?? 1));
  const summary = describeSets(top);
  const band = args.fatigue?.band ?? args.loadBand ?? 'low';
  const accumulated = args.fatigue?.accumulated ?? 'low';
  const highToday = atLeast(band, cfg.progression.holdAtBand);
  const highWeek = atLeast(accumulated, cfg.progression.holdAtAccumulated);
  const busy = highToday || highWeek;
  const why = highToday ? 'recent load on this area is high' : 'this week’s load is above your usual';

  if (minReps >= hi && minRir >= 1) {
    if (busy || args.increment <= 0) {
      return { action: 'hold', weight, reps: hi, reason: busy ? `${summary} earns an increase, but ${why} — hold ${fmtKg(weight)} today.` : `${summary} — top of range. Hold ${fmtKg(weight)}.` };
    }
    const next = +(weight + args.increment).toFixed(2); // step from the athlete's own weight, not a fixed grid (12.5 + 2 → 14.5)
    return { action: 'increase', weight: next, reps: lo, reason: `${summary} — top of range with reps in reserve. +${fmtKg(next - weight)}.` };
  }
  if (minReps >= hi) {
    return { action: 'maintain', weight, reps: hi, reason: `${summary} — top of range but at failure. Repeat ${fmtKg(weight)} with a rep in reserve before adding load.` };
  }
  if (minReps < lo && top[0].reps < lo && busy) {
    // under heavy recent load a short set is more likely fatigue than lost strength
    return { action: 'maintain', weight, reps: lo, reason: `${summary} — ${why}, so likely fatigue. Keep ${fmtKg(weight)} and aim for ${lo}+.` };
  }
  if (minReps < lo && top[0].reps < lo) {
    const next = Math.max(0, roundTo(weight * 0.95, args.increment || 0.5));
    return { action: 'decrease', weight: next, reps: lo, reason: `${summary} — first set fell below ${lo}. Drop to ${fmtKg(next)} and rebuild.` };
  }
  if (minReps < lo || minRir === 0) {
    return { action: 'maintain', weight, reps: lo, reason: `${summary} — keep ${fmtKg(weight)} and aim for ${lo}+ on every set.` };
  }
  return { action: 'add_reps', weight, reps: Math.min(hi, minReps + 1), reason: `${summary} — inside ${lo}–${hi}. Keep ${fmtKg(weight)} and add a rep per set.` };
}

/** Fatigue context for one lift, read from the session's recorded decision. */
export function fatigueFor(d: AdaptationDecision, ex: Exercise, cfg: ApexConfig = APEX_CONFIG): { band: LoadBand; accumulated: LoadBand } {
  const region = ex.region === 'lower' ? 'lower' : ex.region === 'upper' ? 'upper' : 'trunk';
  const snap = d.inputs?.strain;
  const regionBand = snap?.[region]?.band ?? (region === 'trunk' ? d.bands.upper : d.bands[region]);
  const band = maxBand(regionBand, snap?.[MUSCLE_AREA[ex.primary]]?.band ?? 'low');
  const ab = cfg.accumulatedBands;
  const accumulated = snap?.[region] ? bandFor(snap[region]!.ratio, [ab.moderate, ab.high, ab.extreme]) : 'low';
  return { band, accumulated };
}
