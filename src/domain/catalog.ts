import type { Exercise, Muscle, PlyometricExercise, Region } from './types';

type GymRow = [
  id: string,
  name: string,
  primary: Muscle,
  region: Region,
  cost: 1 | 2 | 3,
  repRange: [number, number],
  increment: number,
  restSec: number,
  extra?: Partial<Exercise>,
];

// Every exercise in the seeded program plus a few substitution candidates.
const GYM: GymRow[] = [
  // chest
  ['incline-db-bench', 'Incline Dumbbell Bench Press', 'chest', 'upper', 2, [6, 10], 2, 150, { secondary: ['shoulders', 'triceps'] }],
  ['flat-db-bench', 'Flat Dumbbell Bench Press', 'chest', 'upper', 2, [6, 10], 2, 150, { secondary: ['shoulders', 'triceps'] }],
  ['barbell-bench', 'Barbell Bench Press', 'chest', 'upper', 2, [5, 8], 2.5, 180, { secondary: ['shoulders', 'triceps'] }],
  ['chest-press', 'Chest Press', 'chest', 'upper', 2, [8, 12], 2.5, 120, { secondary: ['triceps'] }],
  ['machine-fly', 'Seated Machine Fly', 'chest', 'upper', 1, [10, 15], 2.5, 90],
  ['cable-fly', 'Cable Fly', 'chest', 'upper', 1, [10, 15], 2.5, 90],
  // shoulders
  ['seated-db-shoulder-press', 'Seated Dumbbell Shoulder Press', 'shoulders', 'upper', 2, [6, 10], 2, 120, { secondary: ['triceps'] }],
  ['machine-shoulder-press', 'Machine Shoulder Press', 'shoulders', 'upper', 2, [8, 12], 2.5, 120, { secondary: ['triceps'] }],
  ['lateral-machine-raise', 'Lateral Machine Raise', 'shoulders', 'upper', 1, [12, 20], 2.5, 75],
  ['cable-lateral-raise', 'Cable Lateral Raise', 'shoulders', 'upper', 1, [12, 20], 1.25, 60, { unilateral: true }],
  ['cable-face-pull', 'Cable Face Pull', 'rear-delts', 'upper', 1, [12, 20], 2.5, 75, { secondary: ['upper-back'] }],
  ['reverse-pec-deck', 'Reverse Pec Deck', 'rear-delts', 'upper', 1, [12, 20], 2.5, 75],
  // triceps
  ['cable-overhead-triceps-ext', 'Cable Overhead Triceps Extension', 'triceps', 'upper', 1, [10, 15], 2.5, 90],
  ['single-arm-triceps-ext', 'Single Arm Triceps Extension', 'triceps', 'upper', 1, [10, 15], 1.25, 60, { unilateral: true }],
  ['triceps-pushdown', 'Triceps Pushdown', 'triceps', 'upper', 1, [10, 15], 2.5, 75],
  // back
  ['lat-pulldown', 'Lat Pulldown', 'lats', 'upper', 2, [8, 12], 2.5, 120, { secondary: ['biceps'] }],
  ['single-arm-lat-pulldown', 'Single-Arm Lat Pulldown', 'lats', 'upper', 1, [10, 15], 2.5, 75, { unilateral: true }],
  ['pull-up', 'Pull-Up', 'lats', 'upper', 2, [5, 10], 2.5, 150, { secondary: ['biceps'] }],
  ['chest-supported-row', 'Chest Supported Row', 'upper-back', 'upper', 2, [8, 12], 2.5, 120, { secondary: ['lats', 'rear-delts'] }],
  ['seated-cable-row', 'Seated Cable Row', 'upper-back', 'upper', 2, [8, 12], 2.5, 120, { secondary: ['lats', 'biceps'] }],
  ['t-bar-row', 'T-Bar Row', 'upper-back', 'upper', 2, [8, 12], 2.5, 120, { secondary: ['lats'] }],
  ['shrugs', 'Shrugs', 'traps', 'upper', 1, [10, 15], 2.5, 75],
  // arms
  ['seated-incline-db-curl', 'Seated Incline Dumbbell Curl', 'biceps', 'upper', 1, [8, 12], 1, 75],
  ['rope-hammer-curl', 'Rope Hammer Curls', 'biceps', 'upper', 1, [10, 15], 2.5, 60, { secondary: ['forearms'] }],
  ['ez-bar-curl', 'EZ-Bar Curl', 'biceps', 'upper', 1, [8, 12], 2.5, 75],
  ['db-hammer-curl', 'Dumbbell Hammer Curl', 'biceps', 'upper', 1, [10, 15], 1, 60, { secondary: ['forearms'] }],
  // legs
  ['smith-squat', 'Smith Machine Squat', 'quads', 'lower', 3, [6, 10], 2.5, 180, { secondary: ['glutes'] }],
  ['hack-squat', 'Hack Squat', 'quads', 'lower', 3, [6, 10], 5, 180, { secondary: ['glutes'] }],
  ['leg-press', 'Leg Press', 'quads', 'lower', 3, [8, 12], 5, 150, { secondary: ['glutes'] }],
  ['leg-extension', 'Leg Extension Machine', 'quads', 'lower', 2, [10, 15], 2.5, 90],
  ['lunges', 'Lunges', 'quads', 'lower', 3, [8, 12], 2, 120, { secondary: ['glutes'], unilateral: true }],
  ['bulgarian-split-squat', 'Bulgarian Split Squat', 'quads', 'lower', 3, [8, 12], 2, 120, { secondary: ['glutes'], unilateral: true }],
  ['romanian-deadlift', 'Romanian Deadlift', 'hamstrings', 'lower', 3, [6, 10], 2.5, 180, { secondary: ['glutes'] }],
  ['bulgarian-deadlift', 'Bulgarian Deadlift', 'hamstrings', 'lower', 3, [8, 12], 2, 120, { secondary: ['glutes'], unilateral: true }],
  ['single-leg-rdl', 'Single-Leg RDL', 'hamstrings', 'lower', 2, [8, 12], 2, 90, { secondary: ['glutes'], unilateral: true }],
  ['seated-leg-curl', 'Seated Leg Curl', 'hamstrings', 'lower', 2, [10, 15], 2.5, 90],
  ['lying-leg-curl', 'Lying Leg Curl Machine', 'hamstrings', 'lower', 2, [10, 15], 2.5, 90],
  ['hip-thrust', 'Hip Thrust', 'glutes', 'lower', 2, [8, 12], 5, 120, { secondary: ['hamstrings'] }],
  ['barbell-calf-raise', 'Barbell Calf Raise', 'calves', 'lower', 1, [8, 15], 2.5, 75],
  ['seated-calf-raise', 'Seated Calf Raise', 'calves', 'lower', 1, [10, 15], 2.5, 60],
  ['tibialis-raise', 'Tibialis Raises', 'tibialis', 'lower', 1, [12, 20], 1, 60],
  // core / carries
  ['cable-crunch', 'Cable Crunch', 'core', 'core', 1, [10, 15], 2.5, 60],
  ['russian-twist', 'Russian Twist', 'core', 'core', 1, [12, 20], 2, 60],
  ['hanging-leg-raise', 'Hanging Leg Raise', 'core', 'core', 1, [8, 15], 0, 60],
  ['farmers-walk', 'Farmers Walk', 'forearms', 'core', 2, [30, 45], 2, 120, { secondary: ['traps', 'core'], unit: 'sec' }],
];

