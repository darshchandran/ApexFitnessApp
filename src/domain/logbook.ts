// The exercise logbook: what was lifted, when, how it's trending, and what a finished
// workout amounted to. Pure and read-only — it never changes stored sessions.
import { gymExercise } from './catalog';
import { APEX_CONFIG, type ApexConfig } from './config';
import { completed } from './history';
import { bandFor, gymLoad, gymVolume, plyoLoad, plyoSetsDone, prescribedContacts } from './load';
import { incrementKg, type Units } from './profile';
import { fatigueFor, recommendProgression, type Recommendation } from './progression';
import { e1rm, headlinePRs } from './records';
import type { ISODate, LoadBand, PersonalRecord, SessionInstance, SetLog } from './types';
import { sum } from './util';

const working = (sets: SetLog[]) => sets.filter((s) => s.kind === 'working');
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface ExerciseSession {
  instanceId: string;
  date: ISODate;
  templateName: string;
  /** Warm-ups and working sets, in the order they were logged. */
  sets: SetLog[];
  notes?: string;
}

/** Completed sessions that trained `exerciseId`, newest first. `excludeId` = the live session. */
export function exerciseHistory(instances: SessionInstance[], exerciseId: string, excludeId?: string): ExerciseSession[] {
  return completed(instances).flatMap((i) => {
    if (i.kind !== 'gym' || i.id === excludeId) return [];
    const ex = i.exercises.filter((e) => e.exerciseId === exerciseId);
    const sets = ex.flatMap((e) => e.sets);
    if (!working(sets).length) return [];
    const notes = ex.map((e) => e.notes).filter(Boolean).join(' · ');
    return [{ instanceId: i.id, date: i.date, templateName: i.templateName, sets, notes: notes || undefined }];
  });
}

export type GraphMetric = 'weight' | 'e1rm' | 'volume' | 'reps';

/** One point per session, oldest first. Working sets only. */
export function exerciseSeries(history: ExerciseSession[], metric: GraphMetric): { date: ISODate; instanceId: string; value: number }[] {
  return history
    .map((h) => {
      const w = working(h.sets);
      const value =
        metric === 'weight' ? Math.max(...w.map((s) => s.weight))
          : metric === 'e1rm' ? r1(Math.max(...w.map((s) => e1rm(s.weight, s.reps))))
            : metric === 'volume' ? sum(w.map((s) => s.weight * s.reps))
              : sum(w.map((s) => s.reps));
      return { date: h.date, instanceId: h.instanceId, value };
    })
    .reverse();
}

/** Heaviest set first; equal weight → more reps. */
const heavier = (a: SetLog, b: SetLog) => (a.weight !== b.weight ? a.weight > b.weight : a.reps > b.reps);

/** Best set, best estimated 1RM and the last session's top set. Undefined until something is logged. */
export function exerciseBests(history: ExerciseSession[]) {
  // oldest first, so a tie keeps the date it was first achieved
  const all = [...history].reverse().flatMap((h) => working(h.sets).map((set) => ({ set, date: h.date })));
  if (!all.length) return undefined;
  const best = all.reduce((a, b) => (heavier(b.set, a.set) ? b : a));
  const top = all.reduce((a, b) => (e1rm(b.set.weight, b.set.reps) > e1rm(a.set.weight, a.set.reps) ? b : a));
  const lastSets = working(history[0].sets);
  return {
    best,
    e1rm: { value: r1(e1rm(top.set.weight, top.set.reps)), set: top.set, date: top.date },
    last: { date: history[0].date, set: lastSets.reduce((a, b) => (heavier(b, a) ? b : a)), sets: lastSets },
    sessions: history.length,
  };
}

/** "A1", "A2", "B1"… for exercises sharing a superset group (2+ members), in session order. */
export function supersetLabels(exercises: { id: string; supersetGroup?: string; status?: string }[]): Record<string, string> {
  const live = exercises.filter((e) => e.status !== 'removed' && e.supersetGroup);
  const size = new Map<string, number>();
  for (const e of live) size.set(e.supersetGroup!, (size.get(e.supersetGroup!) ?? 0) + 1);
  const letter = new Map<string, string>();
  const seen = new Map<string, number>();
  const out: Record<string, string> = {};
  for (const e of live) {
    const g = e.supersetGroup!;
    if (size.get(g)! < 2) continue;
    if (!letter.has(g)) letter.set(g, String.fromCharCode(65 + letter.size));
    seen.set(g, (seen.get(g) ?? 0) + 1);
    out[e.id] = `${letter.get(g)}${seen.get(g)}`;
  }
  return out;
}

/** Planned (template) → Apex's prescription → what was actually done, in sets or contacts. */
export function planVsActual(i: SessionInstance) {
  if (i.kind === 'gym') {
    const planned = i.decision.plannedVolume ?? i.exercises.reduce((n, e) => n + e.templateSets, 0);
    const prescribed = i.exercises.filter((e) => e.status !== 'removed').reduce((n, e) => n + e.prescribed.sets, 0);
    return { planned, prescribed, done: gymVolume(i).workingSets, unit: 'sets' as const };
  }
  const planned = i.decision.plannedVolume ?? i.exercises.reduce((n, e) => n + (e.template ? e.template.sets * e.template.reps * (e.prescribed.perSide ? 2 : 1) : 0), 0);
  return { planned, prescribed: prescribedContacts(i), done: plyoLoad(i).contacts, unit: 'contacts' as const };
}

