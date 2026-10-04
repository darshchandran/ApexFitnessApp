import { describe, expect, it } from '@jest/globals';
import { previousPerformance, weeklySetsByMuscle } from '../history';
import { recommendProgression } from '../progression';
import { detectPRs, e1rm, headlinePRs } from '../records';
import { generatePlyoInstance } from '../generate';
import { adaptPlyo } from '../adaptation';
import type { SetLog } from '../types';
import { completedGym, emptyCtx, freshData } from '../../test-utils';

const sets = (...xs: [number, number, number?][]): SetLog[] =>
  xs.map(([weight, reps, rir], i) => ({ id: String(i), kind: 'working', weight, reps, rir, completedAt: '' }));

describe('progression', () => {
  it('8/8/8 @ 2 RIR on 6–8 → small increase', () => {
    const r = recommendProgression({ repRange: [6, 8], increment: 2.5, previous: sets([80, 8, 2], [80, 8, 2], [80, 8, 2]) });
    expect(r).toMatchObject({ action: 'increase', weight: 82.5, reps: 6 });
    expect(r.reason).toMatch(/8\/8\/8 @ 2 RIR/);
  });

  it('6/6/5 @ 0 RIR → maintain', () => {
    const r = recommendProgression({ repRange: [6, 8], increment: 2.5, previous: sets([80, 6, 0], [80, 6, 0], [80, 5, 0]) });
    expect(r).toMatchObject({ action: 'maintain', weight: 80 });
  });

  it('inside the range → add reps at the same load', () => {
    expect(recommendProgression({ repRange: [6, 8], increment: 2.5, previous: sets([80, 7, 2], [80, 6, 2]) })).toMatchObject({ action: 'add_reps', weight: 80, reps: 7 });
  });

  it('first set below the range → back off', () => {
    expect(recommendProgression({ repRange: [6, 8], increment: 2.5, previous: sets([100, 4, 0], [100, 3, 0]) })).toMatchObject({ action: 'decrease', weight: 95 });
  });

  it('high training load holds the load instead of increasing', () => {
    expect(recommendProgression({ repRange: [6, 8], increment: 2.5, previous: sets([80, 8, 2], [80, 8, 2]), loadBand: 'high' }).action).toBe('hold');
  });

  it('no history → establish', () => {
    expect(recommendProgression({ repRange: [8, 12], increment: 2.5, previous: [] }).action).toBe('establish');
  });
});

describe('previous performance', () => {
  it('returns the most recent completed working sets, skipping warm-ups and the live session', () => {
    const older = completedGym('legs', '2026-09-30', { 'smith-squat': [[75, 8]] });
    const newer = completedGym('lower', '2026-10-03', { 'smith-squat': [[80, 8], [80, 8], [80, 7]] });
    newer.exercises[0].sets.unshift({ id: 'w', kind: 'warmup', weight: 40, reps: 10, completedAt: '' });
    const live = { ...completedGym('legs', '2026-10-07', { 'smith-squat': [[85, 5]] }), status: 'active' as const };
    const prev = previousPerformance([older, newer, live], 'smith-squat', live.id)!;
    expect(prev.date).toBe('2026-10-03');
    expect(prev.sets.map((s) => `${s.weight}×${s.reps}`)).toEqual(['80×8', '80×8', '80×7']);
    expect(previousPerformance([older], 'lat-pulldown')).toBeUndefined();
  });
});

describe('weekly sets by muscle', () => {
  it('counts primary sets fully and secondary at half, with frequency', () => {
    const a = completedGym('pull', '2026-10-05', { 'lat-pulldown': [[60, 10], [60, 10], [60, 9]] });
    const b = completedGym('upper', '2026-10-07', { 'lat-pulldown': [[62.5, 8], [62.5, 8]] });
    const old = completedGym('pull', '2026-09-20', { 'lat-pulldown': [[50, 10]] });
    const lats = weeklySetsByMuscle([a, b, old], '2026-10-07').find((m) => m.muscle === 'lats')!;
    expect(lats).toEqual({ muscle: 'lats', sets: 5, frequency: 2 });
    expect(weeklySetsByMuscle([a], '2026-10-07').find((m) => m.muscle === 'biceps')!.sets).toBe(1.5);
  });
});