export const GYM_EXERCISES: Exercise[] = GYM.map(([id, name, primary, region, fatigueCost, repRange, increment, restSec, extra]) => ({
  id, name, primary, region, fatigueCost, repRange, increment, restSec, ...extra,
}));

type PlyoRow = [id: string, name: string, cats: PlyometricExercise['categories'], intensity: 1 | 2 | 3, metric: PlyometricExercise['metric'], restSec: number, unilateral?: boolean];

const PLYO: PlyoRow[] = [
  ['cmj', 'Countermovement Jump', ['vertical'], 2, 'jumpHeight', 75],
  ['squat-jump', 'Squat Jump', ['vertical'], 2, 'jumpHeight', 75],
  ['tuck-jump', 'Tuck Jump', ['vertical'], 3, undefined, 90],
  ['box-jump', 'Box Jump', ['vertical'], 2, 'height', 90],
  ['depth-jump', 'Depth Jump', ['vertical', 'reactive'], 3, 'jumpHeight', 120],
  ['approach-jump', 'Approach Jump', ['vertical', 'basketball'], 3, 'jumpHeight', 90],
  ['broad-jump', 'Broad Jump', ['horizontal'], 2, 'distance', 90],
  ['standing-broad-jump', 'Standing Broad Jump', ['horizontal'], 2, 'distance', 90],
  ['bounds', 'Bounds', ['horizontal'], 3, 'distance', 120],
  ['single-leg-bounds', 'Single-Leg Bounds', ['horizontal'], 3, 'distance', 120, true],
  ['lateral-bound', 'Lateral Bound', ['lateral'], 2, 'distance', 75, true],
  ['skater-jump', 'Skater Jump', ['lateral'], 2, undefined, 60, true],
  ['lateral-hurdle-jump', 'Lateral Hurdle Jump', ['lateral'], 2, undefined, 75],
  ['pogo-jump', 'Pogo Jump', ['reactive'], 1, undefined, 60],
  ['drop-jump', 'Drop Jump', ['reactive'], 3, 'jumpHeight', 120],
  ['reactive-hurdle-hop', 'Reactive Hurdle Hop', ['reactive'], 2, undefined, 90],
  ['repeated-hops', 'Repeated Hops', ['reactive'], 1, undefined, 60],
  ['snap-down', 'Snap Down', ['landing'], 1, undefined, 45],
  ['sl-approach-jump', 'Single-Leg Approach Jump', ['basketball'], 3, 'jumpHeight', 90, true],
  ['two-leg-max-jump', 'Two-Leg Max Jump', ['basketball'], 3, 'jumpHeight', 120],
  ['lateral-bound-to-jump', 'Lateral Bound to Jump', ['basketball'], 2, 'jumpHeight', 90, true],
  ['shuffle-to-jump', 'Defensive Shuffle to Jump', ['basketball'], 2, 'jumpHeight', 90],
  ['reactive-cod-jump', 'Reactive Change-of-Direction Jump', ['basketball'], 3, undefined, 90],
];

