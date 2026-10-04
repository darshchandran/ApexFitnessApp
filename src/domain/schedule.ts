import type { ISODate, PlanDay, Rotation, SessionInstance, SlotRef, TrainingPlan } from './types';
import { addDays, weekdayIndex } from './util';

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** '07:00' stays a clock time; a part of the day reads as a word. Unset = any time. */
export const timeLabel = (t: string | undefined) => (!t ? '' : /^\d{2}:\d{2}$/.test(t) ? t : t[0].toUpperCase() + t.slice(1));

export const isRestDay = (d: PlanDay) => !d.gym && !d.plyo;

export const rotationOf = (plan: TrainingPlan, id: string): Rotation | undefined => plan.rotations.find((r) => r.id === id);

/** Completed sessions that came from a rotation — the rotation pointer. */
export const rotationCount = (instances: SessionInstance[], rotationId: string) =>
  instances.filter((i) => i.rotationId === rotationId && i.status === 'completed').length;

/** Resolve a slot to a template. Rotations advance by completion: V1 → V2 → V1 … */
export function resolveSlot(plan: TrainingPlan, slot: SlotRef, instances: SessionInstance[], offset = 0):
  { templateId: string; rotationId?: string } | undefined {
  if ('templateId' in slot) return { templateId: slot.templateId };
  const rot = rotationOf(plan, slot.rotationId);
  if (!rot || !rot.templateIds.length) return undefined;
  const n = rotationCount(instances, rot.id) + offset;
  return { templateId: rot.templateIds[n % rot.templateIds.length], rotationId: rot.id };
}

export const dayFor = (plan: TrainingPlan, date: ISODate) => plan.days[weekdayIndex(date)] ?? {};

/**
 * The coming seven days in weekday order (Mon–Sun), each weekday at its next occurrence
 * from today. Rotation slots are projected chronologically from the pointer, so with
 * Push on Mon and Thu the week reads Push V1 … Push V2.
 */
export function projectWeek(plan: TrainingPlan, instances: SessionInstance[], today: ISODate) {
  const start = weekdayIndex(today);
  const seen = new Map<string, number>(); // rotation id → slots already projected
  const out: {
    date: ISODate; weekday: number; day: PlanDay;
    gym?: { templateId?: string; rotationId?: string; done: boolean };
    plyo?: { templateId?: string; rotationId?: string; done: boolean };
  }[] = [];
  for (let k = 0; k < 7; k++) {
    const i = (start + k) % 7;
    const date = addDays(today, k);
    const day = plan.days[i] ?? {};
    const resolve = (slot: SlotRef | undefined, kind: SessionInstance['kind']) => {
      if (!slot) return undefined;
      const done = k === 0 && instances.find((x) => x.date === date && x.kind === kind && x.status === 'completed');
      if (done) return { templateId: done.templateId, rotationId: done.rotationId, done: true };
      const key = 'rotationId' in slot ? slot.rotationId : '';
      const offset = key ? seen.get(key) ?? 0 : 0;
      if (key) seen.set(key, offset + 1);
      return { ...(resolveSlot(plan, slot, instances, offset) ?? { templateId: undefined }), done: false };
    };
    out[i] = { date, weekday: i, day, gym: resolve(day.gym, 'gym'), plyo: resolve(day.plyo, 'plyometric') };
  }
  return out;
}
