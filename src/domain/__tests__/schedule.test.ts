import { describe, expect, it } from '@jest/globals';
import { projectWeek, resolveSlot } from '../schedule';
import { seedPlan } from '../seed';
import { completedGym } from '../../test-utils';

describe('schedule', () => {
  it('projects the coming week with the Push rotation alternating V1 → V2', () => {
    const week = projectWeek(seedPlan(), [], '2026-10-04'); // Sunday
    expect(week.map((d) => d.gym?.templateId ?? 'rest')).toEqual(['push-v1', 'pull', 'legs', 'push-v2', 'upper', 'lower', 'rest']);
    expect(week[0].date).toBe('2026-10-05');
    expect(week[6].date).toBe('2026-10-04');
  });

  it('advances the rotation pointer only on completion', () => {
    const plan = seedPlan();
    const slot = { rotationId: 'rot-push' };
    expect(resolveSlot(plan, slot, [])!.templateId).toBe('push-v1');
    const done = { ...completedGym('push-v1', '2026-10-05', {}), rotationId: 'rot-push' };
    expect(resolveSlot(plan, slot, [done])!.templateId).toBe('push-v2');
    expect(resolveSlot(plan, slot, [{ ...done, status: 'active' }])!.templateId).toBe('push-v1');
  });
});