export const PLYO_EXERCISES: PlyometricExercise[] = PLYO.map(([id, name, categories, intensity, metric, restSec, unilateral]) => ({
  id, name, categories, intensity, metric, restSec, unilateral,
}));

const gymById = new Map(GYM_EXERCISES.map((e) => [e.id, e]));
const plyoById = new Map(PLYO_EXERCISES.map((e) => [e.id, e]));

export const hasGymExercise = (id: string) => gymById.has(id);
export const hasPlyoExercise = (id: string) => plyoById.has(id);

/** Unknown ids (e.g. data from a newer build) get a neutral stand-in instead of crashing. */
export function gymExercise(id: string): Exercise {
  return gymById.get(id) ?? { id, name: 'Unknown exercise', primary: 'core', region: 'core', fatigueCost: 1, repRange: [8, 12], increment: 2.5, restSec: 90 };
}

export function plyoExercise(id: string): PlyometricExercise {
  return plyoById.get(id) ?? { id, name: 'Unknown exercise', categories: [], intensity: 1, restSec: 60 };
}

/** Substitution candidates: same primary muscle, closest movement type first (isolation for isolation, compound for compound). */
export function substitutesFor(id: string): Exercise[] {
  const e = gymExercise(id);
  const distance = (x: Exercise) => Math.abs(x.fatigueCost - e.fatigueCost) + (!!x.unilateral !== !!e.unilateral ? 0.5 : 0);
  return GYM_EXERCISES.filter((x) => x.id !== id && x.primary === e.primary).sort((a, b) => distance(a) - distance(b));
}

export function plyoSubstitutesFor(id: string): PlyometricExercise[] {
  const e = plyoExercise(id);
  return PLYO_EXERCISES.filter((x) => x.id !== id && x.categories.some((c) => e.categories.includes(c)));
}

export const MUSCLE_LABEL: Record<Muscle, string> = {
  chest: 'Chest', lats: 'Lats', 'upper-back': 'Upper back', shoulders: 'Shoulders', 'rear-delts': 'Rear delts',
  traps: 'Traps', biceps: 'Biceps', triceps: 'Triceps', forearms: 'Forearms', quads: 'Quads',
  hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', tibialis: 'Tibialis', core: 'Core',
};
