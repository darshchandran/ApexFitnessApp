// AI actions: the model can only PROPOSE; the athlete CONFIRMS; the server EXECUTES — once — through
// the app's own APEX service. Proposal preview and execution run the same code on a private copy of
// the athlete's data, so what the athlete confirms is what the engine does. Nothing here computes
// training numbers, and every run is checked: only new basketball and today's unstarted sessions
// may change — never templates, the profile, completed sessions or past basketball.
import { createHash, randomUUID } from 'node:crypto';
import { memoryStore, writeAll } from '../../src/data/store';
import { adaptationStatus, planVsActual } from '../../src/domain/logbook';
import type { ApexData, ISODate, Level, SessionInstance } from '../../src/domain/types';
import { daysBetween, parseISODate, toISODate } from '../../src/domain/util';
import { createApex, todayOverview, type ActionChanges, type Apex } from '../../src/services/apex';
import { BASKETBALL_TYPES, check, ISO_DATE, S, type Schema } from './schemas';

export type ActionType = 'log_basketball' | 'adapt_today_workout' | 'log_gym_set' | 'start_workout' | 'finish_workout' | 'update_athlete_profile';
/** confirmed = accepted and executing (exactly one execution can be in flight). */
export type ActionStatus = 'pending' | 'confirmed' | 'executed' | 'cancelled' | 'expired' | 'failed';
type Args = Record<string, unknown>;

/** A safe, athlete-facing reason an action can't go ahead. */
export class ActionRejected extends Error {
  name = 'ActionRejected';
}

interface Plan {
  summary: string;
  /** The service call — the only place an action touches APEX. */
  run(app: Apex): unknown;
  /** Fingerprint of the state the proposal was based on; execution refuses if it changed. */
  basis?: string;
}

interface ProposalTool {
  name: string;
  description: string;
  input: Schema;
  toArgs(input: Args, today: ISODate): Args;
}

interface ActionDef {
  description: string;
  risk: 'consequential' | 'destructive';
  /** Disabled contracts are defined but can't be proposed or executed. */
  enabled: boolean;
  args: Schema;
  proposal?: ProposalTool;
  /** Check the arguments against the athlete's current data → the service call, or why not. */
  plan?(d: ApexData, args: Args, today: ISODate): Plan;
}

const LEVEL: Record<string, Level> = { none: 0, low: 1, moderate: 2, high: 3 };
const FATIGUE = ['none', 'low', 'moderate', 'high'] as const;
const SESSION = S.oneOf(['gym', 'plyometrics']);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const templateName = (d: ApexData, id: string) => [...d.templates, ...d.plyoTemplates].find((t) => t.id === id)?.name;

/** What an adapt proposal was based on: today's session as APEX prescribed it. */
const fingerprint = (i: SessionInstance) =>
  hash([i.id, i.templateId, i.status, i.plan ?? 'adapted', i.decision.outcome, i.exercises.map((e) => [e.exerciseId, e.status, e.prescribed.sets])]);