export type AdaptationStatus = 'As planned' | 'Adapted' | 'Plan kept' | 'Alternative' | 'Recovery day' | 'Rest advised';

/**
 * One label for how today's session relates to its plan, used on every screen.
 * "Alternative" only when the athlete actually took the suggested alternative; a session Apex
 * changed and the athlete trained anyway is "Adapted".
 */
export function adaptationStatus(i: SessionInstance): AdaptationStatus {
  if (i.status === 'skipped') return 'Recovery day';
  if (i.alternativeFor) return 'Alternative';
  if (i.decision.outcome === 'normal') return 'As planned';
  if (i.plan === 'kept') return 'Plan kept';
  if (i.decision.outcome === 'deferred' && i.status === 'planned') return 'Rest advised';
  return 'Adapted';
}

export interface WorkoutSummary {
  durationMs: number;
  /** Exercises with at least one working set (or plyo set) vs exercises in today's session. */
  exercises: { done: number; total: number };
  /** Working sets (gym) or completed sets (plyo). */
  sets: number;
  /** kg moved (gym) or ground contacts (plyo). */
  volume: number;
  /** % vs the previous completed session of the same template; undefined without one. */
  volumeChange?: number;
  prs: PersonalRecord[];
  plan: ReturnType<typeof planVsActual>;
  adapted: boolean;
  skipped: string[];
  /** Planned working sets the athlete skipped (kept in history, never volume). */
  skippedSets: number;
  removed: string[];
  substitutions: { from: string; to: string }[];
  load: { value: number; band: LoadBand };
  progressions: { exerciseId: string; name: string; rec: Recommendation }[];
}

/** What a session amounted to. Progressions use the existing engine with today's sets as "previous". */
export function workoutSummary(inst: SessionInstance, instances: SessionInstance[], records: PersonalRecord[], cfg: ApexConfig = APEX_CONFIG, units: Units = 'kg'): WorkoutSummary {
  const end = inst.completedAt ?? inst.date;
  const durationMs = inst.completedAt && inst.startedAt ? Math.max(0, Date.parse(inst.completedAt) - Date.parse(inst.startedAt)) : 0;
  const prior = completed(instances).find((p) => p.id !== inst.id && p.kind === inst.kind && p.templateId === inst.templateId && (p.completedAt ?? p.date) < end);
  const live = inst.exercises.filter((e) => e.status !== 'removed');
  const base = {
    durationMs,
    exercises: { done: live.filter((e) => ('sets' in e ? working(e.sets).length > 0 : e.logs.length > 0)).length, total: live.length },
    prs: headlinePRs(records.filter((r) => r.instanceId === inst.id)),
    plan: planVsActual(inst),
    adapted: inst.plan !== 'kept' && inst.decision.outcome !== 'normal',
    skipped: inst.exercises.filter((e) => e.status === 'skipped').map((e) => e.name),
    skippedSets: inst.kind === 'gym' ? sum(inst.exercises.map((e) => e.sets.filter((s) => s.kind === 'skipped').length)) : 0,
    removed: inst.exercises.filter((e) => e.status === 'removed').map((e) => e.name),
    substitutions: inst.exercises.filter((e) => e.substitutedFrom).map((e) => ({ from: e.substitutedFrom!, to: e.name })),
  };
  const change = (now: number, before: number | undefined) => (before ? Math.round(((now - before) / before) * 100) : undefined);

  if (inst.kind === 'plyometric') {
    const l = plyoLoad(inst);
    return {
      ...base,
      sets: Math.floor(sum(inst.exercises.map((e) => plyoSetsDone(e.logs)))),
      volume: l.contacts,
      volumeChange: change(l.contacts, prior?.kind === 'plyometric' ? plyoLoad(prior).contacts : undefined),
      load: { value: Math.round(l.au), band: bandFor(l.au, cfg.dailyBands) },
      progressions: [],
    };
  }
  const v = gymVolume(inst);
  const total = gymLoad(inst, {}, cfg).total;
  return {
    ...base,
    sets: v.workingSets,
    volume: Math.round(v.volumeLoad),
    volumeChange: change(v.volumeLoad, prior?.kind === 'gym' ? gymVolume(prior).volumeLoad : undefined),
    load: { value: Math.round(total), band: bandFor(total, cfg.dailyBands) },
    progressions: inst.exercises.flatMap((e) => {
      const sets = working(e.sets);
      if (!sets.length) return [];
      const meta = gymExercise(e.exerciseId);
      // lb athletes progress in whole lb plates; the engine itself is unchanged
      const rec = recommendProgression({ repRange: e.prescribed.repRange, increment: incrementKg(meta.increment, units), previous: sets, fatigue: fatigueFor(inst.decision, meta, cfg) }, cfg);
      return [{ exerciseId: e.exerciseId, name: e.name, rec }];
    }),
  };
}
