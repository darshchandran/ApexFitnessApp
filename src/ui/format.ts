import { gymVolume, plyoLoad, plyoSetsDone, prescribedContacts } from '@/domain/load';
import type { ISODate, PlyometricInstance, SessionInstance, WorkoutInstance } from '@/domain/types';
import { adaptationStatus } from '@/domain/logbook';
import { toUnits, type Units } from '@/domain/profile';
import { parseISODate } from '@/domain/util';
import { statusTone } from './theme';

export const pad2 = (n: number) => String(n).padStart(2, '0');

export const longDate = (iso: ISODate) => parseISODate(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
export const shortDate = (iso: ISODate) => parseISODate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
export const dayMonth = (iso: ISODate) => parseISODate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const weekdayName = (iso: ISODate) => parseISODate(iso).toLocaleDateString('en-GB', { weekday: 'long' });

export const duration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}m` : `${m} min`;
};

export const restLabel = (sec: number) => (sec % 60 === 0 ? `${sec / 60}:00` : `${Math.floor(sec / 60)}:${pad2(sec % 60)}`);

export const repRange = ([lo, hi]: [number, number], unit?: 'reps' | 'sec') => (lo === hi ? `${lo}` : `${lo}–${hi}`) + (unit === 'sec' ? 's' : '');

/** Live sets / prescribed sets, for progress bars and summaries. */
export function sessionProgress(i: SessionInstance) {
  const ex = i.exercises.filter((e) => e.status !== 'removed' && e.status !== 'skipped');
  if (i.kind === 'gym') {
    const done = ex.reduce((n, e) => n + Math.min(e.prescribed.sets, (e as WorkoutInstance['exercises'][number]).sets.filter((s) => s.kind === 'working').length), 0);
    const total = ex.reduce((n, e) => n + e.prescribed.sets, 0);
    return { done, total };
  }
  const done = ex.reduce((n, e) => n + Math.min(e.prescribed.sets, Math.floor(plyoSetsDone((e as PlyometricInstance['exercises'][number]).logs))), 0);
  return { done, total: ex.reduce((n, e) => n + e.prescribed.sets, 0) };
}

/** Prescribed working sets (gym) or contacts (plyo). */
export function prescribedVolume(i: SessionInstance) {
  if (i.kind === 'plyometric') return { value: prescribedContacts(i), unit: 'contacts' };
  return { value: i.exercises.filter((e) => e.status !== 'removed').reduce((n, e) => n + e.prescribed.sets, 0), unit: 'sets' };
}

export const activeExerciseCount = (i: SessionInstance) => i.exercises.filter((e) => e.status !== 'removed').length;

export function estimatedMinutes(i: SessionInstance) {
  const sec = i.exercises.filter((e) => e.status !== 'removed').reduce((n, e) => n + e.prescribed.sets * (e.prescribed.restSec + (i.kind === 'gym' ? 45 : 20)), 0);
  return Math.max(10, Math.round(sec / 300) * 5);
}

export function sessionSummary(i: SessionInstance, u: Units) {
  if (i.kind === 'gym') {
    const v = gymVolume(i);
    return `${v.workingSets} ${v.workingSets === 1 ? 'set' : 'sets'} · ${Math.round(toUnits(v.volumeLoad, u)).toLocaleString('en-GB')} ${u}`;
  }
  return `${plyoLoad(i).contacts} contacts`;
}

export const reduction = (factor: number) => Math.round((1 - factor) * 100);

/** "As planned" / "Adapted" / "Plan kept" / "Alternative" / "Recovery day" with its tone — the same everywhere. */
export function statusOf(i: SessionInstance) {
  const label = adaptationStatus(i);
  return { label, tone: statusTone[label] };
}

export { planVsActual } from '@/domain/logbook';