export const ACTIONS: Record<ActionType, ActionDef> = {
  log_basketball: {
    description: 'Log a basketball session the athlete played.',
    risk: 'consequential',
    enabled: true,
    args: S.obj({
      date: S.text(ISO_DATE),
      duration_min: S.int(1, 600),
      rpe: S.int(1, 10),
      session_type: S.orNull(S.oneOf(BASKETBALL_TYPES)),
      lower_body_fatigue: S.orNull(S.oneOf(FATIGUE)),
    }),
    proposal: {
      name: 'propose_log_basketball',
      description: 'Propose logging a basketball session. Nothing is logged until the athlete confirms in the app. Only use values the athlete stated: ask for duration and effort (RPE 1–10) if missing; leave optional fields null unless they said so.',
      input: S.obj({
        duration_min: S.int(1, 600, 'Minutes played'),
        rpe: S.int(1, 10, 'Session effort 1–10, as the athlete said it'),
        session_type: S.orNull(S.oneOf(BASKETBALL_TYPES)),
        lower_body_fatigue: S.orNull(S.oneOf(FATIGUE, 'Only if the athlete described how their legs feel')),
        date: S.orNull(S.text(ISO_DATE, 'YYYY-MM-DD; null = today')),
      }),
      toArgs: (a, today) => ({ date: a.date ?? today, duration_min: a.duration_min, rpe: a.rpe, session_type: a.session_type ?? null, lower_body_fatigue: a.lower_body_fatigue ?? null }),
    },
    plan(_d, a, today) {
      const date = a.date as ISODate;
      if (toISODate(parseISODate(date)) !== date) throw new ActionRejected('That date doesn’t exist.');
      if (date > today) throw new ActionRejected('Basketball can’t be logged for a future date.');
      if (daysBetween(date, today) > 6) throw new ActionRejected('Basketball can only be logged for the last 7 days.');
      const type = a.session_type as string | null;
      const legs = a.lower_body_fatigue as string | null;
      const input = { date, durationMin: a.duration_min as number, rpe: a.rpe as number, ...(type && { sessionType: type as never }), ...(legs && { lowerFatigue: LEVEL[legs] }) };
      return {
        summary: `Log basketball — ${input.durationMin} min at RPE ${input.rpe}${type ? `, ${type}` : ''}${legs ? `, ${legs} lower-body fatigue` : ''}, ${date === today ? 'today' : date}.`,
        run: (app) => app.logBasketball(input),
      };
    },
  },

  adapt_today_workout: {
    description: 'Apply one of APEX’s own options for today’s unstarted session: its adaptation, its suggested alternative, or a recovery day.',
    risk: 'consequential',
    enabled: true,
    args: S.obj({ session: SESSION, choice: S.oneOf(['adapt', 'alternative', 'recovery_day']) }),
    proposal: {
      name: 'propose_adapt_today_workout',
      description: 'Propose one of APEX’s options for today’s unstarted session: "adapt" (APEX’s reduced prescription, when the athlete had kept the plan), "alternative" (APEX’s suggested other session) or "recovery_day". APEX’s engine decides the actual change — you cannot set sets or exercises. If nothing logged calls for an adaptation, propose logging the practice instead.',
      input: S.obj({ session: SESSION, choice: S.oneOf(['adapt', 'alternative', 'recovery_day']) }),
      toArgs: (a) => ({ session: a.session, choice: a.choice }),
    },
    plan(d, a, today) {
      const o = todayOverview(d, today);
      const i = a.session === 'gym' ? o.gym : o.plyo;
      if (!i) throw new ActionRejected(`There is no ${a.session === 'gym' ? 'gym' : 'plyometric'} session on today’s plan.`);
      if (i.status !== 'planned') throw new ActionRejected(`Today’s ${i.templateName} has ${i.status === 'skipped' ? 'already been set aside' : 'already started'} — it can’t be changed from here.`);
      if (i.decision.outcome === 'normal') {
        throw new ActionRejected(`APEX’s engine has no adaptation for today’s ${i.templateName}: nothing logged calls for one. Log the practice and APEX adjusts the session itself.`);
      }
      const basis = fingerprint(i);
      if (a.choice === 'adapt') {
        if ((i.plan ?? 'adapted') === 'adapted') throw new ActionRejected(`Today’s ${i.templateName} is already adapted: ${i.decision.headline}.`);
        return { basis, summary: `Use APEX’s adaptation for today’s ${i.templateName}: ${i.decision.headline}.`, run: (app) => app.setPlanMode(i.id, 'adapted') };
      }
      if (a.choice === 'alternative') {
        const alt = i.decision.alternativeTemplateId && templateName(d, i.decision.alternativeTemplateId);
        if (!alt) throw new ActionRejected(`APEX doesn’t suggest an alternative to today’s ${i.templateName}.`);
        return { basis, summary: `Train ${alt} today instead of ${i.templateName} — APEX’s suggested alternative.`, run: (app) => app.useAlternative(i.id) };
      }
      return { basis, summary: `Take today as a recovery day: set aside ${i.templateName} (nothing is deleted).`, run: (app) => app.takeRecoveryDay(i.id) };
    },
  },

  // ---- contracts only: defined so they can be enabled safely later, not proposable or executable yet ----
  log_gym_set: {
    description: 'Log one set in today’s active gym session.',
    risk: 'consequential',
    enabled: false,
    args: S.obj({ exercise_id: S.text('^[a-z0-9-]{1,60}$'), weight_kg: S.num(), reps: S.int(1, 100), rir: S.orNull(S.int(0, 10)) }),
  },
  start_workout: {
    description: 'Start today’s planned session.',
    risk: 'consequential',
    enabled: false,
    args: S.obj({ session: SESSION }),
  },
  finish_workout: {
    description: 'Finish today’s active session — it becomes read-only history.',
    risk: 'consequential',
    enabled: false,
    args: S.obj({ session: SESSION, session_rpe: S.orNull(S.int(1, 10)) }),
  },
  update_athlete_profile: {
    description: 'Change one profile answer the athlete gave.',
    risk: 'consequential',
    enabled: false,
    args: S.obj({ field: S.oneOf(['goal', 'sport', 'units', 'experience', 'focus', 'gym_time']), value: S.text('^[a-z0-9:_-]{1,20}$') }),
  },
};

