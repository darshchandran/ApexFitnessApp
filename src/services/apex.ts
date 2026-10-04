// Application layer: owns state, runs domain logic, persists every change.
// No React here — the hook lives in useApex.ts.
import { adaptGym, adaptPlyo } from '../domain/adaptation';
import { insights } from '../domain/insights';
import { buildContext, computeStrain } from '../domain/strain';
import { muscleVolume } from '../domain/volume';
import { gymExercise, plyoExercise } from '../domain/catalog';
import { generateGymInstance, generatePlyoInstance } from '../domain/generate';
import { dailyLoad, plyoSetsDone, readinessScore, weekLoad } from '../domain/load';
import { detectPRs } from '../domain/records';
import { dayFor, resolveSlot } from '../domain/schedule';
import { adaptationData, cleanItem, migrateAthleteContext, plannedBasketball, type AthleteProfile, type QuestionKey, type ScheduleItem } from '../domain/profile';
import { LOW_FATIGUE_PLYO_ID, seedData } from '../domain/seed';
import * as T from '../domain/templates';
import type {
  ApexData, BasketballSession, BodyMetricKind, GymPrescription, ISODate, PerformanceKind, PersonalRecord, PlanDay, PlyoLog,
  PlyometricInstance, PlyometricTemplate, RecoveryLog, RestState, Rotation, SessionInstance, SetLog, Settings, Template,
  User, WorkoutInstance, WorkoutInstanceExercise, WorkoutTemplate,
} from '../domain/types';
import { addDays, toISODate, uid } from '../domain/util';
import {
  clearData, loadData, writeAll, writeDocs, writeInstances, type Collection, type Doc, type KeyValueStore,
} from '../data/store';

export interface ApexState {
  ready: boolean;
  data: ApexData;
  /** A write to the device failed; the data is still in memory and a retry is offered. */
  saveError: boolean;
  /** Collections that were unreadable on launch and were reset (raw copy backed up). */
  recovered: Collection[];
}

export type SessionKind = SessionInstance['kind'];

/** A second identical tap inside this window is treated as the same action. */
export const DOUBLE_TAP_MS = 1500;

const mutable = (i: SessionInstance | undefined): i is SessionInstance => !!i && i.status !== 'completed';
const validNumber = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
type NewSet = Omit<SetLog, 'id' | 'completedAt'>;
const validSet = (s: NewSet) =>
  s.kind === 'skipped'
    ? s.weight === 0 && s.reps === 0 && s.rir === undefined
    : (s.kind === 'working' || s.kind === 'warmup') && validNumber(s.weight, 0, 1000) && validNumber(s.reps, 1, 1000) && (s.rir === undefined || validNumber(s.rir, 0, 10));
/** Planned working-set slots already resolved: done or deliberately skipped. */
const resolvedSets = (sets: SetLog[]) => sets.filter((s) => s.kind !== 'warmup').length;
const sameSet = (a: NewSet, b: NewSet) => a.kind === b.kind && a.weight === b.weight && a.reps === b.reps && a.rir === b.rir;
const cleanNote = (n?: string) => n?.trim().slice(0, 300) || undefined;
/** Stable order: by weekday, keeping the athlete's order within a day. */
const sortSchedule = (list: ScheduleItem[]) => list.map((x, i) => ({ x, i })).sort((a, b) => a.x.day - b.x.day || a.i - b.i).map(({ x }) => x);

