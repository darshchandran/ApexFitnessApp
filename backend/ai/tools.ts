// Controlled APEX tools — the model's only window into APEX.
//
// Authorization boundary: a tool sees exactly one athlete's data — `ctx.data`, loaded for the
// authenticated caller, frozen, for this request only. No tool takes a user id, a query, a path or
// a URL, so the model can't name anyone else's data or reach storage, SQL, files, the network or a
// shell. Every number comes from existing APEX services/domain code; nothing here recalculates
// training logic. Read tools only read; the one 'propose' tool drafts a write for the athlete to
// confirm in the app and executes nothing.
import { GYM_EXERCISES, gymExercise, hasGymExercise } from '../../src/domain/catalog';
import { APEX_CONFIG } from '../../src/domain/config';
import { completed } from '../../src/domain/history';
import { dayLoads, plyoSetsDone } from '../../src/domain/load';
import { adaptationStatus, exerciseBests, exerciseHistory, liveExercise, nextProgression, workoutSummary } from '../../src/domain/logbook';
import { localize, profileFacts, weeklySchedule, wtu, type DayEntry, type Units } from '../../src/domain/profile';
import { PR_LABEL } from '../../src/domain/records';
import { resolveSlot } from '../../src/domain/schedule';
import { buildContext } from '../../src/domain/strain';
import type { ApexData, ISODate, SessionInstance, SetLog } from '../../src/domain/types';
import { addDays, weekdayIndex } from '../../src/domain/util';
import { muscleVolume } from '../../src/domain/volume';
import { progressOverview, todayOverview } from '../../src/services/apex';
import { ACTIONS, BASKETBALL_TYPES, check, S, type ActionProposal, type Schema } from './schemas';

export interface ToolContext {
  /** The authenticated athlete's data for this request (frozen), or null when none was sent. */
  readonly data: Readonly<ApexData> | null;
  /** The athlete's local date. */
  readonly today: ISODate;
  /** Write proposals drafted during this request — the only thing a tool may add to. */
  readonly proposals: ActionProposal[];
}

type Args = Record<string, unknown>;

export interface ApexTool {
  name: string;
  description: string;
  /** 'read' looks; 'propose' drafts a write for the athlete to confirm. There is no 'write'. */
  access: 'read' | 'propose';
  input: Schema;
  output: Schema;
  run(data: ApexData, args: Args, ctx: ToolContext): unknown;
}

// ---------- shared shapes ----------

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const unitsOf = (d: ApexData): Units => d.profile.units ?? 'kg';
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const round = Math.round;
const isWorking = (s: SetLog) => s.kind === 'working';
const templateName = (d: ApexData, id: string) => [...d.templates, ...d.plyoTemplates].find((t) => t.id === id)?.name ?? null;

function setText(s: SetLog, u: Units, unit?: 'reps' | 'sec') {
  if (s.kind === 'skipped') return 'skipped';
  const amount = unit === 'sec' ? `${s.reps}s` : s.weight > 0 ? `${s.reps}` : `${s.reps} reps`;
  return `${s.weight > 0 ? `${wtu(s.weight, u)} × ` : ''}${amount}${s.rir !== undefined ? ` @ ${s.rir} RIR` : ''}${s.kind === 'warmup' ? ' (warm-up)' : ''}`;
}

const EXERCISE = S.obj({ id: S.str(), name: S.str() });
const EXERCISE_QUERY = S.text('^[^\\n]{1,80}$', 'The exercise as the athlete names it (e.g. "chest supported row"), or its APEX id');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** An exercise by id or name — the athlete's own template wording or the catalog's. Ambiguous → candidates. */
function findExercise(d: ApexData, q: string): { exercise: { id: string; name: string } | null; matches: { id: string; name: string }[] } {
  if (hasGymExercise(q)) return { exercise: { id: q, name: gymExercise(q).name }, matches: [] };
  const n = norm(q);
  const named = [...d.templates.flatMap((t) => t.exercises.map((e) => ({ id: e.exerciseId, name: e.name }))), ...GYM_EXERCISES]
    .filter((x) => hasGymExercise(x.id));
  const pick = (f: (name: string) => boolean) =>
    [...new Map(named.filter((x) => f(norm(x.name))).map((x) => [x.id, { id: x.id, name: gymExercise(x.id).name }])).values()];
  const words = n.split(' ').filter(Boolean);
  const exact = pick((x) => x === n);
  // every word the athlete used appears in the name ("smith squat" → Smith Machine Squat), or the name is inside the query
  const hits = exact.length ? exact : words.length ? pick((x) => words.every((w) => x.includes(w)) || n.includes(x)) : [];
  return hits.length === 1 ? { exercise: hits[0], matches: [] } : { exercise: null, matches: hits.slice(0, 8) };
}

