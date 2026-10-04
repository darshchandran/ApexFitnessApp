import { gymExercise, plyoExercise } from './catalog';
import type { PersonalRecord, PRKind, SessionInstance, SetLog } from './types';
import { sum, uid } from './util';

/** Epley estimated one-rep max. */
export const e1rm = (weight: number, reps: number) => (reps <= 1 ? weight : weight * (1 + reps / 30));

const r1 = (x: number) => Math.round(x * 10) / 10;
const kg = (w: number) => `${+w.toFixed(2)} kg`;

const workingSetsFor = (history: SessionInstance[], exerciseId: string): SetLog[][] =>
  history.flatMap((i) =>
    i.kind === 'gym'
      ? i.exercises.filter((e) => e.exerciseId === exerciseId).map((e) => e.sets.filter((s) => s.kind === 'working'))
      : [],
  ).filter((s) => s.length > 0);

/**
 * PRs set by `instance` against completed `history`. The first time an exercise is
 * logged it is a baseline, not a record.
 */
export function detectPRs(instance: SessionInstance, history: SessionInstance[]): PersonalRecord[] {
  const prior = history.filter((h) => h.id !== instance.id && h.status === 'completed');
  const out: PersonalRecord[] = [];
  const add = (exerciseId: string, exerciseName: string, kind: PRKind, value: number, previous: number, detail: string) =>
    out.push({ id: uid('pr'), date: instance.date, instanceId: instance.id, exerciseId, exerciseName, kind, value, previous, detail });

  if (instance.kind === 'gym') {
    for (const ex of instance.exercises) {
      const today = ex.sets.filter((s) => s.kind === 'working');
      const before = workingSetsFor(prior, ex.exerciseId);
      if (!today.length || !before.length) continue;
      const timed = gymExercise(ex.exerciseId).unit === 'sec';
      const prevSets = before.flat();

      const bestW = Math.max(...today.map((s) => s.weight));
      const prevW = Math.max(...prevSets.map((s) => s.weight));
      if (bestW > prevW) {
        const s = today.find((x) => x.weight === bestW)!;
        add(ex.exerciseId, ex.name, 'weight', bestW, prevW, `${kg(bestW)} × ${s.reps}`);
      }

      if (!timed) {
        const best = today.reduce((a, s) => (e1rm(s.weight, s.reps) > e1rm(a.weight, a.reps) ? s : a));
        const bestE = r1(e1rm(best.weight, best.reps));
        const prevE = r1(Math.max(...prevSets.map((s) => e1rm(s.weight, s.reps))));
        if (bestE > prevE) add(ex.exerciseId, ex.name, 'e1rm', bestE, prevE, `e1RM ${kg(bestE)}`);

        const vol = sum(today.map((s) => s.weight * s.reps));
        const prevVol = Math.max(...before.map((ss) => sum(ss.map((s) => s.weight * s.reps))));
        if (vol > prevVol) add(ex.exerciseId, ex.name, 'volume', vol, prevVol, `${Math.round(vol)} kg total`);
      }

      // most reps at a load at least as heavy as anything previously done for those reps
      let repPR: { s: SetLog; prev: number } | undefined;
      for (const s of today) {
        const comparable = prevSets.filter((p) => p.weight >= s.weight);
        if (!comparable.length) continue;
        const prev = Math.max(...comparable.map((p) => p.reps));
        if (s.reps > prev && (!repPR || s.reps - prev > repPR.s.reps - repPR.prev)) repPR = { s, prev };
      }
      if (repPR) add(ex.exerciseId, ex.name, 'reps', repPR.s.reps, repPR.prev, `${repPR.s.reps} ${timed ? 's' : 'reps'} @ ${kg(repPR.s.weight)}`);
    }
  } else {
    for (const ex of instance.exercises) {
      const metric = plyoExercise(ex.exerciseId).metric;
      const vals = ex.logs.map((l) => l.value).filter((v): v is number => v !== undefined);
      if (!metric || !vals.length) continue;
      const prevVals = prior.flatMap((i) =>
        i.kind === 'plyometric' ? i.exercises.filter((e) => e.exerciseId === ex.exerciseId).flatMap((e) => e.logs.map((l) => l.value)) : [],
      ).filter((v): v is number => v !== undefined);
      if (!prevVals.length) continue;
      const best = Math.max(...vals);
      const prev = Math.max(...prevVals);
      if (best > prev) add(ex.exerciseId, ex.name, metric, best, prev, `${best} cm`);
    }
  }
  return out;
}

const PRIORITY: PRKind[] = ['weight', 'jumpHeight', 'distance', 'height', 'e1rm', 'reps', 'volume'];

/** One headline record per exercise, for quiet presentation. */
export function headlinePRs(prs: PersonalRecord[]): PersonalRecord[] {
  const byEx = new Map<string, PersonalRecord>();
  for (const pr of prs) {
    const cur = byEx.get(pr.exerciseId);
    if (!cur || PRIORITY.indexOf(pr.kind) < PRIORITY.indexOf(cur.kind)) byEx.set(pr.exerciseId, pr);
  }
  return [...byEx.values()];
}

export const PR_LABEL: Record<PRKind, string> = {
  weight: 'Weight PR', reps: 'Rep PR', e1rm: 'e1RM PR', volume: 'Volume PR', jumpHeight: 'Jump PR', height: 'Box PR', distance: 'Distance PR',
};
