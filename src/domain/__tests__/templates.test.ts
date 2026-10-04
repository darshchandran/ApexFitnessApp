import { describe, expect, it } from '@jest/globals';
import { templateContacts } from '../load';
import { SEED_GYM, seedGymTemplates, seedPlyoTemplates } from '../seed';
import * as T from '../templates';
import type { WorkoutTemplate } from '../types';
import { deepFreeze } from '../../test-utils';

const NOW = '2026-10-07T00:00:00.000Z';

describe('seeded program', () => {
  it('matches the user program verbatim', () => {
    const gym = seedGymTemplates(NOW);
    const asText = (id: string) => gym.find((t) => t.id === id)!.exercises.map((e) => `${e.name} — ${e.sets}`);
    expect(gym.map((t) => t.name)).toEqual(['Push V1', 'Push V2', 'Pull', 'Legs', 'Upper', 'Lower']);
    expect(asText('legs')).toEqual([
      'Smith Machine Squat — 3', 'Romanian Deadlift — 3', 'Leg Press — 3', 'Seated Leg Curl — 3',
      'Bulgarian Deadlift — 2', 'Leg Extension Machine — 2', 'Barbell Calf Raise — 3', 'Tibialis Raises — 2',
    ]);
    expect(asText('upper')).toEqual([
      'Incline Dumbbell Bench Press — 3', 'Lat Pulldown — 3', 'Chest Supported Rows — 3', 'Chest Press — 3',
      'Lateral Machine Raise — 2', 'Cable Face Pull — 2', 'EZ-Bar Curl — 2', 'Single Arm Tricep Extension — 2',
    ]);
    expect(asText('lower')).toEqual([
      'Smith Machine Squat — 3', 'Leg Press — 3', 'Lying Leg Curl Machine — 3', 'Lunges — 2',
      'Leg Extension Machine — 2', 'Farmers Walk — 1', 'Barbell Calf Raise — 3', 'Cable Crunch — 3',
    ]);
    expect(asText('push-v2')[0]).toBe('Flat Dumbbell Bench Press — 3');
    expect(asText('pull')).toHaveLength(8);
    // spelling variants keep the user's text but share exercise history
    const upper = gym.find((t) => t.id === 'upper')!;
    const pull = gym.find((t) => t.id === 'pull')!;
    expect(upper.exercises[2].exerciseId).toBe(pull.exercises[1].exerciseId);
    expect(SEED_GYM).toHaveLength(6);
  });

  it('seeds the seven plyometric templates with per-side contacts', () => {
    const plyo = seedPlyoTemplates(NOW);
    expect(plyo.map((t) => t.name)).toEqual([
      'Elastic Foundation', 'Vertical Power', 'Reactive', 'Basketball Explosive', 'Low-Fatigue Primer', 'Max Power', 'Deload',
    ]);
    const vp = plyo.find((t) => t.id === 'vertical-power')!;
    expect(templateContacts(vp)).toBe(4 * 3 + 4 * 3 + 4 * 3 + 2 * 5);
    const ef = plyo.find((t) => t.id === 'elastic-foundation')!;
    // lateral bound 2 × 5/side = 20 contacts
    expect(templateContacts(ef)).toBe(45 + 15 + 12 + 9 + 20);
  });
});

describe('template operations', () => {
  const base = () => deepFreeze(seedGymTemplates(NOW).find((t) => t.id === 'pull')!) as WorkoutTemplate;

  it('creates an empty template of either kind', () => {
    const g = T.createTemplate('gym', 'Arms', NOW);
    const p = T.createTemplate('plyometric', 'Plyo B', NOW);
    expect(g).toMatchObject({ kind: 'gym', name: 'Arms', exercises: [] });
    expect(p.kind).toBe('plyometric');
    expect(g.id).not.toBe(p.id);
  });

  it('duplicates with new ids and leaves the original untouched', () => {
    const t = base();
    const copy = T.duplicateTemplate(t, NOW);
    expect(copy.id).not.toBe(t.id);
    expect(copy.name).toBe('Pull Copy');
    expect(copy.exercises.map((e) => e.name)).toEqual(t.exercises.map((e) => e.name));
    expect(copy.exercises.every((e, i) => e.id !== t.exercises[i].id)).toBe(true);
  });

  it('adds, removes, reorders and edits exercises immutably (frozen input)', () => {
    const t = base();
    const added = T.addGymExercise(t, 'ez-bar-curl', NOW);
    expect(added.exercises).toHaveLength(9);
    expect(added.exercises[8]).toMatchObject({ name: 'EZ-Bar Curl', sets: 3, repRange: [8, 12] });

    const moved = T.moveExercise(t, t.exercises[1].id, -1, NOW);
    expect(moved.exercises.slice(0, 2).map((e) => e.name)).toEqual(['Chest Supported Row', 'Lat Pulldown']);
    expect(T.moveExercise(t, t.exercises[0].id, -1, NOW)).toBe(t); // no-op at the edge

    const removed = T.removeExercise(t, t.exercises[0].id, NOW);
    expect(removed.exercises.map((e) => e.name)).not.toContain('Lat Pulldown');

    const edited = T.updateExercise(t, t.exercises[0].id, { sets: 4, notes: 'pause at chest' }, NOW);
    expect(edited.exercises[0]).toMatchObject({ sets: 4, notes: 'pause at chest' });
    expect(t.exercises[0].sets).toBe(3);
  });

  it('pairs and unpairs supersets', () => {
    const t = base();
    const paired = T.toggleSuperset(t, t.exercises[5].id, NOW);
    const g = paired.exercises[5].supersetGroup;
    expect(g).toBeDefined();
    expect(paired.exercises[6].supersetGroup).toBe(g);
    const unpaired = T.toggleSuperset(paired, paired.exercises[6].id, NOW);
    expect(unpaired.exercises.every((e) => !e.supersetGroup)).toBe(true);
  });
});
