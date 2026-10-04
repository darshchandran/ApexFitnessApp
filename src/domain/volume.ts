// Weekly working-set volume per muscle group against configurable hypertrophy targets.
// Programming volume tracking — not a measure of physiological stimulus.
import { MUSCLE_GROUP } from './areas';
import { gymExercise } from './catalog';
import { APEX_CONFIG, type ApexConfig } from './config';
import type { ISODate, MuscleGroup, SessionInstance } from './types';
import { addDays } from './util';

export const MUSCLE_GROUPS: MuscleGroup[] = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes', 'calves', 'core'];
export type VolumeStatus = 'under' | 'in range' | 'high';

export const volumeStatus = (sets: number, [lo, hi]: [number, number]): VolumeStatus => (sets < lo ? 'under' : sets > hi ? 'high' : 'in range');

/** Working sets per group over the 7 days ending `end`: direct sets count 1, secondary muscles ½. */
export function weeklySets(instances: SessionInstance[], end: ISODate): Record<MuscleGroup, number> {
  const start = addDays(end, -6);
  const out = Object.fromEntries(MUSCLE_GROUPS.map((g) => [g, 0])) as Record<MuscleGroup, number>;
  for (const i of instances) {
    if (i.kind !== 'gym' || i.status !== 'completed' || i.date < start || i.date > end) continue;
    for (const e of i.exercises) {
      const n = e.sets.filter((s) => s.kind === 'working').length;
      if (!n) continue;
      const ex = gymExercise(e.exerciseId);
      // a set counts once per group even if two of its muscles share a group (e.g. lats + upper back)
      const groups = new Map<MuscleGroup, number>([[MUSCLE_GROUP[ex.primary], 1]]);
      for (const m of ex.secondary ?? []) if (!groups.has(MUSCLE_GROUP[m])) groups.set(MUSCLE_GROUP[m], 0.5);
      for (const [g, w] of groups) out[g] += n * w;
    }
  }
  return out;
}

export function muscleVolume(instances: SessionInstance[], end: ISODate, cfg: ApexConfig = APEX_CONFIG) {
  const sets = weeklySets(instances, end);
  const start = addDays(end, -6);
  return MUSCLE_GROUPS.map((group) => {
    const sessions = new Set(instances.filter((i) => i.kind === 'gym' && i.status === 'completed' && i.date >= start && i.date <= end &&
      i.exercises.some((e) => e.sets.some((s) => s.kind === 'working') && MUSCLE_GROUP[gymExercise(e.exerciseId).primary] === group)).map((i) => i.id));
    const target = cfg.weeklySetTargets[group];
    return { group, sets: Math.round(sets[group] * 2) / 2, frequency: sessions.size, target, status: volumeStatus(sets[group], target) };
  });
}
