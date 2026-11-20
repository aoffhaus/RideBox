import { describe, expect, it } from 'vitest';
import type { PlannedWorkout, TrainingPlan } from '../src/training/model';
import { clipPhases, normalizePlan, outsideDates, setActive, upcomingOf } from '../src/training/plans';

const plan = (over: Partial<TrainingPlan> = {}): TrainingPlan => ({
  id: 'p1', name: 'Fondo', goal: 'Finish strong', start: '2026-01-05', end: '2026-03-29', createdAt: 1, active: true,
  phases: [
    { name: 'Base', start: '2026-01-05', end: '2026-02-01', focus: 'aerobic' },
    { name: 'Build', start: '2026-02-02', end: '2026-03-15', focus: 'threshold' },
    { name: 'Taper', start: '2026-03-16', end: '2026-03-29', focus: 'fresh' },
  ],
  ...over,
});
const item = (id: string, date: string, status: PlannedWorkout['status'] = 'planned', planId = 'p1'): PlannedWorkout => ({
  id, date, status, planId, origin: 'plan', createdAt: 1, workout: { name: id, steps: [] },
});

describe('plans', () => {
  it('upcoming workouts are only planned ones from this plan', () => {
    const cal = [item('a', '2026-01-06'), item('b', '2026-01-07', 'done'), item('c', '2026-01-08', 'planned', 'other')];
    expect(upcomingOf(plan(), cal).map((c) => c.id)).toEqual(['a']);
  });

  it('finds planned workouts outside new dates', () => {
    const cal = [item('a', '2026-01-06'), item('b', '2026-03-20'), item('c', '2026-03-25', 'missed')];
    expect(outsideDates(plan({ end: '2026-03-15' }), cal).map((c) => c.id)).toEqual(['b']);
    expect(outsideDates(plan({ start: '2026-01-10' }), cal).map((c) => c.id)).toEqual(['a']);
  });

  it('clips phases and drops empty ones', () => {
    const ph = clipPhases(plan().phases, '2026-01-10', '2026-03-10');
    expect(ph.map((p) => [p.name, p.start, p.end])).toEqual([
      ['Base', '2026-01-10', '2026-02-01'],
      ['Build', '2026-02-02', '2026-03-10'],
    ]);
  });

  it('keeps the coach input in step with edits', () => {
    const input = { goal: 'old', eventType: 'x', startDate: '2026-01-05', endDate: '2026-03-29', weeklyHours: 6, days: {} as never, experience: 'some' as const, detailUntil: '2026-03-29' };
    const p = normalizePlan(plan({ goal: 'new', end: '2026-03-01', eventDate: '2026-03-01', input }));
    expect(p.input).toMatchObject({ goal: 'new', endDate: '2026-03-01', eventDate: '2026-03-01', detailUntil: '2026-03-01' });
  });

  it('setActive returns only the plans that changed', () => {
    const ps = [plan(), plan({ id: 'p2', active: false })];
    expect(setActive(ps, 'p2').map((p) => [p.id, p.active])).toEqual([['p1', false], ['p2', true]]);
    expect(setActive(ps, null).map((p) => [p.id, p.active])).toEqual([['p1', false]]);
  });
});
