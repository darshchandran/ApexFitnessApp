// Body areas and how exercises map onto them. An exercise contributes to several areas:
// its primary muscle fully, secondary muscles partly, and (for leg work) general lower-body load.
import type { AreaLoad, BodyArea, Exercise, ExercisePriority, Muscle, MuscleGroup, WorkoutTemplateExercise } from './types';

export const AREA_GROUPS = {
  lower: ['quads', 'hamstrings', 'glutes', 'calves', 'elastic'],
  upper: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  core: ['trunk'],
  athletic: ['sprint', 'jump', 'cod', 'explosive'],
} as const satisfies Record<string, readonly BodyArea[]>;

export const AREA_LABEL: Record<BodyArea, string> = {
  quads: 'Quads', hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', elastic: 'Achilles / elastic', lower: 'Lower body',
  chest: 'Chest', back: 'Back', shoulders: 'Shoulders', biceps: 'Biceps', triceps: 'Triceps', upper: 'Upper body',
  trunk: 'Core', sprint: 'Sprinting', jump: 'Jumping', cod: 'Change of direction', explosive: 'Explosive work',
};

/** Catalog muscle → load area. */
export const MUSCLE_AREA: Record<Muscle, BodyArea> = {
  chest: 'chest', lats: 'back', 'upper-back': 'back', traps: 'back', shoulders: 'shoulders', 'rear-delts': 'shoulders',
  biceps: 'biceps', forearms: 'biceps', triceps: 'triceps', quads: 'quads', hamstrings: 'hamstrings', glutes: 'glutes',
  calves: 'calves', tibialis: 'calves', core: 'trunk',
};

/** Catalog muscle → weekly volume group. */
export const MUSCLE_GROUP: Record<Muscle, MuscleGroup> = {
  chest: 'chest', lats: 'back', 'upper-back': 'back', traps: 'back', shoulders: 'shoulders', 'rear-delts': 'shoulders',
  biceps: 'biceps', forearms: 'biceps', triceps: 'triceps', quads: 'quads', hamstrings: 'hamstrings', glutes: 'glutes',
  calves: 'calves', tibialis: 'calves', core: 'core',
};

export const GROUP_LABEL: Record<MuscleGroup, string> = {
  chest: 'Chest', back: 'Back', shoulders: 'Shoulders', biceps: 'Biceps', triceps: 'Triceps',
  quads: 'Quads', hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', core: 'Core',
};

const LOWER_AREAS = new Set<BodyArea>(AREA_GROUPS.lower);
const UPPER_AREAS = new Set<BodyArea>(AREA_GROUPS.upper);

/** Share of one set's load landing on each area. */
export function exerciseAreaShares(ex: Exercise, primaryShare: number, secondaryShare: number): AreaLoad {
  const out: AreaLoad = {};
  const add = (a: BodyArea, v: number) => { out[a] = (out[a] ?? 0) + v; };
  add(MUSCLE_AREA[ex.primary], primaryShare);
  for (const m of ex.secondary ?? []) add(MUSCLE_AREA[m], secondaryShare);
  if (ex.region === 'lower') add('lower', 1);
  if (ex.region === 'upper') add('upper', 1);
  return out;
}

export const addAreas = (into: AreaLoad, from: AreaLoad, scale = 1) => {
  for (const k of Object.keys(from) as BodyArea[]) into[k] = (into[k] ?? 0) + (from[k] ?? 0) * scale;
  return into;
};

export const isLowerArea = (a: BodyArea) => LOWER_AREAS.has(a) || a === 'lower';
export const isUpperArea = (a: BodyArea) => UPPER_AREAS.has(a) || a === 'upper';

/** Default importance from the exercise itself; a template's own setting always wins. */
export function defaultPriority(ex: Exercise): ExercisePriority {
  if (ex.region === 'core') return 'accessory';
  if (ex.fatigueCost === 3) return ex.unilateral ? 'secondary' : 'primary';
  if (ex.fatigueCost === 2) return 'secondary';
  return 'accessory';
}

export const priorityOf = (te: Pick<WorkoutTemplateExercise, 'priority'>, ex: Exercise) => te.priority ?? defaultPriority(ex);

export const PRIORITY_LABEL: Record<ExercisePriority, string> = { primary: 'Primary', secondary: 'Secondary', accessory: 'Accessory', optional: 'Optional' };