export function createApex(store: KeyValueStore, clock: () => Date = () => new Date()) {
  let state: ApexState = { ready: false, data: seedData(clock()), saveError: false, recovered: [] };
  const listeners = new Set<() => void>();
  let writes: Promise<void> = Promise.resolve();
  let needsFullWrite = false;

  const today = () => toISODate(clock());
  const now = () => clock().toISOString();
  const ms = () => clock().getTime();
  const data = () => state.data;
  const emit = () => listeners.forEach((l) => l());
  const setState = (patch: Partial<ApexState>) => {
    state = { ...state, ...patch };
    emit();
  };

  function persist(job: () => Promise<void>) {
    // serialized so a later write can never land before an earlier one
    writes = writes
      .then(job)
      .then(() => {
        if (state.saveError && !needsFullWrite) setState({ saveError: false });
      })
      .catch((e) => {
        console.warn('[apex] save failed', e);
        needsFullWrite = true; // partial writes are possible; rewrite everything on retry
        setState({ saveError: true });
      });
    return writes;
  }

  function commit(patch: Partial<ApexData>) {
    const prev = state.data;
    state = { ...state, data: { ...state.data, ...patch } };
    const next = state.data;
    const docs = (Object.keys(patch) as Collection[]).filter((k): k is Doc => k !== 'instances');
    persist(async () => {
      if (needsFullWrite) {
        // an earlier write failed part-way: rewrite the latest full state instead of a diff
        needsFullWrite = false;
        await writeAll(store, data());
        return;
      }
      await writeDocs(store, next, docs);
      if (patch.instances) await writeInstances(store, next.instances, prev.instances);
    });
    emit();
  }

  // ---------- generation ----------

  const gymTemplate = (id: string) => data().templates.find((t) => t.id === id);
  const plyoTemplate = (id: string) => data().plyoTemplates.find((t) => t.id === id);
  const findInstance = (id: string) => data().instances.find((i) => i.id === id);

  /** Upcoming scheduled gym templates first, so "alternative" means swapping days. */
  function alternativesFrom(date: ISODate): WorkoutTemplate[] {
    const d = data();
    const upcoming: WorkoutTemplate[] = [];
    for (let i = 1; i <= 6; i++) {
      const slot = dayFor(d.plan, addDays(date, i)).gym;
      const r = slot && resolveSlot(d.plan, slot, d.instances);
      const t = r && gymTemplate(r.templateId);
      if (t && !upcoming.includes(t)) upcoming.push(t);
    }
    return [...upcoming, ...d.templates.filter((t) => !upcoming.includes(t))];
  }

  /** Template → schedule → recent context → load → recovery → volume → decision → instance. */
  function generate(kind: SessionKind, templateId: string, meta: { date: ISODate; id?: string; rotationId?: string; createdAt?: string; plan?: 'adapted' | 'kept'; alternativeFor?: SessionInstance['alternativeFor'] }) {
    // athlete context: an opt-out can keep basketball out of adaptation; it never adds load
    const ctx = buildContext(adaptationData(data()), meta.date);
    const m = { id: meta.id, date: meta.date, now: meta.createdAt ?? now(), rotationId: meta.rotationId, plan: meta.plan, alternativeFor: meta.alternativeFor };
    if (kind === 'gym') {
      const t = gymTemplate(templateId);
      return t && generateGymInstance(t, adaptGym(t, ctx, { alternatives: alternativesFrom(meta.date) }), m);
    }
    const t = plyoTemplate(templateId);
    const primerId = plyoTemplate(LOW_FATIGUE_PLYO_ID)?.id ?? data().plyoTemplates.find((p) => p.tag === 'LOW FATIGUE')?.id;
    return t && generatePlyoInstance(t, adaptPlyo(t, ctx, { primerId }), m);
  }

  /**
   * Make sure today's scheduled sessions exist and re-adapt every session that hasn't
   * started yet. Started and completed sessions are never touched.
   */
  function refreshToday() {
    const date = today();
    const d = data();
    let instances = d.instances.flatMap((i) => {
      if (i.status !== 'planned') return [i];
      // never-started sessions from past days are generated artifacts, not user data
      if (i.date < date) return [];
      if (i.date !== date) return [i];
      const fresh = generate(i.kind, i.templateId, { date, id: i.id, rotationId: i.rotationId, createdAt: i.createdAt, plan: i.plan, alternativeFor: i.alternativeFor });
      if (!fresh) return []; // template deleted → drop the plan
      // keep identity when nothing changed so nothing is rewritten to disk
      return [JSON.stringify(fresh) === JSON.stringify(i) ? i : fresh];
    });
    const day = dayFor(d.plan, date);
    for (const kind of ['gym', 'plyometric'] as const) {
      const slot = kind === 'gym' ? day.gym : day.plyo;
      if (slot && !instances.some((i) => i.date === date && i.kind === kind)) {
        const r = resolveSlot(d.plan, slot, instances);
        const inst = r && generate(kind, r.templateId, { date, rotationId: r.rotationId });
        if (inst) instances = [...instances, inst];
      }
    }
    if (instances.length !== d.instances.length || instances.some((x, k) => x !== d.instances[k])) commit({ instances });
  }

  /** Persist the schedule. Editing basketball items is the athlete telling Apex their practice days. */
  function saveSchedule(schedule: ScheduleItem[], basketball: boolean, timing = true) {
    const p = data().profile;
    commit({ profile: { ...p, schedule: sortSchedule(schedule), ...(basketball && { basketballDaysConfirmedAt: now() }) } });
    if (timing) refreshToday(); // schedule notes on today's plan may change (labels, durations don't)
  }

  // ---------- instance helpers ----------
  // Any edit to today's session (a set, a swap, a note…) starts it: from then on the instance is the
  // athlete's and re-adaptation never regenerates it, so session-only changes can't be lost.

  /** Mutations only reach sessions that aren't completed — history is read-only. */
  function updateInstance(id: string, fn: (i: SessionInstance) => SessionInstance) {
    const target = findInstance(id);
    if (!mutable(target)) return false;
    commit({ instances: data().instances.map((i) => (i === target ? fn(i) : i)) });
    return true;
  }

  // `activate` starts a planned session in the same write as its first logged set
  function updateGymExercise(instanceId: string, exId: string, fn: (e: WorkoutInstanceExercise) => WorkoutInstanceExercise, activate = false) {
    return updateInstance(instanceId, (i) => {
      if (i.kind !== 'gym') return i;
      return {
        ...(activate ? (ensureActive(i) as WorkoutInstance) : i),
        exercises: i.exercises.map((e) => {
          if (e.id !== exId) return e;
          const next = fn(e);
          const status = next.status === 'skipped' || next.status === 'removed' ? next.status : resolvedSets(next.sets) >= next.prescribed.sets ? 'done' : 'pending';
          return { ...next, status };
        }),
      };
    });
  }

  function updatePlyoExercise(instanceId: string, exId: string, fn: (e: PlyometricInstance['exercises'][number]) => PlyometricInstance['exercises'][number], activate = false) {
    return updateInstance(instanceId, (i) => {
      if (i.kind !== 'plyometric') return i;
      return {
        ...(activate ? (ensureActive(i) as PlyometricInstance) : i),
        exercises: i.exercises.map((e) => {
          if (e.id !== exId) return e;
          const next = fn(e);
          const status = next.status === 'skipped' || next.status === 'removed' ? next.status : plyoSetsDone(next.logs) >= next.prescribed.sets ? 'done' : 'pending';
          return { ...next, status };
        }),
      };
    });
  }

  const ensureActive = (i: SessionInstance): SessionInstance =>
    i.status === 'planned' ? { ...i, status: 'active', startedAt: now() } : i;

  const recent = (iso: string) => ms() - Date.parse(iso) < DOUBLE_TAP_MS;

  // ---------- public API ----------

  const api = {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** Resolves once every pending write has reached the store. */
    flush: () => writes,
    today,

    async init() {
      // storage itself unavailable (e.g. blocked in a private browser window): run on defaults, flag it
      const { data: loaded, recovered, needsFullWrite: full } = await loadData(store).catch((e) => {
        console.warn('[apex] storage unavailable', e);
        state = { ...state, saveError: true };
        return { data: undefined, recovered: [], needsFullWrite: false };
      });
      const seed = seedData(clock());
      const merged = loaded ? { ...seed, ...loaded } : seed;
      // older data: basketball times on the plan and flat "other" days become schedule items
      const migrated = migrateAthleteContext(merged);
      state = { ...state, ready: true, recovered, data: migrated ?? merged };
      if ((!loaded && !state.saveError) || full || (migrated && loaded)) await api.retrySave();
      refreshToday();
      emit();
    },

    /** Rewrite the whole state — after a failed write, a repair, or first launch. */
    retrySave() {
      needsFullWrite = false;
      return persist(() => writeAll(store, data()));
    },

    dismissRecovered() {
      setState({ recovered: [] });
    },

    refreshToday,

    /** Choose a session for today (rest day, or a different template). Replaces today's unstarted one. */
    planSession(kind: SessionKind, templateId: string) {
      const date = today();
      const existing = data().instances.find((i) => i.date === date && i.kind === kind && i.status === 'planned' && i.templateId === templateId && !i.rotationId);
      if (existing) return existing.id; // same choice twice → same session
      commit({ instances: data().instances.filter((i) => !(i.date === date && i.kind === kind && i.status === 'planned')) });
      const inst = generate(kind, templateId, { date });
      if (!inst) return undefined;
      commit({ instances: [...data().instances, inst] });
      return inst.id;
    },

    /**
     * Today's session for a template ("log all"): the open or planned one if there is one, so a
     * rotation day stays a rotation day; otherwise a freshly adapted plan. Never a duplicate.
     */
    openTemplate(kind: SessionKind, templateId: string) {
      const mine = data().instances.filter((i) => i.date === today() && i.kind === kind && i.templateId === templateId);
      const open = mine.find((i) => i.status === 'active') ?? mine.find((i) => i.status === 'planned');
      return open ? open.id : api.planSession(kind, templateId);
    },

    /** Take the engine's suggested alternative for an unstarted session. */
    useAlternative(instanceId: string) {
      const i = findInstance(instanceId);
      const alt = i?.decision.alternativeTemplateId;
      if (!i || !alt || i.status !== 'planned') return;
      // remember what it replaced: the label says "Alternative" and the athlete can go back
      const alternativeFor = i.alternativeFor ?? { templateId: i.templateId, templateName: i.templateName, rotationId: i.rotationId };
      const inst = generate(i.kind, alt, { date: i.date, id: i.id, createdAt: i.createdAt, alternativeFor });
      if (inst) updateInstance(i.id, () => inst);
    },

    /** Go back from the alternative to the session it replaced (rotation slot included). */
    undoAlternative(instanceId: string) {
      const i = findInstance(instanceId);
      const from = i?.alternativeFor;
      if (!i || !from || i.status !== 'planned') return;
      const inst = generate(i.kind, from.templateId, { date: i.date, id: i.id, createdAt: i.createdAt, rotationId: from.rotationId });
      if (inst) updateInstance(i.id, () => inst);
    },

    startInstance(id: string) {
      updateInstance(id, ensureActive);
    },

    /** Athlete control: train the template as written, or go back to Apex's adaptation. */
    setPlanMode(instanceId: string, plan: 'adapted' | 'kept') {
      const i = findInstance(instanceId);
      if (!i || i.status !== 'planned' || (i.plan ?? 'adapted') === plan) return;
      const inst = generate(i.kind, i.templateId, { date: i.date, id: i.id, rotationId: i.rotationId, createdAt: i.createdAt, plan, alternativeFor: i.alternativeFor });
      if (inst) updateInstance(i.id, () => inst);
    },

    /** Take today as a recovery day: the planned session is set aside (not deleted, not completed). */
    takeRecoveryDay(instanceId: string) {
      updateInstance(instanceId, (i) => (i.status === 'planned' ? { ...i, status: 'skipped' } : i));
    },

    undoRecoveryDay(instanceId: string) {
      updateInstance(instanceId, (i) => (i.status === 'skipped' ? { ...i, status: 'planned' } : i));
      refreshToday();
    },

    /** Returns the stored set, the existing one for a duplicate tap, or undefined if rejected. */
    logSet(instanceId: string, exId: string, set: NewSet): SetLog | undefined {
      if (!validSet(set) || set.kind === 'skipped') return undefined; // skipping is skipSet

      const inst = findInstance(instanceId);
      const ex = inst?.kind === 'gym' ? inst.exercises.find((e) => e.id === exId) : undefined;
      if (!mutable(inst) || !ex) return undefined;
      const last = ex.sets[ex.sets.length - 1];
      if (last && sameSet(last, set) && recent(last.completedAt)) return last;
      const log: SetLog = { ...set, note: cleanNote(set.note), id: uid('s'), completedAt: now() };
      updateGymExercise(instanceId, exId, (e) => ({ ...e, sets: [...e.sets, log] }), true);
      return log;
    },

    /** Edit a logged set: values, warm-up vs working, or its note. Invalid edits are ignored. */
    updateSet(instanceId: string, exId: string, setId: string, patch: Partial<Omit<SetLog, 'id' | 'completedAt'>>) {
      updateGymExercise(instanceId, exId, (e) => ({
        ...e,
        sets: e.sets.map((s) => {
          if (s.id !== setId) return s;
          const note = 'note' in patch ? cleanNote(patch.note) : s.note;
          // a skipped set stays skipped (undo = delete it); a performed set can't become "skipped"
          if (s.kind === 'skipped' || patch.kind === 'skipped') return { ...s, note };
          const next = { ...s, ...patch, note };
          return validSet(next) ? next : s;
        }),
      }));
    },

    /**
     * Quick log: record several already-completed sets at once (no rest timer). A repeated
     * SAVE tap re-sends the same batch and is ignored. Returns how many sets were stored.
     */
    logSets(instanceId: string, exId: string, sets: NewSet[]): number {
      if (!sets.length || sets.length > 30 || !sets.every(validSet)) return 0;
      const inst = findInstance(instanceId);
      const ex = inst?.kind === 'gym' ? inst.exercises.find((e) => e.id === exId) : undefined;
      if (!mutable(inst) || !ex) return 0;
      const tail = ex.sets.slice(-sets.length);
      if (tail.length === sets.length && tail.every((s, k) => sameSet(s, sets[k])) && recent(tail[tail.length - 1].completedAt)) return 0;
      const at = now();
      const logs = sets.map((s): SetLog => ({ ...s, note: cleanNote(s.note), id: uid('s'), completedAt: at }));
      updateGymExercise(instanceId, exId, (e) => ({ ...e, sets: [...e.sets, ...logs] }), true);
      return logs.length;
    },

    deleteSet(instanceId: string, exId: string, setId: string) {
      updateGymExercise(instanceId, exId, (e) => ({ ...e, sets: e.sets.filter((s) => s.id !== setId) }));
    },

    /** Add one more working set to the prescription (the "add set" button). */
    addPrescribedSet(instanceId: string, exId: string) {
      updateGymExercise(instanceId, exId, (e) => ({ ...e, status: 'pending', prescribed: { ...e.prescribed, sets: Math.min(20, e.prescribed.sets + 1) } }), true);
    },

    /**
     * Skip the next planned working set. It is stored as skipped — distinct from a logged set, a
     * deleted set or a set that was never planned — and counts toward finishing the exercise only.
     */
    skipSet(instanceId: string, exId: string): SetLog | undefined {
      const inst = findInstance(instanceId);
      const ex = inst?.kind === 'gym' ? inst.exercises.find((e) => e.id === exId) : undefined;
      if (!mutable(inst) || !ex || ex.status === 'skipped' || ex.status === 'removed' || resolvedSets(ex.sets) >= ex.prescribed.sets) return undefined;
      const last = ex.sets[ex.sets.length - 1];
      if (last?.kind === 'skipped' && recent(last.completedAt)) return last; // double tap
      const log: SetLog = { id: uid('s'), kind: 'skipped', weight: 0, reps: 0, completedAt: now() };
      updateGymExercise(instanceId, exId, (e) => ({ ...e, sets: [...e.sets, log] }), true);
      return log;
    },

    /** One working set fewer for this session (never below one: skip the exercise instead). */
    removePrescribedSet(instanceId: string, exId: string) {
      updateGymExercise(instanceId, exId, (e) => ({ ...e, prescribed: { ...e.prescribed, sets: Math.max(1, e.prescribed.sets - 1) } }), true);
    },

    /** Change this session's prescription for one exercise. The template is untouched. */
    editPrescription(instanceId: string, exId: string, patch: Partial<GymPrescription>) {
      const { sets, repRange, restSec, targetRir } = patch;
      if (sets !== undefined && !validNumber(sets, 1, 20)) return;
      if (repRange && !(validNumber(repRange[0], 1, 100) && validNumber(repRange[1], repRange[0], 100))) return;
      if (restSec !== undefined && !validNumber(restSec, 0, 900)) return;
      if (targetRir !== undefined && !validNumber(targetRir, 0, 5)) return;
      // giving an exercise Apex removed some sets brings it back into today's session
      updateGymExercise(instanceId, exId, (e) => ({
        ...e,
        status: e.status === 'removed' && sets ? 'pending' : e.status,
        prescribed: { ...e.prescribed, ...patch, repRange: repRange ? [repRange[0], repRange[1]] : e.prescribed.repRange },
      }), true);
    },

    /** Superset this exercise with the next one in this session, or unlink its group. */
    toggleSuperset(instanceId: string, exId: string) {
      updateInstance(instanceId, (i0) => {
        if (i0.kind !== 'gym') return i0;
        const i = ensureActive(i0) as WorkoutInstance;
        const k = i.exercises.findIndex((e) => e.id === exId);
        const cur = i.exercises[k];
        if (!cur) return i;
        if (cur.supersetGroup) {
          const g = cur.supersetGroup;
          return { ...i, exercises: i.exercises.map((e) => (e.supersetGroup === g ? { ...e, supersetGroup: undefined } : e)) };
        }
        const next = i.exercises.slice(k + 1).find((e) => e.status !== 'removed');
        if (!next) return i;
        const g = next.supersetGroup ?? uid('ss');
        return { ...i, exercises: i.exercises.map((e) => (e === cur || e === next ? { ...e, supersetGroup: g } : e)) };
      });
    },

    logPlyo(instanceId: string, exId: string, log: Omit<PlyoLog, 'id' | 'completedAt'>): PlyoLog | undefined {
      if (!validNumber(log.reps, 1, 500) || (log.value !== undefined && !validNumber(log.value, 0, 2000))) return undefined;
      const inst = findInstance(instanceId);
      const ex = inst?.kind === 'plyometric' ? inst.exercises.find((e) => e.id === exId) : undefined;
      if (!mutable(inst) || !ex) return undefined;
      const last = ex.logs[ex.logs.length - 1];
      if (last && last.reps === log.reps && last.value === log.value && last.side === log.side && recent(last.completedAt)) return last;
      const entry: PlyoLog = { ...log, id: uid('pl'), completedAt: now() };
      updatePlyoExercise(instanceId, exId, (e) => ({ ...e, logs: [...e.logs, entry] }), true);
      return entry;
    },

    /** Quick log for plyometrics: several completed sets at once; a repeated SAVE is ignored. */
    logPlyos(instanceId: string, exId: string, logs: Omit<PlyoLog, 'id' | 'completedAt'>[]): number {
      const valid = (l: Omit<PlyoLog, 'id' | 'completedAt'>) => validNumber(l.reps, 1, 500) && (l.value === undefined || validNumber(l.value, 0, 2000));
      if (!logs.length || logs.length > 30 || !logs.every(valid)) return 0;
      const inst = findInstance(instanceId);
      const ex = inst?.kind === 'plyometric' ? inst.exercises.find((e) => e.id === exId) : undefined;
      if (!mutable(inst) || !ex) return 0;
      const same = (a: Omit<PlyoLog, 'id' | 'completedAt'>, b: Omit<PlyoLog, 'id' | 'completedAt'>) => a.reps === b.reps && a.value === b.value && a.side === b.side;
      const tail = ex.logs.slice(-logs.length);
      if (tail.length === logs.length && tail.every((l, k) => same(l, logs[k])) && recent(tail[tail.length - 1].completedAt)) return 0;
      const at = now();
      const entries = logs.map((l): PlyoLog => ({ ...l, id: uid('pl'), completedAt: at }));
      updatePlyoExercise(instanceId, exId, (e) => ({ ...e, logs: [...e.logs, ...entries] }), true);
      return entries.length;
    },

    deletePlyoLog(instanceId: string, exId: string, logId: string) {
      updatePlyoExercise(instanceId, exId, (e) => ({ ...e, logs: e.logs.filter((l) => l.id !== logId) }));
    },

    setExerciseSkipped(instanceId: string, exId: string, skipped: boolean) {
      const status = skipped ? 'skipped' : 'pending';
      if (findInstance(instanceId)?.kind === 'gym') updateGymExercise(instanceId, exId, (e) => ({ ...e, status }), true);
      else updatePlyoExercise(instanceId, exId, (e) => ({ ...e, status }), true);
    },

    /** Swap an exercise for this session only; the template keeps the original. */
    /**
     * Swap an exercise for this session only; the template keeps the original. The replacement
     * inherits the slot (sets, rep target, effort, rest). Choosing the planned exercise again is
     * "back to original". Sets already logged are never discarded: they stay with the exercise they
     * were done on, and the replacement takes the remaining sets as its own entry.
     */
    substituteExercise(instanceId: string, exId: string, exerciseId: string) {
      updateInstance(instanceId, (i0) => {
        const i = ensureActive(i0);
        const k = i.exercises.findIndex((e) => e.id === exId);
        const e = i.exercises[k];
        if (!e || e.exerciseId === exerciseId || e.status === 'removed') return i0;
        const gym = i.kind === 'gym';
        const original = { id: e.substitutedFromId ?? e.exerciseId, name: e.substitutedFrom ?? e.name };
        const back = exerciseId === original.id;
        const identity = back
          ? { exerciseId, name: original.name, substitutedFrom: undefined, substitutedFromId: undefined }
          : { exerciseId, name: gym ? gymExercise(exerciseId).name : plyoExercise(exerciseId).name, substitutedFrom: original.name, substitutedFromId: original.id };
        const done = gym ? resolvedSets((e as WorkoutInstanceExercise).sets) : Math.floor(plyoSetsDone((e as PlyometricInstance['exercises'][number]).logs));
        const status = (sets: number) => (e.status === 'skipped' ? 'skipped' as const : done >= sets ? 'done' as const : 'pending' as const);
        let exercises: SessionInstance['exercises'];
        if (!done) {
          // nothing performed yet (warm-ups stay with the slot): swap in place
          exercises = i.exercises.map((x) => (x === e ? { ...x, ...identity } : x)) as SessionInstance['exercises'];
        } else {
          const kept = { ...e, prescribed: { ...e.prescribed, sets: Math.max(1, done) }, status: status(Math.max(1, done)) };
          const remaining = Math.max(1, e.prescribed.sets - done);
          const next = {
            ...e, ...identity, id: uid('ie'), prescribed: { ...e.prescribed, sets: remaining }, status: 'pending' as const, supersetGroup: undefined,
            ...(gym ? { templateSets: 0, sets: [] } : { template: null, logs: [] }),
          };
          exercises = [...i.exercises.slice(0, k), kept, next, ...i.exercises.slice(k + 1)] as SessionInstance['exercises'];
        }
        return { ...i, exercises } as SessionInstance;
      });
    },

    /** Add an exercise to today's session only. Returns its id in the session. */
    addExerciseToInstance(instanceId: string, exerciseId: string): string | undefined {
      let id: string | undefined;
      updateInstance(instanceId, (i) => {
        if (i.kind !== 'gym') return i;
        const last = i.exercises[i.exercises.length - 1];
        if (last && last.exerciseId === exerciseId && last.templateSets === 0 && last.sets.length === 0 && !last.substitutedFrom) {
          id = last.id;
          return i; // double tap
        }
        const ex = gymExercise(exerciseId);
        id = uid('ie');
        const added: WorkoutInstanceExercise = {
          id, exerciseId, name: ex.name, templateSets: 0, status: 'pending', sets: [],
          prescribed: { sets: 3, warmupSets: 0, repRange: [...ex.repRange], restSec: ex.restSec, targetRir: 2 },
        };
        return { ...(ensureActive(i) as WorkoutInstance), exercises: [...i.exercises, added] };
      });
      return id;
    },

    setExerciseNotes(instanceId: string, exId: string, notes: string) {
      updateInstance(instanceId, (i) => ({ ...ensureActive(i), exercises: i.exercises.map((e) => (e.id === exId ? { ...e, notes: cleanNote(notes) } : e)) }) as SessionInstance);
    },

    setInstanceNotes(instanceId: string, notes: string) {
      updateInstance(instanceId, (i) => ({ ...ensureActive(i), notes: cleanNote(notes) }));
    },

    /** Rest timer lives on the session so navigating away or restarting keeps it. */
    setRest(instanceId: string, rest: RestState | undefined) {
      updateInstance(instanceId, (i) => ({ ...i, rest }));
    },

    /** Complete a session: store actual performance, detect PRs, re-adapt what's left today. Idempotent. */
    finishInstance(id: string, opts: { sessionRpe?: number } = {}): PersonalRecord[] {
      const i = findInstance(id);
      if (!i) return [];
      if (i.status === 'completed') return data().records.filter((r) => r.instanceId === id);
      const sessionRpe = validNumber(opts.sessionRpe, 1, 10) ? opts.sessionRpe : i.sessionRpe;
      const done = { ...i, status: 'completed', rest: undefined, sessionRpe, startedAt: i.startedAt ?? now(), completedAt: now() } as SessionInstance;
      const prs = detectPRs(done, data().instances);
      commit({ instances: data().instances.map((x) => (x.id === id ? done : x)), records: [...data().records, ...prs] });
      refreshToday();
      return prs;
    },

    /** Discard an unfinished session. Completed history can't be discarded from here. */
    discardInstance(id: string) {
      if (!mutable(findInstance(id))) return;
      commit({ instances: data().instances.filter((i) => i.id !== id) });
      refreshToday();
    },

    logBasketball(input: Omit<BasketballSession, 'id' | 'sport' | 'loggedAt' | 'date'> & { date?: ISODate }) {
      if (!validNumber(input.durationMin, 1, 600) || !validNumber(input.rpe, 1, 10)) return undefined;
      const date = input.date ?? today();
      const last = data().basketball[data().basketball.length - 1];
      if (last && last.date === date && last.durationMin === input.durationMin && last.rpe === input.rpe && last.sessionType === input.sessionType && recent(last.loggedAt)) return last;
      const session: BasketballSession = { ...input, id: uid('bb'), sport: 'basketball', date, loggedAt: now() };
      commit({ basketball: [...data().basketball, session] });
      refreshToday();
      return session;
    },

    deleteBasketball(id: string) {
      commit({ basketball: data().basketball.filter((b) => b.id !== id) });
      refreshToday();
    },

    logRecovery(r: Omit<RecoveryLog, 'date'>) {
      if (!validNumber(r.sleepHours, 0, 24) || !validNumber(r.soreness, 1, 5) || !validNumber(r.energy, 1, 5)) return;
      const date = today();
      commit({ recovery: [...data().recovery.filter((x) => x.date !== date), { ...r, date }] });
      refreshToday();
    },

    // ---- templates ----

    createTemplate(kind: Template['kind'], name: string) {
      const t = T.createTemplate(kind, name, now());
      api.saveTemplate(t);
      return t.id;
    },

    saveTemplate(t: Template) {
      const upsert = <X extends Template>(list: X[], x: X) => (list.some((y) => y.id === x.id) ? list.map((y) => (y.id === x.id ? x : y)) : [...list, x]);
      if (t.kind === 'gym') commit({ templates: upsert(data().templates, t) });
      else commit({ plyoTemplates: upsert(data().plyoTemplates, t as PlyometricTemplate) });
      refreshToday();
    },

    duplicateTemplate(id: string) {
      const t = gymTemplate(id) ?? plyoTemplate(id);
      if (!t) return undefined;
      const copy = T.duplicateTemplate(t, now());
      api.saveTemplate(copy);
      return copy.id;
    },

    deleteTemplate(id: string) {
      const d = data();
      const strip = (slot: PlanDay['gym']) => (slot && 'templateId' in slot && slot.templateId === id ? undefined : slot);
      commit({
        templates: d.templates.filter((t) => t.id !== id),
        plyoTemplates: d.plyoTemplates.filter((t) => t.id !== id),
        plan: {
          ...d.plan,
          days: d.plan.days.map((day) => ({ ...day, gym: strip(day.gym), plyo: strip(day.plyo) })),
          rotations: d.plan.rotations.map((r) => ({ ...r, templateIds: r.templateIds.filter((t) => t !== id) })),
        },
      });
      refreshToday();
    },

    // ---- plan ----

    setPlanDay(index: number, day: PlanDay) {
      const d = data();
      commit({ plan: { ...d.plan, days: d.plan.days.map((x, i) => (i === index ? day : x)) } });
      refreshToday();
    },

    // ---- athlete profile ----

    /** Edit any profile fact. A changed basketball-load preference re-adapts today's plan. */
    updateProfile(patch: Partial<AthleteProfile>) {
      const before = data().profile;
      commit({ profile: { ...before, ...patch } });
      if ('useBasketballLoad' in patch && patch.useBasketballLoad !== before.useBasketballLoad) refreshToday();
    },

    /** Answer a contextual question: store the fact and forget the snooze for it. */
    answerQuestion(key: QuestionKey, patch: Partial<AthleteProfile>) {
      const p = data().profile;
      const prompts = { ...p.prompts };
      delete prompts[key];
      api.updateProfile({ ...patch, prompts, lastPromptAt: now() });
    },

    /** NOT NOW (ask again later, backing off) or SKIP (don't ask again; Profile can still set it). */
    deferQuestion(key: QuestionKey, skip = false) {
      const p = data().profile;
      const prev = p.prompts?.[key];
      commit({ profile: { ...p, lastPromptAt: now(), prompts: { ...p.prompts, [key]: { at: now(), count: (prev?.count ?? 0) + 1, ...(skip && { skipped: true }) } } } });
    },

    /** The athlete's usual basketball days. Existing items (times, labels) are kept; others are added or removed. */
    setBasketballDays(days: number[]) {
      const d = data();
      const want = new Set(days.filter((x) => Number.isInteger(x) && x >= 0 && x < 7));
      const schedule = (d.profile.schedule ?? [])
        .filter((i) => i.kind !== 'basketball' || want.has(i.day))
        .map((i) => (i.kind === 'basketball' ? { ...i, enabled: true } : i));
      for (const day of want) if (!schedule.some((i) => i.kind === 'basketball' && i.day === day)) schedule.push({ id: uid('sch'), day, kind: 'basketball', enabled: true });
      const prompts = { ...d.profile.prompts };
      delete prompts.basketballDays;
      delete prompts.suggestBasketballDays;
      delete prompts.basketballWeekday;
      commit({ profile: { ...d.profile, schedule: sortSchedule(schedule), prompts, basketballDaysConfirmedAt: now(), lastPromptAt: now() } });
      refreshToday();
    },

    /** "Do you usually play on Tuesdays?" Yes adds the day to the week; No is remembered and never asked again. */
    answerBasketballWeekday(day: number, usual: boolean) {
      const d = data();
      if (!Number.isInteger(day) || day < 0 || day > 6) return;
      const p = d.profile;
      const prompts = { ...p.prompts };
      delete prompts.basketballWeekday;
      const schedule = [...(p.schedule ?? [])];
      if (usual && !schedule.some((i) => i.kind === 'basketball' && i.day === day && i.enabled)) {
        const existing = schedule.findIndex((i) => i.kind === 'basketball' && i.day === day);
        if (existing >= 0) schedule[existing] = { ...schedule[existing], enabled: true };
        else schedule.push({ id: uid('sch'), day, kind: 'basketball', enabled: true });
      }
      const notUsual = usual ? p.basketballNotUsual?.filter((x) => x !== day) : [...new Set([...(p.basketballNotUsual ?? []), day])];
      commit({ profile: { ...p, schedule: sortSchedule(schedule), basketballNotUsual: notUsual, prompts, lastPromptAt: now() } });
      refreshToday();
    },

    // ---- recurring schedule: several activities a day, each optional in every detail ----

    addScheduleItem(item: Omit<ScheduleItem, 'id' | 'enabled'> & { enabled?: boolean }): string | undefined {
      const clean = cleanItem({ ...item, id: uid('sch') });
      if (!clean) return undefined;
      saveSchedule([...(data().profile.schedule ?? []), clean], clean.kind === 'basketball');
      return clean.id;
    },

    updateScheduleItem(id: string, patch: Partial<Omit<ScheduleItem, 'id'>>) {
      const list = data().profile.schedule ?? [];
      const cur = list.find((i) => i.id === id);
      if (!cur) return;
      // explicit clears: a patch value of undefined removes that detail
      const merged = { ...cur, ...patch } as Partial<ScheduleItem> & { id: string };
      const clean = cleanItem(merged);
      if (!clean) return;
      const timing = (['day', 'kind', 'time', 'enabled'] as const).some((k) => k in patch);
      saveSchedule(list.map((i) => (i.id === id ? clean : i)), clean.kind === 'basketball' || cur.kind === 'basketball', timing);
    },

    removeScheduleItem(id: string) {
      const list = data().profile.schedule ?? [];
      const cur = list.find((i) => i.id === id);
      if (cur) saveSchedule(list.filter((i) => i.id !== id), cur.kind === 'basketball');
    },

    /** Reorder within its day (the athlete's order of activities). */
    moveScheduleItem(id: string, dir: -1 | 1) {
      const list = [...(data().profile.schedule ?? [])];
      const k = list.findIndex((i) => i.id === id);
      if (k < 0) return;
      const sameDay = list.map((x, j) => ({ x, j })).filter(({ x }) => x.day === list[k].day);
      const pos = sameDay.findIndex(({ j }) => j === k);
      const other = sameDay[pos + dir];
      if (!other) return;
      [list[k], list[other.j]] = [list[other.j], list[k]];
      saveSchedule(list, false);
    },

    saveRotation(rot: Rotation) {
      const d = data();
      const rotations = d.plan.rotations.some((r) => r.id === rot.id) ? d.plan.rotations.map((r) => (r.id === rot.id ? rot : r)) : [...d.plan.rotations, rot];
      commit({ plan: { ...d.plan, rotations } });
      refreshToday();
    },

    // ---- body + athletic ----

    addBodyMetric(kind: BodyMetricKind, value: number) {
      if (!validNumber(value, 0.1, 1000)) return;
      commit({ bodyMetrics: [...data().bodyMetrics, { id: uid('bm'), date: today(), kind, value }] });
    },

    addPerformance(kind: PerformanceKind, value: number) {
      if (!validNumber(value, 0.1, 2000)) return;
      commit({ performance: [...data().performance, { id: uid('pm'), date: today(), kind, value }] });
    },

    updateSettings(patch: Partial<Settings>) {
      commit({ settings: { ...data().settings, ...patch } });
    },

    updateUser(patch: Partial<User>) {
      commit({ user: { ...data().user, ...patch } });
    },

    async resetAll() {
      await writes;
      await clearData(store, data());
      state = { ...state, ready: true, data: seedData(clock()), recovered: [] };
      await api.retrySave();
      refreshToday();
      emit();
    },
  };
  return api;
}