const SESSION = S.obj({
  template: S.str(),
  status: S.oneOf(['planned', 'active', 'completed', 'skipped']),
  label: S.str('As planned / Adapted / Plan kept / Alternative / Recovery day / Rest advised'),
  exercises: S.list(S.obj({
    name: S.str(), status: S.oneOf(['pending', 'done', 'skipped', 'removed']), prescribed: S.str(),
    template_sets: S.num(), done_sets: S.num(), substituted_from: S.orNull(S.str()),
  })),
});

function sessionView(i: SessionInstance) {
  return {
    template: i.templateName,
    status: i.status,
    label: adaptationStatus(i),
    exercises: i.kind === 'gym'
      ? i.exercises.map((e) => ({
        name: e.name, status: e.status, prescribed: `${e.prescribed.sets} × ${e.prescribed.repRange[0]}–${e.prescribed.repRange[1]}`,
        template_sets: e.templateSets, done_sets: e.sets.filter(isWorking).length, substituted_from: nul(e.substitutedFrom),
      }))
      : i.exercises.map((e) => ({
        name: e.name, status: e.status, prescribed: `${e.prescribed.sets} × ${e.prescribed.reps}${e.prescribed.perSide ? ' per side' : ''}`,
        template_sets: e.template?.sets ?? 0, done_sets: plyoSetsDone(e.logs), substituted_from: nul(e.substitutedFrom),
      })),
  };
}

const DECISION = S.obj({
  session: S.oneOf(['gym', 'plyometrics']),
  template: S.str(),
  status: S.oneOf(['planned', 'active', 'completed', 'skipped']),
  label: S.str(),
  outcome: S.oneOf(['normal', 'reduced', 'heavily_reduced', 'alternative', 'deferred']),
  headline: S.str(),
  reasons: S.list(S.str()),
  volume_change_pct: S.num(),
  planned_volume: S.orNull(S.num()),
  prescribed_volume: S.orNull(S.num()),
  unit: S.orNull(S.oneOf(['sets', 'contacts'])),
  areas: S.list(S.obj({ area: S.str(), band: S.str(), change_pct: S.num(), preserved: S.bool() })),
  removed: S.list(S.str()),
  modified: S.list(S.obj({ name: S.str(), from: S.str(), to: S.str() })),
  alternative: S.orNull(S.str()),
  readiness: S.orNull(S.num()),
  recent_sessions: S.list(S.str()),
  schedule_context: S.list(S.str()),
  athlete_kept_plan: S.bool(),
});

function decisionView(d: ApexData, i: SessionInstance, u: Units) {
  const x = i.decision;
  return {
    session: i.kind === 'gym' ? 'gym' : 'plyometrics',
    template: i.templateName,
    status: i.status,
    label: adaptationStatus(i),
    outcome: x.outcome,
    headline: localize(x.headline, u),
    reasons: x.reasons.map((r) => localize(r, u)),
    volume_change_pct: round((x.volumeFactor - 1) * 100),
    planned_volume: nul(x.plannedVolume),
    prescribed_volume: nul(x.prescribedVolume),
    unit: nul(x.unit),
    areas: (x.areas ?? []).map((a) => ({ area: a.area, band: a.band, change_pct: round(a.change * 100), preserved: a.preserved })),
    removed: x.removed ?? [],
    modified: (x.modified ?? []).map((m) => ({ name: m.name, from: localize(m.from, u), to: localize(m.to, u) })),
    alternative: x.alternativeTemplateId ? templateName(d, x.alternativeTemplateId) : null,
    readiness: nul(x.readiness),
    recent_sessions: x.inputs?.recent ?? [],
    schedule_context: x.inputs?.context ?? [],
    athlete_kept_plan: i.plan === 'kept',
  };
}

