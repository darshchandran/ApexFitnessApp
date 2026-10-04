// Every weight and threshold the training engine uses, in one place.
// These are Apex's internal training-management numbers (arbitrary units), tuned for
// programming decisions — not validated physiological or medical measurements.
import type { BasketballSessionType, BodyArea, ExercisePriority, Level, LoadBand, MuscleGroup } from './types';

type Movement = { running: Level; sprinting: Level; jumping: Level; changeOfDirection: Level };

export const APEX_CONFIG = {
  // ---------------- load per session ----------------
  basketball: {
    // session RPE × minutes × session-type intensity
    typeIntensity: { skills: 0.95, shooting: 0.85, conditioning: 1.05, scrimmage: 1.1, game: 1.15, mixed: 1 } as Record<BasketballSessionType, number>,
    // share of the session landing on the lower body, raised by jumping / sprinting / change of direction
    lowerShareBase: 0.5,
    lowerSharePerLevel: 0.05,
    lowerShareMax: 0.95,
    trunkShare: 0.08,
    // lower-body split: base weight + per movement level
    lowerSplit: {
      quads: { base: 1, jumping: 0.15, changeOfDirection: 0.15 },
      hamstrings: { base: 1, sprinting: 0.25 },
      glutes: { base: 0.8, sprinting: 0.1, changeOfDirection: 0.1 },
      calves: { base: 1, jumping: 0.2, sprinting: 0.1 },
      elastic: { base: 1, jumping: 0.3, changeOfDirection: 0.1 },
    } as Record<'quads' | 'hamstrings' | 'glutes' | 'calves' | 'elastic', { base: number } & Partial<Record<keyof Movement, number>>>,
    upperSplit: { shoulders: 0.35, back: 0.3, chest: 0.2, biceps: 0.075, triceps: 0.075 } as Record<'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps', number>,
    // estimated efforts per minute by level (none / low / moderate / high)
    jumpsPerMinute: [0, 0.8, 1.6, 2.5],
    sprintsPerMinute: [0, 0.2, 0.5, 0.9],
    cutsPerMinute: [0, 0.6, 1.2, 2],
    // missing optional fields fall back to what the session type usually involves
    typeDefaults: {
      skills: { running: 1, sprinting: 1, jumping: 1, changeOfDirection: 2 },
      shooting: { running: 1, sprinting: 0, jumping: 1, changeOfDirection: 0 },
      conditioning: { running: 3, sprinting: 3, jumping: 1, changeOfDirection: 2 },
      scrimmage: { running: 2, sprinting: 2, jumping: 2, changeOfDirection: 2 },
      game: { running: 3, sprinting: 2, jumping: 2, changeOfDirection: 3 },
      mixed: { running: 2, sprinting: 1, jumping: 2, changeOfDirection: 2 },
    } as Record<BasketballSessionType, Movement>,
  },
  gym: {
    auPerSet: 12,
    rirReference: 2,
    perRir: 0.1, // each rep closer to failure than RIR 2 adds 10 %
    effortClamp: [0.7, 1.3] as [number, number],
    // heavy low-rep sets cost a little more, very high-rep sets a little less
    repMod: (reps: number) => (reps <= 5 ? 1.1 : reps > 15 ? 0.9 : 1),
    // relative intensity vs the athlete's best e1RM on the lift (only when history exists)
    intensityClamp: [0.85, 1.1] as [number, number],
    costMod: { 1: 0.7, 2: 1, 3: 1.3 } as Record<1 | 2 | 3, number>,
    primaryShare: 1,
    secondaryShare: 0.5,
  },
  plyo: {
    auPerContact: 2.5,
    intensity: { 1: 0.5, 2: 1, 3: 1.6 } as Record<1 | 2 | 3, number>,
    reactive: 1.25, // depth / drop / reactive categories
    unilateral: 1.2, // single-leg contacts load one leg
    highJumpCm: 50, // measured jumps at or above this height
    highJump: 1.1,
    rpe: (rpe: number) => 0.7 + 0.05 * rpe, // RPE 6 → 1.0, RPE 9 → 1.15
    areaSplit: { elastic: 0.35, calves: 0.25, quads: 0.25, glutes: 0.15 },
  },

  // ---------------- windows + strain ----------------
  windows: { d1: 1, d3: 3, d7: 7, d14: 14, d28: 28 },
  history: 28, // days of history the engine reads
  minHistoryDays: 14, // below this, baselines fall back to `defaultWeekly`
  // weekly load a typical athlete in this program carries; used until enough history exists
  defaultWeekly: {
    lower: 1500, upper: 1100, trunk: 300, jump: 500, sprint: 150, cod: 400, explosive: 900,
    quads: 450, hamstrings: 350, glutes: 300, calves: 350, elastic: 350,
    chest: 220, back: 260, shoulders: 260, biceps: 120, triceps: 120,
  } as Record<BodyArea, number>,
  // what one hard day looks like for each area — scores are expressed in these units
  dayRef: {
    lower: 300, upper: 250, trunk: 80, jump: 120, sprint: 40, cod: 100, explosive: 200,
    quads: 90, hamstrings: 75, glutes: 65, calves: 75, elastic: 75,
    chest: 60, back: 70, shoulders: 70, biceps: 35, triceps: 35,
  } as Record<BodyArea, number>,
  residualWeights: [0.7, 0.5, 0.35, 0.2], // yesterday … 4 days ago, only load above the athlete's normal day counts
  accumulation: { ratioStart: 1.2, weight: 1, cap: 0.8 }, // 7-day load above baseline adds strain
  bands: { moderate: 0.75, high: 1.15, extreme: 1.65 }, // on the strain score
  // accumulated (7-day vs baseline) label
  accumulatedBands: { moderate: 0.7, high: 1.15, extreme: 1.5 },
  trend: { change: 0.15 }, // ±15 % week over week = increasing / decreasing
  // repeated muscle work: direct sets in the last 2 days (yesterday ×1, day before ×0.5)
  repeatMuscle: { sets: 6, strain: 0.8 },

  // ---------------- adaptation ----------------
  adaptation: {
    // strain score → share of volume removed (before per-exercise weighting)
    reduction: { start: 0.6, slope: 0.75, max: 0.7 },
    costWeight: { 1: 0.3, 2: 0.8, 3: 1 } as Record<1 | 2 | 3, number>,
    priorityWeight: { primary: 0.6, secondary: 1, accessory: 1, optional: 1.4 } as Record<ExercisePriority, number>,
    redundancyWeight: 1.4, // a second heavy compound for the same muscle in one session
    volumeStatusWeight: { under: 0.75, inRange: 1, high: 1.25 },
    exerciseCap: 0.85,
    removeOptionalAt: 'high' as LoadBand,
    removeUnilateralHeavyLowerAt: 'high' as LoadBand,
    // readiness changes how hard reductions bite; it never decides alone
    recovery: { pivot: 65, perPoint: 0.01, clamp: [0.7, 1.35] as [number, number], lowReadiness: 50, lowReadinessTrim: 0.1, deferBelow: 35 },
    lowerDominantShare: 0.6,
    upperFriendlyShare: 0.2, // alternative templates must be below this lower-body share
    outcome: { normal: 0.95, reduced: 0.75 },
    levels: { light: 0.85, moderate: 0.7, substantial: 0.5 }, // volume factor at or above → level
    preservedWithin: 0.05, // an area counts as preserved if cut by less than 5 %
  },
  plyoAdaptation: {
    // share of contacts removed, interpolated across each band's score range
    // (46 programmed → moderate ≈ 35–40, high ≈ 20–30, very high → primer or skip)
    bandReduction: { moderate: [0.13, 0.24], high: [0.35, 0.57], extreme: 0.6 } as { moderate: [number, number]; high: [number, number]; extreme: number },
    max: 0.65,
    lowerWeight: 0.8, // general lower-body strain feeds plyo decisions at 80 %
    removeReactiveAt: 'high' as LoadBand, // depth / drop jumps go first
    elasticRepsAbove: 8, // high-rep elastic work (pogos) loses reps, not sets
    elasticMinReps: 8,
  },

  // ---------------- volume + progression ----------------
  weeklySetTargets: {
    chest: [10, 20], back: [12, 22], shoulders: [10, 20], biceps: [8, 16], triceps: [8, 16],
    quads: [10, 18], hamstrings: [8, 16], glutes: [6, 16], calves: [8, 16], core: [6, 16],
  } as Record<MuscleGroup, [number, number]>,
  progression: { holdAtBand: 'high' as LoadBand, holdAtAccumulated: 'high' as LoadBand },

  // ---------------- readiness + display ----------------
  readiness: { sleepTarget: 8, perHourShort: 6, sleepMax: 30, perSoreness: 6, perEnergy: 5, priorDay: { low: 0, moderate: 0, high: 8, extreme: 15 } as Record<LoadBand, number> },
  dailyBands: [250, 450, 650], // whole-day load label on Home: moderate / high / very high
  insights: { loadChange: 0.2, minWeeklyLoad: 150, steadyWeeks: 3, steadyTolerance: 0.25, plyoAboveAverage: 0.25, progressionWeeks: 2, max: 4 },
};

export type ApexConfig = typeof APEX_CONFIG;
