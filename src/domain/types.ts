// Core domain entities. Pure data — no React, no persistence.
import type { AthleteProfile } from './profile';

export type ISODate = string; // YYYY-MM-DD (local)
export type ISODateTime = string;

export type TrainingType = 'gym' | 'plyometric' | 'basketball' | 'conditioning' | 'recovery';
export type Region = 'upper' | 'lower' | 'core';
export type Muscle =
  | 'chest' | 'lats' | 'upper-back' | 'shoulders' | 'rear-delts' | 'traps' | 'biceps' | 'triceps'
  | 'forearms' | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'tibialis' | 'core';
export type Level = 0 | 1 | 2 | 3; // none / low / moderate / high
export type LoadBand = 'low' | 'moderate' | 'high' | 'extreme';

/** Load dimensions. One exercise or session can contribute to several. */
export type BodyArea =
  | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'elastic' | 'lower' // lower body ('lower' = general)
  | 'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps' | 'upper' // upper body ('upper' = general)
  | 'trunk'
  | 'sprint' | 'jump' | 'cod' | 'explosive'; // athletic / neural
export type AreaLoad = Partial<Record<BodyArea, number>>;

/** Weekly hypertrophy tracking groups. */
export type MuscleGroup = 'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps' | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'core';

/** How much an exercise matters when a session has to shrink. User-configurable per template. */
export type ExercisePriority = 'primary' | 'secondary' | 'accessory' | 'optional';

// ---------- Exercise library ----------

export interface Exercise {
  id: string;
  name: string;
  primary: Muscle;
  secondary?: Muscle[];
  region: Region;
  fatigueCost: 1 | 2 | 3; // systemic + local cost of one hard set
  repRange: [number, number];
  increment: number; // kg
  restSec: number;
  unilateral?: boolean;
  unit?: 'reps' | 'sec';
}

export type PlyoCategory = 'vertical' | 'horizontal' | 'lateral' | 'reactive' | 'basketball' | 'landing';
export type PlyoMetric = 'jumpHeight' | 'height' | 'distance';

export interface PlyometricExercise {
  id: string;
  name: string;
  categories: PlyoCategory[];
  intensity: 1 | 2 | 3;
  metric?: PlyoMetric; // what a rep can be measured by (cm)
  unilateral?: boolean;
  restSec: number;
}

// ---------- Templates (user-owned program; never mutated by generation) ----------

export interface WorkoutTemplateExercise {
  id: string;
  exerciseId: string;
  name: string; // the user's text, verbatim
  sets: number; // working sets
  warmupSets: number;
  repRange: [number, number];
  restSec: number;
  targetRir: number;
  supersetGroup?: string;
  notes?: string;
  priority?: ExercisePriority; // unset = derived from the exercise (compound → primary …)
}

