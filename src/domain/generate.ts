// Template + adaptation → dated instance. The template is read, never written.
import type { GymPlan, PlyoPlan } from './adaptation';
import type { ISODate, PlyometricInstance, PlyometricTemplate, WorkoutInstance, WorkoutTemplate } from './types';
import { uid } from './util';

interface Meta {
  id?: string;
  date: ISODate;
  now: string;
  rotationId?: string;
  /** 'kept' = the athlete chose the template as written; the recommendation is still recorded. */
  plan?: 'adapted' | 'kept';
  alternativeFor?: WorkoutInstance['alternativeFor'];
}

export function generateGymInstance(t: WorkoutTemplate, plan: GymPlan, meta: Meta): WorkoutInstance {
  return {
    id: meta.id ?? uid('w'),
    kind: 'gym',
    date: meta.date,
    templateId: t.id,
    templateName: t.name,
    rotationId: meta.rotationId,
    status: 'planned',
    plan: meta.plan ?? 'adapted',
    decision: plan.decision,
    createdAt: meta.now,
    ...(meta.alternativeFor && { alternativeFor: meta.alternativeFor }),
    exercises: t.exercises.map((e) => {
      const sets = meta.plan === 'kept' ? e.sets : plan.sets[e.id] ?? e.sets;
      return {
        id: e.id,
        exerciseId: e.exerciseId,
        name: e.name,
        templateSets: e.sets,
        prescribed: { sets, warmupSets: e.warmupSets, repRange: [...e.repRange], restSec: e.restSec, targetRir: e.targetRir },
        status: sets === 0 ? 'removed' : 'pending',
        supersetGroup: e.supersetGroup,
        notes: e.notes,
        sets: [],
      };
    }),
  };
}

export function generatePlyoInstance(t: PlyometricTemplate, plan: PlyoPlan, meta: Meta): PlyometricInstance {
  return {
    id: meta.id ?? uid('p'),
    kind: 'plyometric',
    date: meta.date,
    templateId: t.id,
    templateName: t.name,
    rotationId: meta.rotationId,
    status: 'planned',
    plan: meta.plan ?? 'adapted',
    decision: plan.decision,
    createdAt: meta.now,
    ...(meta.alternativeFor && { alternativeFor: meta.alternativeFor }),
    exercises: t.exercises.map((e) => {
      const p = meta.plan === 'kept' ? { sets: e.sets, reps: e.reps } : plan.prescription[e.id] ?? { sets: e.sets, reps: e.reps };
      return {
        id: e.id,
        exerciseId: e.exerciseId,
        name: e.name,
        template: { sets: e.sets, reps: e.reps },
        prescribed: { sets: p.sets, reps: p.reps, perSide: e.perSide, restSec: e.restSec },
        status: p.sets === 0 ? 'removed' : 'pending',
        notes: e.notes,
        logs: [],
      };
    }),
  };
}
