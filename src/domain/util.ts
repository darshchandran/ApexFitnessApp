import type { ISODate } from './types';

let counter = 0;
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date, not UTC — a 23:30 session belongs to today. */
export const toISODate = (d: Date): ISODate => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseISODate = (iso: ISODate) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (iso: ISODate, n: number): ISODate => {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
};

export const daysBetween = (from: ISODate, to: ISODate) =>
  Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / 86_400_000);

/** 0 = Monday … 6 = Sunday */
export const weekdayIndex = (iso: ISODate) => (parseISODate(iso).getDay() + 6) % 7;

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const roundTo = (x: number, step: number) => Math.round(x / step) * step;
