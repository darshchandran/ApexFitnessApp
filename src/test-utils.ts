// Test fixtures only — not imported by the app.
import { adaptGym, contextFromSessions, type TrainingContext } from './domain/adaptation';
import { generateGymInstance } from './domain/generate';
import { seedData } from './domain/seed';
import type { ApexData, BasketballSession, RecoveryLog, SessionInstance, WorkoutInstance, WorkoutTemplate } from './domain/types';

export const NOW = new Date(2026, 9, 7, 18, 0); // Wed 7 Oct 2026, 18:00 local
export const TODAY = '2026-10-07';

export const freshData = (): ApexData => seedData(NOW);

export const emptyCtx = (date = TODAY): TrainingContext => contextFromSessions({ date });

/** Context from raw sessions — what buildContext does with stored data. */
export const ctxOf = (p: { date?: string; basketball?: BasketballSession[]; instances?: SessionInstance[]; recovery?: RecoveryLog }) =>
  contextFromSessions({ date: p.date ?? TODAY, basketball: p.basketball, instances: p.instances, recovery: p.recovery });

export const bball = (p: Partial<BasketballSession> & Pick<BasketballSession, 'durationMin' | 'rpe'>): BasketballSession => ({
  id: `bb-${Math.random()}`, sport: 'basketball', date: TODAY, loggedAt: NOW.toISOString(), sessionType: 'mixed', ...p,
});

export const gymTemplate = (id: string): WorkoutTemplate => freshData().templates.find((t) => t.id === id)!;

/** A completed instance of `templateId` where every working set is `weight × reps @ rir`. */
export function completedGym(
  templateId: string,
  date: string,
  sets: Record<string, [weight: number, reps: number, rir?: number][]>,
  id = `w-${date}-${templateId}`,
): WorkoutInstance {
  const t = gymTemplate(templateId);
  const inst = generateGymInstance(t, adaptGym(t, emptyCtx(date)), { id, date, now: `${date}T19:00:00.000Z` });
  return {
    ...inst,
    status: 'completed',
    completedAt: `${date}T20:00:00.000Z`,
    exercises: inst.exercises.map((e) => ({
      ...e,
      sets: (sets[e.exerciseId] ?? []).map(([weight, reps, rir], i) => ({
        id: `${id}-${e.id}-${i}`, kind: 'working' as const, weight, reps, rir, completedAt: `${date}T19:30:00.000Z`,
      })),
    })),
  };
}

export const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

export const byExercise = (i: SessionInstance) => Object.fromEntries(i.exercises.map((e) => [e.name, e.prescribed.sets]));
