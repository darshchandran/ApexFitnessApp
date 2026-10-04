// Context-aware adaptation. Pure and deterministic: same history + template + recovery +
// config → same decision. No randomness, no network, no learned model.
//
// Template → (schedule) → recent context → load → recovery → muscle volume → decision.
// The decision only describes a prescription; generate.ts turns it into an instance and the
// template is never written.
import { AREA_LABEL, MUSCLE_AREA, MUSCLE_GROUP, priorityOf } from './areas';
import { gymExercise, plyoExercise } from './catalog';
import { APEX_CONFIG, type ApexConfig } from './config';
import { atLeast, bandFor, contactsFor, isShock, maxBand, type SessionNote } from './load';
import { computeStrain, reductionFor, type AreaStrain, type Strain, type TrainingContext } from './strain';
import type {
  AdaptationDecision, AdaptationLevel, AdaptationOutcome, AreaLoad, BodyArea, DecisionInputs, LoadBand, PlyometricTemplate,
  WorkoutTemplate,
} from './types';
import { clamp, parseISODate, sum } from './util';
import { volumeStatus } from './volume';

export { buildContext, contextFromSessions, type TrainingContext } from './strain';

const BAND_WORD: Record<LoadBand, string> = { low: 'Low', moderate: 'Moderate', high: 'High', extreme: 'Very high' };
const REGION_WORD = { lower: 'lower-body', upper: 'upper-body', core: 'core', jump: 'jump' } as const;
const pct = (x: number) => Math.round(Math.abs(x) * 100);
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const weekday = (d: string) => parseISODate(d).toLocaleDateString('en-GB', { weekday: 'short' });
const weekdayLong = (d: string) => parseISODate(d).toLocaleDateString('en-GB', { weekday: 'long' });

// ---------- shared explanation helpers ----------

/** Sessions from today and the previous 4 days that put meaningful load on `area`, most relevant first. */
function contributors(ctx: TrainingContext, area: BodyArea, minShare = 0.15) {
  const notes: (SessionNote & { load: number; daysAgo: number })[] = [];
  ctx.days.slice(0, 5).forEach((d, daysAgo) => {
    for (const s of d.sessions) {
      const load = (s.areas as AreaLoad)[area] ?? 0;
      if (load > 0) notes.push({ ...s, load, daysAgo });
    }
  });
  const total = sum(notes.map((n) => n.load));
  const weight = (n: (typeof notes)[number]) => n.load * (1 - n.daysAgo * 0.15);
  return notes.filter((n) => n.load >= total * minShare).sort((x, y) => weight(y) - weight(x));
}

const shortLabel = (n: SessionNote) => (n.kind === 'basketball' ? 'basketball' : n.label);

/** "today’s basketball", "Wednesday’s basketball", "recent basketball + Legs", "this week’s training". */
function sourcePhrase(ctx: TrainingContext, s: AreaStrain, cfg: ApexConfig): string {
  const todayPart = s.today / cfg.dayRef[s.area];
  if (s.accumulation > todayPart && s.accumulation > s.residual) return 'this week’s training';
  const notes = contributors(ctx, s.area).slice(0, 2);
  if (!notes.length) return 'recent training';
  const names = [...new Set(notes.map(shortLabel))];
  if (notes.every((n) => n.daysAgo === 0)) return `today’s ${names.join(' + ')}`;
  if (notes.length === 1) return `${weekdayLong(notes[0].date)}’s ${names[0]}`;
  return `recent ${names.join(' + ')}`;
}

function recentList(ctx: TrainingContext) {
  return ctx.days.slice(0, 5).flatMap((d, k) => d.sessions.map((s) => `${k === 0 ? 'Today' : weekday(d.date)} · ${s.label}`));
}

/** "Wed: basketball 90 min @ RPE 9 · Mon: Legs" — the sessions behind a decision. */
function evidenceLine(ctx: TrainingContext, area: BodyArea) {
  const notes = contributors(ctx, area).slice(0, 3);
  if (!notes.length) return undefined;
  return notes.map((n) => `${n.daysAgo === 0 ? 'Today' : weekday(n.date)}: ${n.kind === 'basketball' ? n.label.replace('Basketball', 'basketball') : n.label}`).join(' · ');
}

function snapshot(strain: Strain): DecisionInputs['strain'] {
  const keep: BodyArea[] = ['lower', 'upper', 'trunk', 'jump', 'quads', 'hamstrings', 'glutes', 'calves', 'chest', 'back', 'shoulders', 'biceps', 'triceps'];
  return Object.fromEntries(keep.map((k) => {
    const s = strain.areas[k];
    return [k, { score: s.score, band: s.band, today: s.today, acute7: s.acute7, baseline: s.baseline, ratio: s.ratio }];
  }));
}

