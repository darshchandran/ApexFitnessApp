import { describe, expect, it } from '@jest/globals';
import { APEX_CONFIG } from '../config';
import { basketballLoad, bandFor, contactsFor, gymLoad, gymVolume, plyoLoad, readinessScore } from '../load';
import { adaptPlyo } from '../adaptation';
import { generatePlyoInstance } from '../generate';
import { bball, completedGym, emptyCtx, freshData } from '../../test-utils';

describe('basketball load', () => {
  it('is session-RPE split by movement demands', () => {
    const l = basketballLoad(bball({ durationMin: 60, rpe: 8, jumping: 3, sprinting: 2, changeOfDirection: 2 }));
    expect(l.total).toBe(480);
    expect(l.lowerShare).toBeCloseTo(0.85);
    expect(l.lower).toBeCloseTo(408);
    expect(l.upper).toBeCloseTo(72);
    expect(l.jumps).toBe(150); // 60 min × 2.5 landings/min
  });

  it('a shooting session is light and low on legs', () => {
    const l = basketballLoad(bball({ durationMin: 45, rpe: 4, sessionType: 'shooting' }));
    expect(l.total).toBeCloseTo(180 * 0.85); // shooting is less intense per RPE-minute
    expect(l.lower).toBeCloseTo(180 * 0.85 * 0.55);
    expect(l.lower / APEX_CONFIG.dayRef.lower).toBeLessThan(APEX_CONFIG.bands.moderate);
    expect(bandFor(l.total, APEX_CONFIG.dailyBands)).toBe('low');
  });
});

describe('gym volume and load', () => {
  it('counts working sets only and splits load by region', () => {
    const w = completedGym('legs', '2026-10-06', {
      'smith-squat': [[80, 8, 2], [80, 8, 2], [80, 7, 1]],
      'cable-crunch': [[30, 12]],
    });
    // add a warm-up that must not count
    w.exercises[0].sets.unshift({ id: 'wu', kind: 'warmup', weight: 40, reps: 10, completedAt: '' });
    const v = gymVolume(w);
    expect(v.workingSets).toBe(3); // cable crunch isn't in Legs, so it is ignored
    expect(v.volumeLoad).toBe(80 * 8 + 80 * 8 + 80 * 7);
    const l = gymLoad(w);
    expect(l.lowerSets).toBe(3);
    expect(l.lower).toBeCloseTo((12 + 12 + 13.2) * 1.3); // squat is a heavy compound (cost 3 → ×1.3)
    expect(l.upper).toBe(0);
    expect(l.areas.quads).toBeCloseTo(l.lower);
    expect(l.areas.glutes).toBeCloseTo(l.lower / 2);
  });
});

describe('plyometric contacts', () => {
  it('doubles per-side work and weights by intensity', () => {
    expect(contactsFor(2, 5, true)).toBe(20);
    const t = freshData().plyoTemplates.find((p) => p.id === 'deload')!;
    const inst = generatePlyoInstance(t, adaptPlyo(t, emptyCtx()), { date: '2026-10-07', now: '' });
    inst.exercises[0].logs = [{ id: 'a', reps: 10, completedAt: '' }]; // pogo, intensity 1
    inst.exercises[2].logs = [{ id: 'b', reps: 3, value: 240, completedAt: '' }]; // lateral bound per side, intensity 2
    const l = plyoLoad(inst);
    expect(l.contacts).toBe(10 + 6);
    expect(l.au).toBeCloseTo(10 * 2.5 * 0.5 + 6 * 2.5 * 1 * 1.2); // single-leg contacts weigh 20 % more
  });
});

describe('readiness', () => {
  it('is undefined without a check-in and drops with poor recovery', () => {
    expect(readinessScore(undefined, 'low')).toBeUndefined();
    expect(readinessScore({ date: '', sleepHours: 8, soreness: 1, energy: 5 }, 'low')).toBe(100);
    expect(readinessScore({ date: '', sleepHours: 6, soreness: 3, energy: 3 }, 'high')).toBe(100 - 12 - 12 - 10 - 8);
  });
});
