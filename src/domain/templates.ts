// Immutable template operations. Each returns a new template; inputs are untouched.
import { gymExercise, plyoExercise } from './catalog';
import type { PlyometricTemplate, Template, WorkoutTemplate } from './types';
import { uid } from './util';

export function createTemplate(kind: Template['kind'], name: string, now: string): Template {
  const base = { id: uid('t'), name, tag: 'CUSTOM', exercises: [], createdAt: now, updatedAt: now };
  return kind === 'gym' ? { ...base, kind: 'gym' } : { ...base, kind: 'plyometric' };
}

export function duplicateTemplate<T extends Template>(t: T, now: string): T {
  const id = uid('t');
  return {
    ...t,
    id,
    name: `${t.name} Copy`,
    createdAt: now,
    updatedAt: now,
    exercises: t.exercises.map((e) => ({ ...e, id: uid('te') })),
  } as T;
}

const touch = <T extends Template>(t: T, patch: Partial<T>, now: string): T => ({ ...t, ...patch, updatedAt: now });

export function addGymExercise(t: WorkoutTemplate, exerciseId: string, now: string): WorkoutTemplate {
  const ex = gymExercise(exerciseId);
  return touch(t, {
    exercises: [...t.exercises, { id: uid('te'), exerciseId, name: ex.name, sets: 3, warmupSets: 0, repRange: [...ex.repRange], restSec: ex.restSec, targetRir: 2 }],
  }, now);
}

export function addPlyoExercise(t: PlyometricTemplate, exerciseId: string, now: string): PlyometricTemplate {
  const ex = plyoExercise(exerciseId);
  return touch(t, {
    exercises: [...t.exercises, { id: uid('te'), exerciseId, name: ex.name, sets: 3, reps: 3, perSide: !!ex.unilateral, restSec: ex.restSec }],
  }, now);
}

export function removeExercise<T extends Template>(t: T, exId: string, now: string): T {
  return touch(t, { exercises: t.exercises.filter((e) => e.id !== exId) } as Partial<T>, now);
}

export function moveExercise<T extends Template>(t: T, exId: string, dir: -1 | 1, now: string): T {
  const i = t.exercises.findIndex((e) => e.id === exId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= t.exercises.length) return t;
  const exercises = [...t.exercises];
  [exercises[i], exercises[j]] = [exercises[j], exercises[i]];
  return touch(t, { exercises } as Partial<T>, now);
}

export function updateExercise<T extends Template>(t: T, exId: string, patch: Partial<T['exercises'][number]>, now: string): T {
  return touch(t, { exercises: t.exercises.map((e) => (e.id === exId ? { ...e, ...patch } : e)) } as Partial<T>, now);
}

/** Pair an exercise with the next one (or break the pair). */
export function toggleSuperset(t: WorkoutTemplate, exId: string, now: string): WorkoutTemplate {
  const i = t.exercises.findIndex((e) => e.id === exId);
  const cur = t.exercises[i];
  const next = t.exercises[i + 1];
  if (!cur) return t;
  if (cur.supersetGroup) {
    const g = cur.supersetGroup;
    return touch(t, { exercises: t.exercises.map((e) => (e.supersetGroup === g ? { ...e, supersetGroup: undefined } : e)) }, now);
  }
  if (!next) return t;
  const g = next.supersetGroup ?? uid('ss');
  return touch(t, { exercises: t.exercises.map((e, k) => (k === i || k === i + 1 ? { ...e, supersetGroup: g } : e)) }, now);
}

export const workingSetCount = (t: WorkoutTemplate) => t.exercises.reduce((n, e) => n + e.sets, 0);