function levelFor(factor: number, outcome: AdaptationOutcome, cfg: ApexConfig): AdaptationLevel {
  if (outcome === 'alternative' || outcome === 'deferred') return 'major';
  const l = cfg.adaptation.levels;
  return factor >= 0.999 ? 'none' : factor >= l.light ? 'light' : factor >= l.moderate ? 'moderate' : factor >= l.substantial ? 'substantial' : 'major';
}

function recoveryReason(strain: Strain, anyReduction: boolean, lowReady: boolean): string | undefined {
  if (strain.readiness === undefined) return undefined;
  if (lowReady && !anyReduction) return `Recovery check-in ${strain.readiness}/100 — everything trimmed slightly.`;
  if (!anyReduction) return undefined;
  if (strain.recoveryScale <= 0.85) return 'Good recovery check-in — reductions kept smaller.';
  if (strain.recoveryScale >= 1.15) return 'Low recovery check-in — reductions go a little further.';
  return undefined;
}

function accumulationReason(s: AreaStrain, word: string, ctx: TrainingContext, cfg: ApexConfig) {
  if (s.ratio < cfg.accumulation.ratioStart) return undefined;
  return `This week’s ${word} load is ${pct(s.ratio - 1)}% above ${ctx.historyDays >= cfg.minHistoryDays ? 'your usual week' : 'a typical week'}.`;
}

// ---------- gym ----------

export interface GymPlan {
  decision: AdaptationDecision;
  sets: Record<string, number>; // template exercise id → prescribed working sets (0 = removed)
}

/**
 * Each exercise's cut = strain on what it trains (the larger of its region and its primary
 * muscle) × how costly it is × how much it matters (priority) × whether it repeats a heavy
 * compound already in the session × this week's volume for that muscle × recovery.
 * The session total is rounded once and distributed by largest remainder.
 */
