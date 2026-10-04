// A few useful observations, each computed from stored sessions. No generic motivation.
import { GROUP_LABEL } from './areas';
import { APEX_CONFIG, type ApexConfig } from './config';
import { plyoLoad } from './load';
import { e1rm } from './records';
import { computeStrain, type TrainingContext } from './strain';
import type { ISODate, MuscleGroup, SessionInstance } from './types';
import { addDays } from './util';
import { MUSCLE_GROUPS, weeklySets } from './volume';

export interface Insight {
  id: string;
  text: string;
  tone: 'neutral' | 'positive' | 'attention';
}

const pct = (x: number) => Math.round(Math.abs(x) * 100);

/** Load change week over week for lower body, upper body and jumps. */
function loadChange(ctx: TrainingContext, cfg: ApexConfig): Insight[] {
  const s = computeStrain(ctx, cfg);
  const out: Insight[] = [];
  for (const [area, word] of [['lower', 'Lower-body'], ['upper', 'Upper-body'], ['jump', 'Jump']] as const) {
    const a = s.areas[area];
    if (a.prev7 < cfg.insights.minWeeklyLoad || a.acute7 < cfg.insights.minWeeklyLoad) continue;
    const change = (a.acute7 - a.prev7) / a.prev7;
    if (Math.abs(change) < cfg.insights.loadChange) continue;
    out.push({
      id: `load-${area}`,
      text: `${word} load is ${change > 0 ? 'up' : 'down'} ${pct(change)}% on the previous 7 days.`,
      tone: change > 0 && a.accumulated !== 'low' && a.accumulated !== 'moderate' ? 'attention' : 'neutral',
    });
  }
  return out;
}

/** Same muscle, similar weekly sets for N weeks running. */
function steadyVolume(instances: SessionInstance[], date: ISODate, cfg: ApexConfig): Insight[] {
  const n = cfg.insights.steadyWeeks;
  const weeks = Array.from({ length: n }, (_, k) => weeklySets(instances, addDays(date, -7 * k)));
  const steady = MUSCLE_GROUPS
    .map((g) => ({ g, sets: weeks.map((w) => w[g]) }))
    .filter(({ sets }) => sets.every((x) => x > 0) && Math.max(...sets) / Math.min(...sets) <= 1 + cfg.insights.steadyTolerance)
    .sort((a, b) => b.sets[0] - a.sets[0]);
  if (!steady.length) return [];
  const { g, sets } = steady[0];
  const avg = Math.round(sets.reduce((a, b) => a + b, 0) / n);
  return [{ id: `steady-${g}`, text: `${GROUP_LABEL[g as MuscleGroup]} volume has been consistent for ${n} weeks — about ${avg} sets a week.`, tone: 'positive' }];
}

/** Consecutive weeks where a template's lead lift improved its best estimated max. */
function progressionStreak(instances: SessionInstance[], date: ISODate, cfg: ApexConfig): Insight[] {
  const byTemplate = new Map<string, SessionInstance[]>();
  for (const i of instances) {
    if (i.kind !== 'gym' || i.status !== 'completed' || i.date > date) continue;
    byTemplate.set(i.templateId, [...(byTemplate.get(i.templateId) ?? []), i]);
  }
  const out: Insight[] = [];
  for (const sessions of byTemplate.values()) {
    const lead = sessions[0].exercises[0]?.exerciseId;
    if (!lead) continue;
    // best e1RM on the lead lift per week (weeks counted back from `date`)
    const weekly = new Map<number, number>();
    for (const s of sessions) {
      const week = Math.floor((Date.parse(date) - Date.parse(s.date)) / (7 * 86_400_000));
      const sets = s.kind === 'gym' ? s.exercises.filter((e) => e.exerciseId === lead).flatMap((e) => e.sets.filter((x) => x.kind === 'working' && x.weight > 0)) : [];
      if (!sets.length) continue;
      const best = Math.max(...sets.map((x) => e1rm(x.weight, x.reps)));
      weekly.set(week, Math.max(weekly.get(week) ?? 0, best));
    }
    let streak = 0;
    for (let w = 0; weekly.has(w) && weekly.has(w + 1) && weekly.get(w)! > weekly.get(w + 1)!; w++) streak++;
    if (streak >= cfg.insights.progressionWeeks) {
      const s = sessions[sessions.length - 1];
      const leadName = s.kind === 'gym' ? s.exercises.find((e) => e.exerciseId === lead)?.name : undefined;
      out.push({ id: `progress-${s.templateId}`, text: `${s.templateName}: ${streak + 1} weeks in a row of progress on ${leadName ?? 'the lead lift'}.`, tone: 'positive' });
    }
  }
  return out;
}

/** This week's plyometric contacts against the previous three weeks' average. */
function plyoVsAverage(instances: SessionInstance[], date: ISODate, cfg: ApexConfig): Insight[] {
  const contactsIn = (from: ISODate, to: ISODate) => instances
    .filter((i) => i.kind === 'plyometric' && i.status === 'completed' && i.date >= from && i.date <= to)
    .reduce((n, i) => n + (i.kind === 'plyometric' ? plyoLoad(i, cfg).contacts : 0), 0);
  const thisWeek = contactsIn(addDays(date, -6), date);
  const prior = [1, 2, 3].map((k) => contactsIn(addDays(date, -6 - 7 * k), addDays(date, -7 * k)));
  const avg = prior.reduce((a, b) => a + b, 0) / 3;
  if (!thisWeek || avg <= 0 || prior.filter((x) => x > 0).length < 2) return [];
  const change = (thisWeek - avg) / avg;
  if (change < cfg.insights.plyoAboveAverage) return [];
  return [{ id: 'plyo-high', text: `Plyometric contacts are ${pct(change)}% above your recent average (${thisWeek} vs ~${Math.round(avg)}).`, tone: 'attention' }];
}

/** The muscle furthest below its weekly target, once the athlete is training this week. */
function underTarget(instances: SessionInstance[], date: ISODate, cfg: ApexConfig): Insight[] {
  const sets = weeklySets(instances, date);
  const total = Object.values(sets).reduce((a, b) => a + b, 0);
  if (total < 20) return [];
  const gaps = MUSCLE_GROUPS
    .map((g) => ({ g, sets: sets[g], lo: cfg.weeklySetTargets[g][0], hi: cfg.weeklySetTargets[g][1] }))
    .filter((x) => x.sets < x.lo)
    .sort((a, b) => (a.sets / a.lo) - (b.sets / b.lo));
  if (!gaps.length) return [];
  const x = gaps[0];
  return [{ id: `under-${x.g}`, text: `${GROUP_LABEL[x.g]}: ${x.sets} sets in the last 7 days — under the ${x.lo}–${x.hi} target.`, tone: 'attention' }];
}

export function insights(ctx: TrainingContext, instances: SessionInstance[], cfg: ApexConfig = APEX_CONFIG): Insight[] {
  return [
    ...loadChange(ctx, cfg),
    ...plyoVsAverage(instances, ctx.date, cfg),
    ...progressionStreak(instances, ctx.date, cfg),
    ...underTarget(instances, ctx.date, cfg),
    ...steadyVolume(instances, ctx.date, cfg),
  ].slice(0, cfg.insights.max);
}
