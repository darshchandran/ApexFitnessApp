import { gymExercise, plyoExercise } from './catalog';
import { e1rm } from './records';
import type { ISODate, Muscle, PlyoLog, SessionInstance, SetLog, WorkoutInstance } from './types';
import { addDays } from './util';

const newestFirst = (a: SessionInstance, b: SessionInstance) =>
  (b.completedAt ?? b.date).localeCompare(a.completedAt ?? a.date);

export const completed = (instances: SessionInstance[]) => instances.filter((i) => i.status === 'completed').sort(newestFirst);

/** Most recent completed working sets for an exercise, excluding `excludeId` (the live session). */
export function previousPerformance(instances: SessionInstance[], exerciseId: string, excludeId?: string):
  { date: ISODate; instanceId: string; sets: SetLog[] } | undefined {
  for (const i of completed(instances)) {
    if (i.id === excludeId || i.kind !== 'gym') continue;
    const sets = i.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets.filter((s) => s.kind === 'working'));
    if (sets.length) return { date: i.date, instanceId: i.id, sets };
  }
  return undefined;
}

export function previousPlyo(instances: SessionInstance[], exerciseId: string, excludeId?: string):
  { date: ISODate; logs: PlyoLog[] } | undefined {
  for (const i of completed(instances)) {
    if (i.id === excludeId || i.kind !== 'plyometric') continue;
    const logs = i.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.logs);
    if (logs.length) return { date: i.date, logs };
  }
  return undefined;
}

/** Hard sets per muscle over the 7 days ending `end` (secondary muscles count half). */
export function weeklySetsByMuscle(instances: SessionInstance[], end: ISODate) {
  const start = addDays(end, -6);
  const out = new Map<Muscle, { sets: number; sessions: Set<string> }>();
  const bump = (m: Muscle, n: number, id: string) => {
    const cur = out.get(m) ?? { sets: 0, sessions: new Set<string>() };
    cur.sets += n;
    cur.sessions.add(id);
    out.set(m, cur);
  };
  for (const i of instances) {
    if (i.kind !== 'gym' || i.status !== 'completed' || i.date < start || i.date > end) continue;
    for (const e of i.exercises) {
      const n = e.sets.filter((s) => s.kind === 'working').length;
      if (!n) continue;
      const ex = gymExercise(e.exerciseId);
      bump(ex.primary, n, i.id);
      for (const m of ex.secondary ?? []) bump(m, n / 2, i.id);
    }
  }
  return [...out.entries()]
    .map(([muscle, v]) => ({ muscle, sets: v.sets, frequency: v.sessions.size }))
    .sort((a, b) => b.sets - a.sets);
}

/** Best e1RM per completed session for an exercise, oldest first. */
export function strengthTrend(instances: SessionInstance[], exerciseId: string) {
  return completed(instances)
    .filter((i): i is WorkoutInstance => i.kind === 'gym')
    .flatMap((i) => {
      const sets = i.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets.filter((s) => s.kind === 'working'));
      if (!sets.length) return [];
      const best = Math.max(...sets.map((s) => e1rm(s.weight, s.reps)));
      return [{ date: i.date, e1rm: Math.round(best * 10) / 10, topWeight: Math.max(...sets.map((s) => s.weight)) }];
    })
    .reverse();
}

/** Exercises with at least one logged working set, most recently trained first. */
export function trainedExercises(instances: SessionInstance[]) {
  const seen = new Map<string, string>();
  for (const i of completed(instances)) {
    if (i.kind !== 'gym') continue;
    for (const e of i.exercises) if (e.sets.some((s) => s.kind === 'working') && !seen.has(e.exerciseId)) seen.set(e.exerciseId, gymExercise(e.exerciseId).name);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/** Best measured value per plyometric exercise (cm). */
export function plyoBests(instances: SessionInstance[]) {
  const best = new Map<string, number>();
  for (const i of instances) {
    if (i.kind !== 'plyometric' || i.status !== 'completed') continue;
    for (const e of i.exercises) for (const l of e.logs) {
      if (l.value !== undefined && l.value > (best.get(e.exerciseId) ?? -Infinity)) best.set(e.exerciseId, l.value);
    }
  }
  return [...best.entries()].map(([id, value]) => ({ id, name: plyoExercise(id).name, metric: plyoExercise(id).metric!, value }));
}