export function adaptGym(
  template: WorkoutTemplate,
  ctx: TrainingContext,
  opts: { alternatives?: WorkoutTemplate[] } = {},
  cfg: ApexConfig = APEX_CONFIG,
): GymPlan {
  const strain = computeStrain(ctx, cfg);
  const a = cfg.adaptation;
  const readiness = strain.readiness;
  const lowReady = readiness !== undefined && readiness < a.recovery.lowReadiness;
  const useVolume = ctx.historyDays >= 7; // weekly volume means little in the first week
  const regionOf = { lower: strain.areas.lower, upper: strain.areas.upper, core: strain.areas.trunk };

  const heavyAreas = new Set<BodyArea>();
  const removed: string[] = [];
  const removedOptional: string[] = [];
  const repeated = new Set<BodyArea>();
  const raw = template.exercises.map((te) => {
    const ex = gymExercise(te.exerciseId);
    const muscleArea = MUSCLE_AREA[ex.primary];
    const muscle = strain.areas[muscleArea];
    const region = regionOf[ex.region];
    const score = Math.max(region.score, muscle.score);
    const band = maxBand(region.band, muscle.band);
    if (muscle.repeatSets >= cfg.repeatMuscle.sets && muscle.score > region.score) repeated.add(muscleArea);
    const priority = priorityOf(te, ex);
    const redundant = ex.fatigueCost === 3 && heavyAreas.has(muscleArea);
    if (ex.fatigueCost === 3) heavyAreas.add(muscleArea);
    const group = MUSCLE_GROUP[ex.primary];
    const status = useVolume ? volumeStatus(ctx.weeklySets[group], cfg.weeklySetTargets[group]) : 'in range';
    const volumeWeight = status === 'under' ? a.volumeStatusWeight.under : status === 'high' ? a.volumeStatusWeight.high : a.volumeStatusWeight.inRange;
    let r = reductionFor(score, cfg) * a.costWeight[ex.fatigueCost] * a.priorityWeight[priority] * (redundant ? a.redundancyWeight : 1) * volumeWeight * strain.recoveryScale;
    if (lowReady) r = Math.max(r, a.recovery.lowReadinessTrim);
    r = Math.min(a.exerciseCap, r);
    const dropOptional = priority === 'optional' && atLeast(band, a.removeOptionalAt);
    const dropUnilateral = !dropOptional && ex.region === 'lower' && !!ex.unilateral && ex.fatigueCost === 3 && atLeast(band, a.removeUnilateralHeavyLowerAt);
    if (dropOptional) removedOptional.push(te.name);
    if (dropUnilateral) removed.push(te.name);
    const drop = dropOptional || dropUnilateral;
    return { te, ex, x: drop ? 0 : te.sets * (1 - r), drop, base: te.sets };
  });

  const target = Math.round(sum(raw.map((r) => r.x)));
  const sets: Record<string, number> = {};
  for (const r of raw) sets[r.te.id] = r.drop ? 0 : Math.max(1, Math.min(r.base, Math.floor(r.x)));
  let remaining = target - sum(Object.values(sets));
  const frac = (r: (typeof raw)[number]) => r.x - Math.floor(r.x);
  for (const r of raw.filter((x) => !x.drop).sort((p, q) => frac(q) - frac(p))) {
    if (remaining <= 0) break;
    if (sets[r.te.id] < r.base && frac(r) > 0) {
      sets[r.te.id] += 1;
      remaining -= 1;
    }
  }

  const programmed = sum(template.exercises.map((e) => e.sets));
  const prescribed = sum(Object.values(sets));
  const volumeFactor = programmed ? prescribed / programmed : 1;
  const regionSets = (reg: 'lower' | 'upper' | 'core', which: 'programmed' | 'prescribed') =>
    sum(raw.filter((r) => r.ex.region === reg).map((r) => (which === 'programmed' ? r.base : sets[r.te.id])));
  const lowerDominant = programmed > 0 && regionSets('lower', 'programmed') / programmed >= a.lowerDominantShare;

  let outcome: AdaptationOutcome = volumeFactor >= a.outcome.normal ? 'normal' : volumeFactor >= a.outcome.reduced ? 'reduced' : 'heavily_reduced';
  let alternativeTemplateId: string | undefined;
  if (lowerDominant && strain.bands.lower === 'extreme') {
    const alt = opts.alternatives?.find((t) => {
      const total = sum(t.exercises.map((e) => e.sets));
      const lower = sum(t.exercises.filter((e) => gymExercise(e.exerciseId).region === 'lower').map((e) => e.sets));
      return t.id !== template.id && total > 0 && lower / total < a.upperFriendlyShare;
    });
    if (alt) {
      outcome = 'alternative';
      alternativeTemplateId = alt.id;
    }
  }
  const trained = (['lower', 'upper', 'core'] as const).filter((reg) => regionSets(reg, 'programmed') > 0);
  const worst = trained.reduce<LoadBand>((acc, reg) => maxBand(acc, regionOf[reg].band), 'low');
  // a recovery check-in alone never cancels a session — only together with real load
  if (readiness !== undefined && readiness < a.recovery.deferBelow && atLeast(worst, 'high')) outcome = 'deferred';

  // ---- record ----
  const areas = trained.map((reg) => {
    const before = regionSets(reg, 'programmed');
    const after = regionSets(reg, 'prescribed');
    const change = before ? (after - before) / before : 0;
    return { area: reg, band: regionOf[reg].band, change, preserved: -change <= a.preservedWithin };
  });
  const modified = raw
    .filter((r) => !r.drop && sets[r.te.id] !== r.base)
    .map((r) => ({ name: r.te.name, from: `${r.base} sets`, to: `${sets[r.te.id]} ${sets[r.te.id] === 1 ? 'set' : 'sets'}` }));

  // ---- explain: what changed and why, in plain words ----
  const reasons: string[] = [];
  const cut = areas.filter((x) => !x.preserved);
  const anyReduction = prescribed < programmed;
  const driver = cut.length ? cut.reduce((p, q) => (q.change < p.change ? q : p)) : undefined;
  const driverStrain = driver ? regionOf[driver.area] : undefined;
  if (driverStrain) {
    const ev = evidenceLine(ctx, driverStrain.area);
    if (ev) reasons.push(`${ev}.`);
  }
  for (const x of cut) reasons.push(`${capital(REGION_WORD[x.area])} volume ↓ ${pct(x.change)}%.`);
  const kept = areas.filter((x) => x.preserved);
  if (cut.length && kept.length) reasons.push(`${kept.map((x) => capital(REGION_WORD[x.area])).join(' and ')} work preserved.`);
  for (const area of repeated) reasons.push(`${AREA_LABEL[area]} trained in the last two days — that volume is trimmed first.`);
  if (removed.length) reasons.push(`Removed ${removed.join(', ')} — single-leg work is the most taxing on tired legs.`);
  if (removedOptional.length) reasons.push(`Removed optional ${removedOptional.join(', ')} first.`);
  if (driver && driverStrain) {
    const acc = accumulationReason(driverStrain, REGION_WORD[driver.area], ctx, cfg);
    if (acc) reasons.push(acc);
  }
  const rec = recoveryReason(strain, anyReduction, lowReady);
  if (rec) reasons.push(rec);
  if (outcome === 'alternative') {
    const alt = opts.alternatives?.find((t) => t.id === alternativeTemplateId);
    reasons.push(`Lower body needs recovery. ${alt?.name} keeps today productive — or keep the plan, or take a recovery day.`);
  }
  if (outcome === 'deferred') reasons.push('Recent load is high and your recovery check-in is low — a recovery day is recommended. You can still train the reduced session.');
  const bb = ctx.todayBasketball[ctx.todayBasketball.length - 1];
  if (!reasons.length) {
    reasons.push(bb
      ? `Today’s basketball (${bb.durationMin} min @ RPE ${bb.rpe}) doesn’t reach the muscles this session trains.`
      : 'No recent load that conflicts with this session.');
  }

  const headline =
    outcome === 'deferred' ? 'Recovery day recommended'
      : outcome === 'normal' ? (bb ? 'Programmed volume — today’s load is elsewhere' : 'Train as programmed')
        : driver && driverStrain ? `${BAND_WORD[driverStrain.band]} ${REGION_WORD[driver.area]} load from ${sourcePhrase(ctx, driverStrain, cfg)}`
          : lowReady ? 'Low recovery check-in' : 'Adjusted for recent load';

  return {
    sets,
    decision: {
      // schedule notes explain (e.g. a planned practice not logged yet); they never change the numbers
      outcome, volumeFactor, bands: strain.bands, readiness, headline, reasons: [...reasons, ...ctx.planned], alternativeTemplateId,
      date: ctx.date, templateId: template.id, templateName: template.name, level: levelFor(volumeFactor, outcome, cfg),
      plannedVolume: programmed, prescribedVolume: prescribed, unit: 'sets', areas,
      removed: [...removed, ...removedOptional], modified,
      inputs: { strain: snapshot(strain), readiness, recoveryScale: strain.recoveryScale, recent: recentList(ctx), ...(ctx.planned.length && { context: ctx.planned }) },
    },
  };
}