export interface WorkoutTemplate {
  id: string;
  kind: 'gym';
  name: string;
  tag: string;
  exercises: WorkoutTemplateExercise[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface PlyometricTemplateExercise {
  id: string;
  exerciseId: string;
  name: string;
  sets: number;
  reps: number;
  perSide: boolean;
  restSec: number;
  notes?: string;
}

export interface PlyometricTemplate {
  id: string;
  kind: 'plyometric';
  name: string;
  tag: string;
  exercises: PlyometricTemplateExercise[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type Template = WorkoutTemplate | PlyometricTemplate;

// ---------- Plan ----------

export type SlotRef = { templateId: string } | { rotationId: string };

export interface PlanDay {
  gym?: SlotRef;
  plyo?: SlotRef;
  /** Legacy (pre-schedule builds): basketball time. Migrated into the athlete's schedule on load. */
  basketball?: string;
}

export interface Rotation {
  id: string;
  name: string;
  templateIds: string[];
}

export interface TrainingPlan {
  id: string;
  name: string;
  days: PlanDay[]; // 0 = Monday … 6 = Sunday
  rotations: Rotation[];
}

// ---------- Generated instances (prescription + actual performance) ----------

export type ExerciseStatus = 'pending' | 'done' | 'skipped' | 'removed';
export type InstanceStatus = 'planned' | 'active' | 'completed' | 'skipped'; // skipped = athlete chose a recovery day

export interface SetLog {
  id: string;
  /**
   * 'skipped' = a planned working set the athlete chose not to do. It is kept (weight and reps 0)
   * so history shows it was skipped — not deleted, not missing — and it never counts as volume or a PR.
   */
  kind: 'warmup' | 'working' | 'skipped';
  weight: number;
  reps: number;
  rir?: number; // RPE = 10 − RIR; optional, recorded when the athlete wants to
  note?: string;
  completedAt: ISODateTime;
}

export interface GymPrescription {
  sets: number;
  warmupSets: number;
  repRange: [number, number];
  restSec: number;
  targetRir: number;
}

export interface WorkoutInstanceExercise {
  id: string;
  exerciseId: string;
  name: string;
  templateSets: number; // what the template programmed (0 = added during the session)
  prescribed: GymPrescription;
  status: ExerciseStatus;
  /** The planned exercise this slot replaced today (template name and id) — the template keeps it. */
  substitutedFrom?: string;
  substitutedFromId?: string;
  supersetGroup?: string;
  notes?: string;
  sets: SetLog[];
}

export interface PlyoLog {
  id: string;
  reps: number; // per side when perSide (both sides), or for `side` only
  side?: 'L' | 'R'; // unilateral work logged one side at a time
  value?: number; // cm — jump height, box height or distance
  effort?: number; // 1–5
  completedAt: ISODateTime;
}

export interface PlyoPrescription {
  sets: number;
  reps: number;
  perSide: boolean;
  restSec: number;
}

export interface PlyometricInstanceExercise {
  id: string;
  exerciseId: string;
  name: string;
  template: { sets: number; reps: number } | null;
  prescribed: PlyoPrescription;
  status: ExerciseStatus;
  substitutedFrom?: string;
  substitutedFromId?: string;
  notes?: string;
  logs: PlyoLog[];
}

/** Rest timer, stored on the session so it survives navigation and restarts. Epoch ms. */
export interface RestState {
  endsAt: number;
  total: number; // seconds
  pausedLeft?: number; // seconds left when paused
}

interface InstanceBase {
  id: string;
  date: ISODate;
  templateId: string;
  templateName: string;
  rotationId?: string;
  status: InstanceStatus;
  decision: AdaptationDecision;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  notes?: string;
  rest?: RestState;
  /** 'kept' = athlete chose the template as programmed over Apex's adaptation. */
  plan?: 'adapted' | 'kept';
  /** Optional session RPE given at finish (used by plyometric load). */
  sessionRpe?: number;
  /** Set when the athlete took Apex's suggested alternative: the session it replaced (for labels and undo). */
  alternativeFor?: { templateId: string; templateName: string; rotationId?: string };
}

export interface WorkoutInstance extends InstanceBase {
  kind: 'gym';
  exercises: WorkoutInstanceExercise[];
}

export interface PlyometricInstance extends InstanceBase {
  kind: 'plyometric';
  exercises: PlyometricInstanceExercise[];
}

export type SessionInstance = WorkoutInstance | PlyometricInstance;

// ---------- Sport, recovery, body ----------

export type BasketballSessionType = 'skills' | 'shooting' | 'conditioning' | 'scrimmage' | 'game' | 'mixed';

export interface SportSession {
  id: string;
  sport: 'basketball';
  date: ISODate;
  loggedAt: ISODateTime;
  durationMin: number;
  rpe: number; // 1–10
  notes?: string;
}

export interface BasketballSession extends SportSession {
  sessionType?: BasketballSessionType;
  running?: Level;
  sprinting?: Level;
  jumping?: Level;
  changeOfDirection?: Level;
  lowerFatigue?: Level;
  upperFatigue?: Level;
}

export interface RecoveryLog {
  date: ISODate;
  sleepHours: number;
  soreness: number; // 1 none – 5 severe
  energy: number; // 1 drained – 5 great
}

export type BodyMetricKind = 'bodyweight' | 'waist' | 'chest' | 'arm' | 'thigh';
export interface BodyMetric {
  id: string;
  date: ISODate;
  kind: BodyMetricKind;
  value: number; // kg for bodyweight, cm otherwise
}

export type PerformanceKind = 'vertical' | 'broad' | 'approach';
export interface PerformanceMetric {
  id: string;
  date: ISODate;
  kind: PerformanceKind;
  value: number; // cm
}

export type PRKind = 'weight' | 'reps' | 'e1rm' | 'volume' | 'jumpHeight' | 'height' | 'distance';
export interface PersonalRecord {
  id: string;
  date: ISODate;
  instanceId: string;
  exerciseId: string;
  exerciseName: string;
  kind: PRKind;
  value: number;
  previous: number;
  detail: string; // "82.5 kg × 8"
}

// ---------- Load + adaptation ----------

export interface DailyLoad {
  date: ISODate;
  basketball: number;
  gym: number;
  plyo: number;
  total: number;
  band: LoadBand;
}

export type AdaptationOutcome = 'normal' | 'reduced' | 'heavily_reduced' | 'alternative' | 'deferred';

export interface AdaptationDecision {
  outcome: AdaptationOutcome;
  volumeFactor: number; // prescribed ÷ programmed (sets for gym, contacts for plyo)
  bands: { lower: LoadBand; upper: LoadBand; jump: LoadBand; systemic: LoadBand };
  readiness?: number;
  headline: string;
  reasons: string[];
  alternativeTemplateId?: string;
  // ---- explainability record (phase 3) ----
  date?: ISODate;
  templateId?: string;
  templateName?: string;
  level?: AdaptationLevel;
  plannedVolume?: number; // programmed sets / contacts
  prescribedVolume?: number;
  unit?: 'sets' | 'contacts';
  /** Change per body region, e.g. lower −32 %, upper 0 % (preserved). */
  areas?: { area: 'lower' | 'upper' | 'core' | 'jump'; band: LoadBand; change: number; preserved: boolean }[];
  removed?: string[];
  modified?: { name: string; from: string; to: string }[];
  /** Raw engine inputs, for debugging — never shown verbatim to the athlete. */
  inputs?: DecisionInputs;
}

export type AdaptationLevel = 'none' | 'light' | 'moderate' | 'substantial' | 'major';

export interface AreaStrainSnapshot {
  score: number;
  band: LoadBand;
  today: number;
  acute7: number;
  baseline: number;
  ratio: number;
}

export interface DecisionInputs {
  strain: Partial<Record<BodyArea, AreaStrainSnapshot>>;
  readiness?: number;
  recoveryScale: number;
  recent: string[]; // e.g. "Wed · Basketball 90 min @ RPE 9"
  /** Schedule context shown with the decision (never counted as load), e.g. a planned practice not yet logged. */
  context?: string[];
}

// ---------- Aggregate ----------

export interface User {
  id: string;
  name: string;
  createdAt: ISODateTime;
}

export interface Settings {
  effortScale: 'rir' | 'rpe';
  autoRest: boolean;
}

export interface ApexData {
  user: User;
  /** Athlete context, filled in progressively — every field optional. */
  profile: AthleteProfile;
  settings: Settings;
  plan: TrainingPlan;
  templates: WorkoutTemplate[];
  plyoTemplates: PlyometricTemplate[];
  instances: SessionInstance[];
  basketball: BasketballSession[];
  recovery: RecoveryLog[];
  bodyMetrics: BodyMetric[];
  performance: PerformanceMetric[];
  records: PersonalRecord[];
}