export type Apex = ReturnType<typeof createApex>;

// ---------- read models shared by screens ----------

export function todayOverview(d: ApexData, date: ISODate) {
  const day = dayFor(d.plan, date);
  const latest = (kind: SessionKind) =>
    d.instances.filter((i) => i.date === date && i.kind === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
  const ctx = buildContext(d, date);
  const stress = computeStrain(ctx);
  const load = dailyLoad(d, date);
  return {
    date,
    day,
    gym: latest('gym') as WorkoutInstance | undefined,
    plyo: latest('plyometric') as PlyometricInstance | undefined,
    active: d.instances.find((i) => i.status === 'active'),
    basketball: { planned: plannedBasketball(d, date)?.item, sessions: d.basketball.filter((b) => b.date === date) },
    recovery: d.recovery.find((r) => r.date === date),
    readiness: readinessScore(ctx.recovery, ctx.priorDayBand),
    stress,
    load,
    week: weekLoad(d, date),
  };
}

/** Progress screen: load by region with trend, muscle volume vs targets, insights. */
export function progressOverview(d: ApexData, date: ISODate) {
  const ctx = buildContext(d, date);
  const strain = computeStrain(ctx);
  return {
    regions: (['lower', 'upper', 'trunk', 'jump'] as const).map((area) => strain.areas[area]),
    volume: muscleVolume(d.instances, date),
    insights: insights(ctx, d.instances),
    historyDays: ctx.historyDays,
  };
}