// ---------- plyometrics ----------

export interface PlyoPlan {
  decision: AdaptationDecision;
  prescription: Record<string, { sets: number; reps: number; removed?: boolean }>;
}

/** Contacts to remove at a given strain, interpolated within each band's range. */
export function plyoReductionFor(score: number, cfg: ApexConfig = APEX_CONFIG) {
  const b = cfg.bands;
  const r = cfg.plyoAdaptation.bandReduction;
  const lerp = ([lo, hi]: [number, number], from: number, to: number) => lo + (hi - lo) * clamp((score - from) / (to - from), 0, 1);
  if (score < b.moderate) return 0;
  if (score < b.high) return lerp(r.moderate, b.moderate, b.high);
  if (score < b.extreme) return lerp(r.high, b.high, b.extreme);
  return r.extreme;
}

const templateContactsOf = (t: PlyometricTemplate) => sum(t.exercises.map((e) => contactsFor(e.sets, e.reps, e.perSide)));

/**
 * Hit a contact target by removing the most fatiguing work first: depth/drop jumps go
 * entirely at high strain, then sets come off the highest-intensity exercises in turn;
 * high-rep elastic work (pogos) loses reps but is never removed.
 */
export function adaptPlyo(
  template: PlyometricTemplate,
  ctx: TrainingContext,
  opts: { primerId?: string } = {},
  cfg: ApexConfig = APEX_CONFIG,
): PlyoPlan {
  const strain = computeStrain(ctx, cfg);
  const p = cfg.plyoAdaptation;
  const a = cfg.adaptation;
  const readiness = strain.readiness;
  const lowReady = readiness !== undefined && readiness < a.recovery.lowReadiness;
  const jump = strain.areas.jump;
  const lower = strain.areas.lower;
  const lowerDriven = lower.score * p.lowerWeight > jump.score;
  const score = Math.max(jump.score, lower.score * p.lowerWeight);
  const band: LoadBand = bandFor(score, [cfg.bands.moderate, cfg.bands.high, cfg.bands.extreme]);
  let reduction = plyoReductionFor(score, cfg) * (score >= cfg.bands.moderate ? strain.recoveryScale : 1);
  if (lowReady) reduction = Math.max(reduction, a.recovery.lowReadinessTrim);
  reduction = Math.min(p.max, reduction);

  const programmed = templateContactsOf(template);
  const target = Math.round(programmed * (1 - reduction));
  const rx = template.exercises.map((e, idx) => {
    const ex = plyoExercise(e.exerciseId);
    const rank = ex.intensity * 10 + (isShock(ex) ? 5 : 0) + (ex.unilateral || e.perSide ? 1 : 0);
    return { e, ex, idx, rank, sets: e.sets, reps: e.reps, removed: false };
  });
  const contacts = () => sum(rx.map((r) => (r.removed ? 0 : contactsFor(r.sets, r.reps, r.e.perSide))));
  const removed: string[] = [];
  if (atLeast(band, p.removeReactiveAt)) {
    for (const r of rx) {
      if (isShock(r.ex) && contacts() > target) {
        r.removed = true;
        removed.push(r.e.name);
      }
    }
  }
  // round-robin from the most fatiguing exercise down, one step each, until on target
  const byRank = [...rx].sort((x, y) => y.rank - x.rank || x.idx - y.idx);
  for (let pass = 0; contacts() > target && pass < 50; pass++) {
    let changed = false;
    for (const r of byRank) {
      if (contacts() <= target) break;
      if (r.removed) continue;
      if (r.reps > p.elasticRepsAbove) {
        r.reps = Math.max(p.elasticMinReps, Math.round(r.reps * 0.67));
        changed = true;
      } else if (r.sets > 1) {
        r.sets -= 1;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const prescription: PlyoPlan['prescription'] = {};
  for (const r of rx) prescription[r.e.id] = r.removed ? { sets: 0, reps: r.reps, removed: true } : { sets: r.sets, reps: r.reps };
  const prescribed = contacts();
  const volumeFactor = programmed ? prescribed / programmed : 1;

  let outcome: AdaptationOutcome = volumeFactor >= a.outcome.normal ? 'normal' : volumeFactor >= a.outcome.reduced ? 'reduced' : 'heavily_reduced';
  let alternativeTemplateId: string | undefined;
  if (band === 'extreme') {
    if (opts.primerId && opts.primerId !== template.id) {
      outcome = 'alternative';
      alternativeTemplateId = opts.primerId;
    } else {
      outcome = 'deferred';
    }
  }
  if (readiness !== undefined && readiness < a.recovery.deferBelow && atLeast(band, 'high')) outcome = 'deferred';

  const modified = rx
    .filter((r) => !r.removed && (r.sets !== r.e.sets || r.reps !== r.e.reps))
    .map((r) => ({ name: r.e.name, from: `${r.e.sets}×${r.e.reps}`, to: `${r.sets}×${r.reps}` }));

  const driver = lowerDriven ? lower : jump;
  const word = lowerDriven ? 'lower-body' : 'jump';
  const reasons: string[] = [];
  if (band !== 'low') {
    const ev = evidenceLine(ctx, driver.area);
    if (ev) reasons.push(`${ev}.`);
  }
  if (prescribed < programmed) reasons.push(`Contacts ${programmed} → ${prescribed}.`);
  if (removed.length) reasons.push(`Removed ${removed.join(', ')} first — the most fatiguing landings.`);
  if (modified.length && outcome !== 'alternative' && outcome !== 'deferred') reasons.push('Highest-intensity jumps trimmed first; low-level elastic work kept.');
  const acc = accumulationReason(driver, word, ctx, cfg);
  if (acc) reasons.push(acc);
  const rec = recoveryReason(strain, prescribed < programmed, lowReady);
  if (rec) reasons.push(rec);
  if (outcome === 'alternative') reasons.push('Very high jump volume — the Low-Fatigue Primer keeps the movement without adding fatigue. Or keep the plan.');
  if (outcome === 'deferred') reasons.push('Jump work is already covered — skip plyometrics today or run the reduced session.');
  if (!reasons.length) reasons.push('Recent jump volume is low. Full contacts.');

  const headline =
    outcome === 'normal' ? 'Full contacts'
      : outcome === 'deferred' ? 'Skip plyometrics today'
        : `${BAND_WORD[band]} ${word} load from ${sourcePhrase(ctx, driver, cfg)}`;

  return {
    prescription,
    decision: {
      // schedule notes explain (e.g. a planned practice not logged yet); they never change the numbers
      outcome, volumeFactor, bands: strain.bands, readiness, headline, reasons: [...reasons, ...ctx.planned], alternativeTemplateId,
      date: ctx.date, templateId: template.id, templateName: template.name, level: levelFor(volumeFactor, outcome, cfg),
      plannedVolume: programmed, prescribedVolume: prescribed, unit: 'contacts',
      areas: [{ area: 'jump', band, change: programmed ? (prescribed - programmed) / programmed : 0, preserved: prescribed >= programmed * (1 - a.preservedWithin) }],
      removed, modified,
      inputs: { strain: snapshot(strain), readiness, recoveryScale: strain.recoveryScale, recent: recentList(ctx), ...(ctx.planned.length && { context: ctx.planned }) },
    },
  };
}