export const isActionType = (t: unknown): t is ActionType => typeof t === 'string' && Object.hasOwn(ACTIONS, t);

// ---------- running an action on a private copy ----------

/**
 * APEX's service reads "today" from local date getters. On the server those must be the athlete's
 * calendar date; timestamps (toISOString, getTime) stay the true instant.
 * ponytail: patches the date getters of each clock reading; pass the athlete's UTC offset if time-of-day logic ever runs here.
 */
export function athleteClock(today: ISODate, now: () => Date = () => new Date()) {
  const d = parseISODate(today);
  const [y, m, day, wd] = [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay()];
  return () => Object.assign(now(), { getFullYear: () => y, getMonth: () => m, getDate: () => day, getDay: () => wd });
}

export interface Affected {
  type: 'basketball_session' | 'session_instance';
  id: string;
  change: 'created' | 'updated';
}

export interface Simulation {
  summary: string;
  /** What changes, in plain words — shown before confirming and returned after executing. */
  preview: string[];
  basis?: string;
  changes: ActionChanges;
  affected: Affected[];
  result: Record<string, unknown>;
}

const PROTECTED = ['user', 'profile', 'settings', 'plan', 'templates', 'plyoTemplates', 'recovery', 'bodyMetrics', 'performance', 'records'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sessionLine(i: SessionInstance) {
  const v = planVsActual(i);
  return i.status === 'skipped' ? `${i.templateName}: set aside — recovery day` : `${i.templateName}: ${v.prescribed} ${v.unit} · ${adaptationStatus(i)}`;
}

/** What may change: new basketball, and today's unstarted sessions. Anything else aborts the action. */
function changesOf(before: ApexData, after: ApexData, today: ISODate) {
  for (const k of PROTECTED) if (!same(before[k], after[k])) throw new ActionRejected('This action would change protected data, so it was stopped.');
  const prevBb = new Map(before.basketball.map((b) => [b.id, b]));
  if (before.basketball.some((b) => !same(b, after.basketball.find((x) => x.id === b.id)))) throw new ActionRejected('Logged basketball can’t be changed.');
  const prev = new Map(before.instances.map((i) => [i.id, i]));
  const nextIds = new Set(after.instances.map((i) => i.id));
  if (before.instances.some((i) => !nextIds.has(i.id))) throw new ActionRejected('Sessions can’t be removed.');
  const instances = after.instances.filter((i) => !same(prev.get(i.id), i));
  if (instances.some((i) => i.date !== today || (prev.get(i.id) && prev.get(i.id)!.status !== 'planned'))) throw new ActionRejected('Only today’s unstarted session can change.');
  const basketball = after.basketball.filter((b) => !prevBb.has(b.id));
  const affected: Affected[] = [
    ...basketball.map((b) => ({ type: 'basketball_session' as const, id: b.id, change: 'created' as const })),
    ...instances.map((i) => ({ type: 'session_instance' as const, id: i.id, change: prev.has(i.id) ? ('updated' as const) : ('created' as const) })),
  ];
  return { changes: { basketball, instances }, affected };
}

/**
 * Run an action through the app's own service on a private in-memory copy of the athlete's data —
 * the same start-up the device runs, then the one service call. Throws ActionRejected with a safe reason.
 */
export async function simulate(data: Readonly<ApexData>, type: ActionType, args: Args, today: ISODate, expectBasis?: string): Promise<Simulation> {
  const def = ACTIONS[type];
  if (!def.enabled || !def.plan) throw new ActionRejected('That action isn’t available.');
  if (check(def.args, args)) throw new ActionRejected('Those values aren’t valid for this action.');
  const plan = def.plan(data as ApexData, args, today);
  if (expectBasis !== undefined && plan.basis !== expectBasis) throw new ActionRejected('Today’s plan changed since this was proposed — ask again.');

  const store = memoryStore();
  await writeAll(store, data as ApexData);
  const app = createApex(store, athleteClock(today));
  await app.init();
  const before = app.getState().data;
  const out = plan.run(app);
  await app.flush();
  const after = app.getState().data;
  const { changes, affected } = changesOf(before, after, today); // the safety net runs first, whatever the action
  if (type === 'log_basketball' && !out) throw new ActionRejected('APEX didn’t accept those values.');
  if (!affected.length) throw new ActionRejected('APEX made no change.');
  const o = todayOverview(after, today);
  const prevToday = todayOverview(before, today);
  const sessions = [o.gym, o.plyo].filter((i): i is SessionInstance => !!i);
  const changedLines = changes.instances.map(sessionLine);
  const preview = [
    ...changes.basketball.map((b) => `Basketball ${b.durationMin} min at RPE ${b.rpe} on ${b.date}`),
    ...changedLines,
    ...(o.load.total !== prevToday.load.total ? [`Today’s load: ${prevToday.load.total} → ${o.load.total} (${o.load.band})`] : []),
  ];
  return {
    summary: plan.summary,
    preview,
    basis: plan.basis,
    changes,
    affected,
    result: {
      basketball_sessions: changes.basketball.map((b) => ({ id: b.id, date: b.date, duration_min: b.durationMin, rpe: b.rpe, session_type: b.sessionType ?? null })),
      today_sessions: sessions.map((i) => ({ id: i.id, template: i.templateName, status: i.status, label: adaptationStatus(i), headline: i.decision.headline, prescribed: sessionLine(i) })),
      load_today: { total: o.load.total, basketball: o.load.basketball, gym: o.load.gym, plyometrics: o.load.plyo, band: o.load.band },
    },
  };
}

// ---------- pending actions ----------

export interface ActionDraft {
  type: ActionType;
  arguments: Args;
  summary: string;
  preview: string[];
  basis?: string;
}

export type ActionResult =
  | { success: true; action_id: string; action_type: ActionType; result: Record<string, unknown> & { changes: ActionChanges }; affected_entities: Affected[]; timestamp: string }
  | { success: false; action_id: string; action_type: ActionType; error: { code: string; message: string }; timestamp: string };

export interface StoredAction extends ActionDraft {
  id: string;
  /** The authenticated athlete who was shown the proposal — the only one who can confirm or cancel it. */
  userId: string;
  conversationId: string;
  argumentsHash: string;
  requires_confirmation: true;
  status: ActionStatus;
  createdAt: number;
  expiresAt: number;
  execution?: Promise<ActionResult>;
  result?: ActionResult;
}

/** What the app sees: no athlete id, no internal fingerprints. */
export const clientAction = (a: StoredAction) => ({
  id: a.id, type: a.type, summary: a.summary, arguments: a.arguments, preview: a.preview, requires_confirmation: a.requires_confirmation,
  status: a.status, created_at: new Date(a.createdAt).toISOString(), expires_at: new Date(a.expiresAt).toISOString(),
});
export type ClientAction = ReturnType<typeof clientAction>;

export const argumentsHash = (type: ActionType, args: Args) => hash([type, args]);

/**
 * Pending and recent actions. Ids are random UUIDs; lookups are scoped to the athlete, so another
 * athlete's id is indistinguishable from a missing one.
 * ponytail: in-process memory — pending actions die with a restart (they expire in minutes anyway); a table keyed by action id when there is more than one server.
 */
export class ActionStore {
  private map = new Map<string, StoredAction>();
  constructor(readonly ttlMs = 5 * 60_000, private clock: () => number = Date.now, private keepMs = 24 * 3_600_000, private max = 10_000) {}

  create(draft: ActionDraft, userId: string, conversationId: string): StoredAction {
    const now = this.clock();
    this.prune(now);
    const a: StoredAction = {
      ...draft, id: randomUUID(), userId, conversationId, argumentsHash: argumentsHash(draft.type, draft.arguments),
      requires_confirmation: true, status: 'pending', createdAt: now, expiresAt: now + this.ttlMs,
    };
    this.map.set(a.id, a);
    return a;
  }

  find(id: string, userId: string): StoredAction | undefined {
    const a = this.map.get(id);
    if (!a || a.userId !== userId) return undefined;
    this.expire(a);
    return a;
  }

  /** A pending action past its expiry can never run. */
  expire(a: StoredAction) {
    if (a.status === 'pending' && this.clock() >= a.expiresAt) a.status = 'expired';
  }

  private prune(now: number) {
    for (const [id, a] of this.map) if (now - a.createdAt > this.keepMs) this.map.delete(id);
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** The deterministic line shown after a confirm — the model is not called again. */
export function resultMessage(a: StoredAction, r: ActionResult) {
  if (!r.success) return `${a.type === 'log_basketball' ? 'Basketball was not logged' : 'Nothing was changed'}: ${r.error.message}`;
  const sessions = (r.result.today_sessions as { prescribed: string }[]).map((s) => s.prescribed);
  return [a.type === 'log_basketball' ? 'Basketball logged.' : 'Done.', a.summary, ...(sessions.length ? [`Today: ${sessions.join('; ')}.`] : [])].join(' ');
}
