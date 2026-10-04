import { gymExercise, hasGymExercise, hasPlyoExercise } from './catalog';
import type {
  ApexData, PlyometricTemplate, PlyometricTemplateExercise, TrainingPlan, WorkoutTemplate, WorkoutTemplateExercise,
} from './types';

// The user's program, verbatim: [name as written, catalog id, working sets].
type GymSpec = [name: string, exerciseId: string, sets: number];

export const SEED_GYM: { id: string; name: string; tag: string; exercises: GymSpec[] }[] = [
  {
    id: 'push-v1', name: 'Push V1', tag: 'MUSCLE FOCUS',
    exercises: [
      ['Incline Dumbbell Bench Press', 'incline-db-bench', 3],
      ['Seated Machine Fly', 'machine-fly', 3],
      ['Seated Dumbbell Shoulder Press', 'seated-db-shoulder-press', 3],
      ['Cable Overhead Triceps Extension', 'cable-overhead-triceps-ext', 3],
      ['Lateral Machine Raise', 'lateral-machine-raise', 3],
      ['Single Arm Triceps Extension', 'single-arm-triceps-ext', 3],
      ['Cable Crunch', 'cable-crunch', 2],
      ['Russian Twist', 'russian-twist', 2],
    ],
  },
  {
    id: 'push-v2', name: 'Push V2', tag: 'MUSCLE FOCUS',
    exercises: [
      ['Flat Dumbbell Bench Press', 'flat-db-bench', 3],
      ['Seated Machine Fly', 'machine-fly', 3],
      ['Seated Dumbbell Shoulder Press', 'seated-db-shoulder-press', 3],
      ['Cable Overhead Triceps Extension', 'cable-overhead-triceps-ext', 3],
      ['Lateral Machine Raise', 'lateral-machine-raise', 3],
      ['Single Arm Triceps Extension', 'single-arm-triceps-ext', 3],
      ['Cable Crunch', 'cable-crunch', 2],
      ['Russian Twist', 'russian-twist', 2],
    ],
  },
  {
    id: 'pull', name: 'Pull', tag: 'MUSCLE FOCUS',
    exercises: [
      ['Lat Pulldown', 'lat-pulldown', 3],
      ['Chest Supported Row', 'chest-supported-row', 3],
      ['Seated Cable Row', 'seated-cable-row', 3],
      ['Single-Arm Lat Pulldown', 'single-arm-lat-pulldown', 2],
      ['Cable Face Pull', 'cable-face-pull', 3],
      ['Seated Incline Dumbbell Curl', 'seated-incline-db-curl', 3],
      ['Shrugs', 'shrugs', 3],
      ['Rope Hammer Curls', 'rope-hammer-curl', 3],
    ],
  },
  {
    id: 'legs', name: 'Legs', tag: 'HIGH LOAD',
    exercises: [
      ['Smith Machine Squat', 'smith-squat', 3],
      ['Romanian Deadlift', 'romanian-deadlift', 3],
      ['Leg Press', 'leg-press', 3],
      ['Seated Leg Curl', 'seated-leg-curl', 3],
      ['Bulgarian Deadlift', 'bulgarian-deadlift', 2],
      ['Leg Extension Machine', 'leg-extension', 2],
      ['Barbell Calf Raise', 'barbell-calf-raise', 3],
      ['Tibialis Raises', 'tibialis-raise', 2],
    ],
  },
  {
    id: 'upper', name: 'Upper', tag: 'MUSCLE FOCUS',
    exercises: [
      ['Incline Dumbbell Bench Press', 'incline-db-bench', 3],
      ['Lat Pulldown', 'lat-pulldown', 3],
      ['Chest Supported Rows', 'chest-supported-row', 3],
      ['Chest Press', 'chest-press', 3],
      ['Lateral Machine Raise', 'lateral-machine-raise', 2],
      ['Cable Face Pull', 'cable-face-pull', 2],
      ['EZ-Bar Curl', 'ez-bar-curl', 2],
      ['Single Arm Tricep Extension', 'single-arm-triceps-ext', 2],
    ],
  },
  {
    id: 'lower', name: 'Lower', tag: 'HIGH LOAD',
    exercises: [
      ['Smith Machine Squat', 'smith-squat', 3],
      ['Leg Press', 'leg-press', 3],
      ['Lying Leg Curl Machine', 'lying-leg-curl', 3],
      ['Lunges', 'lunges', 2],
      ['Leg Extension Machine', 'leg-extension', 2],
      ['Farmers Walk', 'farmers-walk', 1],
      ['Barbell Calf Raise', 'barbell-calf-raise', 3],
      ['Cable Crunch', 'cable-crunch', 3],
    ],
  },
];

// [name, catalog id, sets, reps, perSide]
type PlyoSpec = [name: string, exerciseId: string, sets: number, reps: number, perSide?: boolean];