describe('PR detection', () => {
  const first = completedGym('legs', '2026-09-30', { 'smith-squat': [[80, 8], [80, 8], [80, 7]] });

  it('the first session is a baseline, not a record', () => {
    expect(detectPRs(first, [])).toEqual([]);
  });

  it('detects weight, e1RM and volume PRs', () => {
    const next = completedGym('legs', '2026-10-07', { 'smith-squat': [[82.5, 8], [82.5, 8], [82.5, 8]] });
    const kinds = detectPRs(next, [first]).map((p) => p.kind).sort();
    expect(kinds).toEqual(['e1rm', 'volume', 'weight']);
    expect(headlinePRs(detectPRs(next, [first]))).toHaveLength(1);
    expect(headlinePRs(detectPRs(next, [first]))[0]).toMatchObject({ kind: 'weight', value: 82.5, previous: 80, detail: '82.5 kg × 8' });
  });

  it('detects a rep PR at the same load', () => {
    const next = completedGym('legs', '2026-10-07', { 'smith-squat': [[80, 10]] });
    const rep = detectPRs(next, [first]).find((p) => p.kind === 'reps')!;
    expect(rep).toMatchObject({ value: 10, previous: 8 });
  });

  it('no PR when performance is lower', () => {
    const next = completedGym('legs', '2026-10-07', { 'smith-squat': [[75, 8]] });
    expect(detectPRs(next, [first])).toEqual([]);
  });

  it('detects jump-height and distance PRs on plyometrics', () => {
    const t = freshData().plyoTemplates.find((p) => p.id === 'max-power')!;
    const make = (id: string, date: string, cmj: number, broad: number) => {
      const inst = generatePlyoInstance(t, adaptPlyo(t, emptyCtx(date)), { id, date, now: '' });
      inst.status = 'completed';
      inst.exercises[0].logs = [{ id: `${id}a`, reps: 2, value: cmj, completedAt: '' }];
      inst.exercises[3].logs = [{ id: `${id}b`, reps: 2, value: broad, completedAt: '' }];
      return inst;
    };
    const a = make('a', '2026-10-01', 61, 270);
    const b = make('b', '2026-10-07', 63, 268);
    const prs = detectPRs(b, [a]);
    expect(prs.map((p) => [p.kind, p.value])).toEqual([['jumpHeight', 63]]);
    const c = make('c', '2026-10-08', 60, 275);
    expect(detectPRs(c, [a, b]).map((p) => p.kind)).toEqual(['distance']);
  });

  it('edge cases: no fake records', () => {
    // identical repeat
    const same = completedGym('legs', '2026-10-07', { 'smith-squat': [[80, 8], [80, 8], [80, 7]] });
    expect(detectPRs(same, [first])).toEqual([]);
    // a heavy warm-up is not a record
    const warm = completedGym('legs', '2026-10-07', { 'smith-squat': [[75, 8]] });
    warm.exercises[0].sets.unshift({ id: 'w', kind: 'warmup', weight: 120, reps: 1, completedAt: '' });
    expect(detectPRs(warm, [first])).toEqual([]);
    // an exercise done for the first time (e.g. a substitute) is a baseline
    const swapped = completedGym('legs', '2026-10-07', { 'romanian-deadlift': [[100, 8]] });
    expect(detectPRs(swapped, [first])).toEqual([]);
    // records from an unfinished session don't count as history
    const active = { ...completedGym('legs', '2026-10-06', { 'smith-squat': [[200, 1]] }), status: 'active' as const };
    expect(detectPRs(completedGym('legs', '2026-10-07', { 'smith-squat': [[82.5, 8]] }), [first, active]).map((p) => p.kind)).toContain('weight');
  });

  it('bodyweight work gets rep PRs; plyos without a metric never do', () => {
    const a = completedGym('push-v1', '2026-10-01', { 'russian-twist': [[0, 16]] });
    const b = completedGym('push-v1', '2026-10-08', { 'russian-twist': [[0, 20]] });
    expect(detectPRs(b, [a]).map((p) => [p.kind, p.value])).toEqual([['reps', 20]]);

    const t = freshData().plyoTemplates.find((p) => p.id === 'deload')!;
    const mk = (id: string, reps: number) => {
      const inst = generatePlyoInstance(t, adaptPlyo(t, emptyCtx()), { id, date: '2026-10-07', now: '' });
      inst.status = 'completed';
      inst.exercises[0].logs = [{ id: `${id}l`, reps, completedAt: '' }]; // pogo: contacts only
      return inst;
    };
    expect(detectPRs(mk('y', 20), [mk('x', 10)])).toEqual([]);
  });

  it('e1RM uses Epley', () => {
    expect(e1rm(100, 1)).toBe(100);
    expect(e1rm(100, 10)).toBeCloseTo(133.33, 1);
  });
});