function programName(d: ApexData, e: DayEntry) {
  if (e.templateId) return templateName(d, e.templateId);
  const rot = e.rotationId && d.plan.rotations.find((r) => r.id === e.rotationId);
  if (!rot) return null;
  const next = resolveSlot(d.plan, { rotationId: rot.id }, d.instances);
  return `${rot.name} rotation${next ? ` (next: ${templateName(d, next.templateId)})` : ''}`;
}

const NONE = S.obj({});
const LOAD_NOTE = 'Training load is APEX’s internal programming number (arbitrary units), not a medical measure. Only logged sessions count.';

// ---------- the tools ----------

export const TOOLS: ApexTool[] = [
  {
    name: 'get_athlete_profile',
    access: 'read',
    description: 'What the athlete has told APEX about themselves: goal, sport, units, experience, focus, usual gym time, body and targets. Also lists what is still unknown.',
    input: NONE,
    output: S.obj({
      source: S.oneOf(['athlete_reported']),
      goal: S.orNull(S.str()), sport: S.orNull(S.str()), units: S.orNull(S.str()), experience: S.orNull(S.str()), focus: S.orNull(S.str()),
      usual_gym_time: S.orNull(S.str()), gym_after_basketball: S.orNull(S.str()), basketball_adjusts_gym: S.bool(),
      bodyweight: S.orNull(S.obj({ value: S.str(), date: S.str() })),
      height_cm: S.orNull(S.num()), target_bodyweight: S.orNull(S.str()), vertical_target_cm: S.orNull(S.num()),
      unknown: S.list(S.str()),
    }),
    run(d) {
      const p = d.profile;
      const u = unitsOf(d);
      const bw = d.bodyMetrics.filter((m) => m.kind === 'bodyweight').reduce<(typeof d.bodyMetrics)[number] | undefined>((a, b) => (!a || b.date >= a.date ? b : a), undefined);
      const facts = profileFacts(d);
      return {
        source: 'athlete_reported',
        goal: nul(p.goal), sport: nul(p.sport), units: nul(p.units), experience: nul(p.experience), focus: nul(p.focus),
        usual_gym_time: nul(p.gymTime), gym_after_basketball: nul(p.gymAfterBasketball), basketball_adjusts_gym: p.useBasketballLoad !== false,
        bodyweight: bw ? { value: wtu(bw.value, u), date: bw.date } : null,
        height_cm: nul(p.heightCm),
        target_bodyweight: p.targetBodyweightKg === undefined ? null : wtu(p.targetBodyweightKg, u),
        vertical_target_cm: nul(p.verticalTargetCm),
        unknown: Object.entries(facts).filter(([, known]) => !known).map(([k]) => k),
      };
    },
  },
  {
    name: 'get_training_schedule',
    access: 'read',
    description: 'The athlete’s usual week: program sessions (gym, plyometrics) and recurring activities (basketball, conditioning…) per weekday. Planned only — not training.',
    input: NONE,
    output: S.obj({
      note: S.str(),
      days: S.list(S.obj({
        day: S.str(),
        activities: S.list(S.obj({
          kind: S.str(), source: S.oneOf(['program', 'schedule']), name: S.orNull(S.str()), time: S.orNull(S.str()),
          duration_min: S.orNull(S.num()), intensity: S.orNull(S.str()), enabled: S.bool(),
        })),
      }), 7),
    }),
    run(d) {
      return {
        note: 'Planned week. Planned sessions are not training until logged.',
        days: weeklySchedule(d).map((entries, i) => ({
          day: DAYS[i],
          activities: entries.map((e) => ({
            kind: e.kind, source: e.source, name: e.source === 'program' ? programName(d, e) : nul(e.label), time: nul(e.time),
            duration_min: nul(e.durationMin), intensity: nul(e.intensity), enabled: e.enabled,
          })),
        })),
      };
    },
  },
  {
    name: 'get_today_plan',
    access: 'read',
    description: 'Today’s plan: the gym and plyometric sessions APEX prescribed (with status and exercise prescriptions), planned and logged basketball, and the recovery check-in.',
    input: NONE,
    output: S.obj({
      date: S.str(), weekday: S.str(),
      gym: S.orNull(SESSION), plyometrics: S.orNull(SESSION),
      basketball: S.obj({
        planned: S.orNull(S.obj({ label: S.orNull(S.str()), time: S.orNull(S.str()), duration_min: S.orNull(S.num()), intensity: S.orNull(S.str()) })),
        logged: S.list(S.obj({ duration_min: S.num(), rpe: S.num(), session_type: S.orNull(S.str()) })),
      }),
      recovery_check_in: S.orNull(S.obj({ sleep_hours: S.num(), soreness_1_to_5: S.num(), energy_1_to_5: S.num() })),
      note: S.str(),
    }),
    run(d, _a, ctx) {
      const o = todayOverview(d, ctx.today);
      const bp = o.basketball.planned;
      return {
        date: ctx.today,
        weekday: DAYS[weekdayIndex(ctx.today)],
        gym: o.gym ? sessionView(o.gym) : null,
        plyometrics: o.plyo ? sessionView(o.plyo) : null,
        basketball: {
          planned: bp ? { label: nul(bp.label), time: nul(bp.time), duration_min: nul(bp.durationMin), intensity: nul(bp.intensity) } : null,
          logged: o.basketball.sessions.map((b) => ({ duration_min: b.durationMin, rpe: b.rpe, session_type: nul(b.sessionType) })),
        },
        recovery_check_in: o.recovery ? { sleep_hours: o.recovery.sleepHours, soreness_1_to_5: o.recovery.soreness, energy_1_to_5: o.recovery.energy } : null,
        note: 'Planned sessions and planned basketball are not training until logged. Planned sessions re-adapt when new training is logged; started sessions are fixed.',
      };
    },
  },
  {
    name: 'get_current_adaptation',
    access: 'read',
    description: 'The decision record behind today’s sessions: outcome, headline, reasons, volume change, per-region changes, removed or modified exercises, and the inputs it used. Use this to explain why a session changed.',
    input: NONE,
    output: S.obj({ date: S.str(), sessions: S.list(DECISION) }),
    run(d, _a, ctx) {
      const o = todayOverview(d, ctx.today);
      return { date: ctx.today, sessions: [o.gym, o.plyo].filter((i): i is SessionInstance => !!i).map((i) => decisionView(d, i, unitsOf(d))) };
    },
  },
  {
    name: 'get_training_load',
    access: 'read',
    description: 'APEX’s calculated training load: today’s load by source, the last 7 days, and per-region load (lower, upper, trunk, jump) with trend and comparison to the athlete’s usual week.',
    input: NONE,
    output: S.obj({
      note: S.str(),
      today: S.obj({ total: S.num(), basketball: S.num(), gym: S.num(), plyometrics: S.num(), band: S.str() }),
      last_7_days: S.list(S.obj({ date: S.str(), total: S.num(), band: S.str() })),
      regions: S.list(S.obj({ area: S.str(), band: S.str(), trend: S.str(), today: S.num(), last_7_days: S.num(), usual_week: S.num(), week_vs_usual: S.str() })),
    }),
    run(d, _a, ctx) {
      const o = todayOverview(d, ctx.today);
      return {
        note: LOAD_NOTE,
        today: { total: o.load.total, basketball: o.load.basketball, gym: o.load.gym, plyometrics: o.load.plyo, band: o.load.band },
        last_7_days: o.week.map((w) => ({ date: w.date, total: w.total, band: w.band })),
        regions: progressOverview(d, ctx.today).regions.map((r) => ({
          area: r.area, band: r.band, trend: r.trend, today: round(r.today), last_7_days: round(r.acute7), usual_week: round(r.baseline), week_vs_usual: r.accumulated,
        })),
      };
    },
  },
  {
    name: 'get_readiness',
    access: 'read',
    description: 'Today’s readiness: the athlete’s recovery check-in (sleep, soreness, energy), APEX’s readiness score from it, and yesterday’s load band. No check-in → no score.',
    input: NONE,
    output: S.obj({
      checked_in: S.bool(), score: S.orNull(S.num()),
      check_in: S.orNull(S.obj({ sleep_hours: S.num(), soreness_1_to_5: S.num(), energy_1_to_5: S.num() })),
      prior_day_load_band: S.str(), recovery_scale: S.num(), note: S.str(),
    }),
    run(d, _a, ctx) {
      const o = todayOverview(d, ctx.today);
      return {
        checked_in: !!o.recovery,
        score: nul(o.readiness),
        check_in: o.recovery ? { sleep_hours: o.recovery.sleepHours, soreness_1_to_5: o.recovery.soreness, energy_1_to_5: o.recovery.energy } : null,
        prior_day_load_band: buildContext(d, ctx.today).priorDayBand,
        recovery_scale: o.stress.recoveryScale,
        note: 'The check-in is athlete-reported; the score and recovery scale are APEX-calculated (scale above 1 = reduce more, below 1 = reduce less).',
      };
    },
  },
  {
    name: 'get_recent_sessions',
    access: 'read',
    description: 'Logged training (basketball, gym, plyometrics) over the last N days with each day’s load. Logged sessions only — never planned ones.',
    input: S.obj({ days: S.orNull(S.int(1, 28, 'Days to look back, including today. Default 7.')) }),
    output: S.obj({
      from: S.str(), to: S.str(),
      days: S.list(S.obj({ date: S.str(), load: S.num(), sessions: S.list(S.obj({ kind: S.str(), name: S.str() })) })),
      recovery_days: S.list(S.str()),
    }),
    run(d, a, ctx) {
      const n = (a.days as number | null) ?? 7;
      const from = addDays(ctx.today, -(n - 1));
      return {
        from,
        to: ctx.today,
        days: dayLoads(d, ctx.today, n).filter((x) => x.sessions.length).map((x) => ({
          date: x.date, load: round(x.total), sessions: x.sessions.map((s) => ({ kind: s.kind, name: s.label })),
        })),
        recovery_days: d.instances.filter((i) => i.status === 'skipped' && i.date >= from && i.date <= ctx.today).map((i) => i.date),
      };
    },
  },
  {
    name: 'get_workout_history',
    access: 'read',
    description: 'Completed gym/plyometric workouts, newest first: duration, sets, volume, plan vs done, skipped/removed work, substitutions, PRs, load and top sets.',
    input: S.obj({
      limit: S.orNull(S.int(1, 20, 'How many workouts. Default 5.')),
      kind: S.orNull(S.oneOf(['gym', 'plyometrics'])),
    }),
    output: S.obj({
      total_completed: S.num(),
      workouts: S.list(S.obj({
        date: S.str(), session: S.str(), template: S.str(), label: S.str(), duration_min: S.orNull(S.num()),
        exercises_done: S.num(), exercises_total: S.num(), sets: S.num(), volume: S.str(), volume_change_pct: S.orNull(S.num()),
        plan: S.obj({ planned: S.num(), prescribed: S.num(), done: S.num(), unit: S.str() }),
        skipped_sets: S.num(), skipped_exercises: S.list(S.str()), removed: S.list(S.str()),
        substitutions: S.list(S.obj({ from: S.str(), to: S.str() })),
        prs: S.list(S.str()), load: S.num(), load_band: S.str(), top_sets: S.list(S.str()),
      })),
    }),
    run(d, a) {
      const u = unitsOf(d);
      const kind = a.kind as 'gym' | 'plyometrics' | null;
      const all = completed(d.instances).filter((i) => !kind || (kind === 'gym') === (i.kind === 'gym'));
      return {
        total_completed: all.length,
        workouts: all.slice(0, (a.limit as number | null) ?? 5).map((i) => {
          const s = workoutSummary(i, d.instances, d.records, APEX_CONFIG, u);
          return {
            date: i.date, session: i.kind === 'gym' ? 'gym' : 'plyometrics', template: i.templateName, label: adaptationStatus(i),
            duration_min: s.durationMs ? round(s.durationMs / 60_000) : null,
            exercises_done: s.exercises.done, exercises_total: s.exercises.total, sets: s.sets,
            volume: i.kind === 'gym' ? wtu(s.volume, u) : `${s.volume} contacts`, volume_change_pct: nul(s.volumeChange),
            plan: s.plan, skipped_sets: s.skippedSets, skipped_exercises: s.skipped, removed: s.removed, substitutions: s.substitutions,
            prs: s.prs.map((p) => `${p.exerciseName}: ${PR_LABEL[p.kind]} ${localize(p.detail, u)}`),
            load: s.load.value, load_band: s.load.band,
            top_sets: i.kind === 'gym'
              ? i.exercises.flatMap((e) => {
                const w = e.sets.filter(isWorking);
                if (!w.length) return [];
                const top = w.reduce((x, y) => (y.weight > x.weight || (y.weight === x.weight && y.reps > x.reps) ? y : x));
                return [`${e.name}: ${setText(top, u, gymExercise(e.exerciseId).unit)}`];
              })
              : [],
          };
        }),
      };
    },
  },
  {
    name: 'get_exercise_history',
    access: 'read',
    description: 'One lift’s logged sessions (newest first, all sets), best set and best estimated 1RM. If the name is ambiguous, returns candidate exercises to ask about.',
    input: S.obj({ exercise: EXERCISE_QUERY, limit: S.orNull(S.int(1, 20, 'Sessions to return. Default 6.')) }),
    output: S.obj({
      exercise: S.orNull(EXERCISE), matches: S.list(EXERCISE), total_sessions: S.num(),
      sessions: S.list(S.obj({ date: S.str(), template: S.str(), sets: S.list(S.str()), notes: S.orNull(S.str()) })),
      best_set: S.orNull(S.str()), best_e1rm: S.orNull(S.str()),
    }),
    run(d, a) {
      const f = findExercise(d, a.exercise as string);
      if (!f.exercise) return { ...f, total_sessions: 0, sessions: [], best_set: null, best_e1rm: null };
      const u = unitsOf(d);
      const unit = gymExercise(f.exercise.id).unit;
      const h = exerciseHistory(d.instances, f.exercise.id);
      const b = exerciseBests(h);
      return {
        ...f,
        total_sessions: h.length,
        sessions: h.slice(0, (a.limit as number | null) ?? 6).map((s) => ({ date: s.date, template: s.templateName, sets: s.sets.map((x) => setText(x, u, unit)), notes: nul(s.notes) })),
        best_set: b ? `${setText(b.best.set, u, unit)} on ${b.best.date}` : null,
        best_e1rm: b && unit !== 'sec' ? `${wtu(b.e1rm.value, u)} on ${b.e1rm.date}` : null,
      };
    },
  },
  {
    name: 'get_progression',
    access: 'read',
    description: 'APEX’s next recommendation for a lift (increase, add reps, hold, maintain, decrease or establish) with its reason, based on the last session and today’s fatigue if the lift is on today’s plan.',
    input: S.obj({ exercise: EXERCISE_QUERY }),
    output: S.obj({
      exercise: S.orNull(EXERCISE), matches: S.list(EXERCISE),
      recommendation: S.orNull(S.obj({ action: S.str(), weight: S.orNull(S.str()), reps: S.num(), reason: S.str() })),
      based_on: S.orNull(S.obj({ date: S.str(), sets: S.list(S.str()) })),
      on_today_plan: S.bool(), today_prescription: S.orNull(S.str()),
    }),
    run(d, a, ctx) {
      const f = findExercise(d, a.exercise as string);
      if (!f.exercise) return { ...f, recommendation: null, based_on: null, on_today_plan: false, today_prescription: null };
      const u = unitsOf(d);
      const id = f.exercise.id;
      const unit = gymExercise(id).unit;
      const h = exerciseHistory(d.instances, id);
      const live = liveExercise(d.instances, id, ctx.today);
      const rec = nextProgression(h, live, id, u);
      return {
        ...f,
        recommendation: { action: rec.action, weight: rec.weight === undefined ? null : wtu(rec.weight, u), reps: rec.reps, reason: localize(rec.reason, u) },
        based_on: h[0] ? { date: h[0].date, sets: h[0].sets.filter(isWorking).map((s) => setText(s, u, unit)) } : null,
        on_today_plan: !!live,
        today_prescription: live ? `${live.ex.prescribed.sets} × ${live.ex.prescribed.repRange[0]}–${live.ex.prescribed.repRange[1]}` : null,
      };
    },
  },
  {
    name: 'get_prs',
    access: 'read',
    description: 'Personal records APEX detected (weight, reps, e1RM, volume, jump height, box height, distance), newest first. Optionally for one exercise.',
    input: S.obj({
      exercise: S.orNull(EXERCISE_QUERY),
      limit: S.orNull(S.int(1, 50, 'Records to return. Default 10.')),
    }),
    output: S.obj({
      exercise: S.orNull(EXERCISE), matches: S.list(EXERCISE), total: S.num(),
      records: S.list(S.obj({ date: S.str(), exercise: S.str(), kind: S.str(), detail: S.str() })),
    }),
    run(d, a) {
      const f = a.exercise ? findExercise(d, a.exercise as string) : { exercise: null, matches: [] };
      if (a.exercise && !f.exercise) return { ...f, total: 0, records: [] };
      const u = unitsOf(d);
      const recs = d.records.filter((r) => !f.exercise || r.exerciseId === f.exercise.id).sort((x, y) => y.date.localeCompare(x.date));
      return {
        ...f,
        total: recs.length,
        records: recs.slice(0, (a.limit as number | null) ?? 10).map((r) => ({ date: r.date, exercise: r.exerciseName, kind: PR_LABEL[r.kind], detail: localize(r.detail, u) })),
      };
    },
  },
  {
    name: 'get_weekly_volume',
    access: 'read',
    description: 'Working sets per muscle group over the last 7 days against APEX’s weekly targets (under / in range / high), with how many sessions trained each group.',
    input: NONE,
    output: S.obj({
      from: S.str(), to: S.str(), note: S.str(),
      groups: S.list(S.obj({ group: S.str(), sets: S.num(), target_low: S.num(), target_high: S.num(), sessions: S.num(), status: S.str() })),
    }),
    run(d, _a, ctx) {
      return {
        from: addDays(ctx.today, -6),
        to: ctx.today,
        note: 'Logged working sets; secondary muscles count half. A programming guide, not a measure of stimulus.',
        groups: muscleVolume(d.instances, ctx.today).map((g) => ({ group: g.group, sets: g.sets, target_low: g.target[0], target_high: g.target[1], sessions: g.frequency, status: g.status })),
      };
    },
  },
  {
    name: 'propose_log_basketball',
    access: 'propose',
    description: 'Draft logging a basketball session for today. Nothing is logged: the athlete must confirm it in the app. Only use when the athlete asks to log basketball and gave the duration and the effort (RPE 1–10).',
    input: S.obj({
      duration_min: S.int(1, 600, 'Minutes played'),
      rpe: S.int(1, 10, 'Session effort 1–10, as the athlete said it'),
      session_type: S.orNull(S.oneOf(BASKETBALL_TYPES)),
    }),
    output: S.obj({ status: S.oneOf(['awaiting_confirmation']), summary: S.str() }),
    run(_d, a, ctx) {
      const args = { date: ctx.today, duration_min: a.duration_min, rpe: a.rpe, session_type: a.session_type ?? null };
      if (check(ACTIONS.log_basketball, args)) throw new Error('proposal outside the action contract');
      const summary = `Log basketball: ${args.duration_min} min at RPE ${args.rpe}${args.session_type ? ` (${args.session_type})` : ''} on ${ctx.today}.`;
      ctx.proposals.push({ action: 'log_basketball', arguments: args, summary, requires_confirmation: true });
      return { status: 'awaiting_confirmation', summary };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Function tools for the Responses API (strict schemas). */
export const toolDefinitions = () =>
  TOOLS.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.input as unknown as Record<string, unknown>, strict: true }));

export type ToolError = 'unknown_tool' | 'invalid_arguments' | 'athlete_data_unavailable' | 'tool_failed';
export type ToolResult = { ok: true; output: unknown } | { ok: false; error: ToolError; detail?: string };

/** Validate → run → validate the output. Failures come back as data for the model, never as exceptions. */
export function runTool(name: string, rawArgs: string, ctx: ToolContext): ToolResult {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: 'unknown_tool' };
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { ok: false, error: 'invalid_arguments', detail: 'arguments are not valid JSON' };
  }
  const bad = check(tool.input, args);
  if (bad) return { ok: false, error: 'invalid_arguments', detail: bad };
  if (!ctx.data) return { ok: false, error: 'athlete_data_unavailable' };
  try {
    const output: unknown = JSON.parse(JSON.stringify(tool.run(ctx.data as ApexData, args as Args, ctx)));
    const drift = check(tool.output, output);
    return drift ? { ok: false, error: 'tool_failed', detail: `output contract: ${drift}` } : { ok: true, output };
  } catch {
    return { ok: false, error: 'tool_failed' };
  }
}