export const SEED_PLYO: { id: string; name: string; tag: string; restSec: number; exercises: PlyoSpec[] }[] = [
  {
    id: 'elastic-foundation', name: 'Elastic Foundation', tag: 'FOUNDATION', restSec: 60,
    exercises: [
      ['Pogo Jump', 'pogo-jump', 3, 15],
      ['Snap Down', 'snap-down', 3, 5],
      ['Countermovement Jump', 'cmj', 3, 4],
      ['Broad Jump', 'broad-jump', 3, 3],
      ['Lateral Bound', 'lateral-bound', 2, 5, true],
    ],
  },
  {
    id: 'vertical-power', name: 'Vertical Power', tag: 'HIGH INTENT', restSec: 90,
    exercises: [
      ['Countermovement Jump', 'cmj', 4, 3],
      ['Box Jump', 'box-jump', 4, 3],
      ['Approach Jump', 'approach-jump', 4, 3],
      ['Tuck Jump', 'tuck-jump', 2, 5],
    ],
  },
  {
    id: 'reactive', name: 'Reactive', tag: 'STIFFNESS', restSec: 75,
    exercises: [
      ['Drop Jump', 'drop-jump', 3, 4],
      ['Reactive Hurdle Hop', 'reactive-hurdle-hop', 3, 5],
      ['Lateral Bound', 'lateral-bound', 3, 4, true],
      ['Pogo Jump', 'pogo-jump', 3, 15],
    ],
  },
  {
    id: 'basketball-explosive', name: 'Basketball Explosive', tag: 'SPORT SPECIFIC', restSec: 75,
    exercises: [
      ['Pogo Jump', 'pogo-jump', 2, 15],
      ['Approach Jump', 'approach-jump', 4, 3],
      ['Single-Leg Approach Jump', 'sl-approach-jump', 3, 3, true],
      ['Lateral Bound to Jump', 'lateral-bound-to-jump', 3, 4, true],
      ['Reactive Change-of-Direction Jump', 'reactive-cod-jump', 3, 4],
    ],
  },
  {
    id: 'low-fatigue-primer', name: 'Low-Fatigue Primer', tag: 'LOW FATIGUE', restSec: 45,
    exercises: [
      ['Pogo Jump', 'pogo-jump', 2, 10],
      ['Snap Down', 'snap-down', 2, 4],
      ['Countermovement Jump', 'cmj', 3, 2],
      ['Approach Jump', 'approach-jump', 2, 2],
    ],
  },
  {
    id: 'max-power', name: 'Max Power', tag: 'LONG REST', restSec: 120,
    exercises: [
      ['Countermovement Jump', 'cmj', 4, 2],
      ['Depth Jump', 'depth-jump', 3, 3],
      ['Approach Jump', 'approach-jump', 4, 2],
      ['Broad Jump', 'broad-jump', 3, 2],
    ],
  },
  {
    id: 'deload', name: 'Deload', tag: 'RECOVERY', restSec: 45,
    exercises: [
      ['Pogo Jump', 'pogo-jump', 2, 10],
      ['Countermovement Jump', 'cmj', 2, 3],
      ['Lateral Bound', 'lateral-bound', 2, 3, true],
    ],
  },
];

export const LOW_FATIGUE_PLYO_ID = 'low-fatigue-primer';

export function seedGymTemplates(now: string): WorkoutTemplate[] {
  return SEED_GYM.map((t) => ({
    id: t.id,
    kind: 'gym',
    name: t.name,
    tag: t.tag,
    createdAt: now,
    updatedAt: now,
    exercises: t.exercises.map(([name, exerciseId, sets], i): WorkoutTemplateExercise => {
      if (!hasGymExercise(exerciseId)) throw new Error(`Seed references unknown exercise ${exerciseId}`);
      const ex = gymExercise(exerciseId);
      return { id: `${t.id}-${i}`, exerciseId, name, sets, warmupSets: 0, repRange: [...ex.repRange], restSec: ex.restSec, targetRir: 2 };
    }),
  }));
}

export function seedPlyoTemplates(now: string): PlyometricTemplate[] {
  return SEED_PLYO.map((t) => ({
    id: t.id,
    kind: 'plyometric',
    name: t.name,
    tag: t.tag,
    createdAt: now,
    updatedAt: now,
    exercises: t.exercises.map(([name, exerciseId, sets, reps, perSide], i): PlyometricTemplateExercise => {
      if (!hasPlyoExercise(exerciseId)) throw new Error(`Seed references unknown exercise ${exerciseId}`);
      return { id: `${t.id}-${i}`, exerciseId, name, sets, reps, perSide: !!perSide, restSec: t.restSec };
    }),
  }));
}

export function seedPlan(): TrainingPlan {
  const push = { rotationId: 'rot-push' };
  return {
    id: 'plan-ppl-ul',
    name: 'PPL × Upper/Lower',
    rotations: [{ id: 'rot-push', name: 'Push', templateIds: ['push-v1', 'push-v2'] }],
    days: [
      { gym: push, plyo: { templateId: 'vertical-power' } }, // Mon
      { gym: { templateId: 'pull' } }, // Tue
      { gym: { templateId: 'legs' } }, // Wed
      { gym: push, plyo: { templateId: 'basketball-explosive' } }, // Thu
      { gym: { templateId: 'upper' } }, // Fri
      { gym: { templateId: 'lower' } }, // Sat
      {}, // Sun — rest
    ],
  };
}

export function seedData(now: Date): ApexData {
  const iso = now.toISOString();
  return {
    user: { id: 'user-1', name: 'Athlete', createdAt: iso },
    profile: { schedule: [] },
    settings: { effortScale: 'rir', autoRest: true },
    plan: seedPlan(),
    templates: seedGymTemplates(iso),
    plyoTemplates: seedPlyoTemplates(iso),
    instances: [],
    basketball: [],
    recovery: [],
    bodyMetrics: [],
    performance: [],
    records: [],
  };
}
