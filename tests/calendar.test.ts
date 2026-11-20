import { describe, expect, it } from 'vitest';
import type { RideRecord } from '../src/app/recorder';
import { copyTo, monthWeeks, moveTo, reconcile, scaleWorkout, weekStart } from '../src/training/calendar';
import type { PlannedWorkout, StravaActivity } from '../src/training/model';
import type { Workout } from '../src/workout/model';

const w = (name: string): Workout => ({
  name,
  steps: [
    { type: 'ramp', duration: 600, from: 0.45, to: 0.7 },
    { type: 'repeat', count: 2, steps: [{ type: 'steady', duration: 1200, power: 0.95 }, { type: 'steady', duration: 300, power: 0.5 }] },
    { type: 'steady', duration: 300, power: 300, unit: 'watts' },
  ],
});
const pw = (id: string, date: string, extra: Partial<PlannedWorkout> = {}): PlannedWorkout => ({ id, date, workout: w(id), status: 'planned', origin: 'plan', createdAt: 0, ...extra });
const at = (date: string, h = 9) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, h).getTime();
};
const ride = (id: string, date: string, workoutName?: string, activityId?: number): RideRecord =>
  ({ id, name: id, workoutName, routeName: '', startTime: at(date), ftp: 250, samples: [], laps: [], summary: { duration: 3600 } as RideRecord['summary'], strava: activityId ? { status: 'done', activityId } : undefined }) as RideRecord;
const act = (id: number, date: string, movingTime = 3600, sportType = 'Ride'): StravaActivity => ({ id: `strava-${id}`, stravaId: id, name: 'x', sportType, start: at(date, 7), movingTime, distance: 0 });
const secs = () => 3600;

describe('calendar grid', () => {
  it('starts weeks on Monday and covers the whole month', () => {
    expect(weekStart('2026-11-19')).toBe('2026-11-16'); // Thursday → Monday
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
    expect(weekStart('2026-11-22')).toBe('2026-11-16'); // Sunday
    const weeks = monthWeeks(2026, 10); // November 2026
    expect(weeks[0]).toBe('2026-10-26');
    expect(weeks[weeks.length - 1]).toBe('2026-11-30');
  });
});

describe('reconcile', () => {
  it('links a RideBox ride, preferring the one with the same workout name', () => {
    const cal = [pw('a', '2026-11-10'), pw('b', '2026-11-10')];
    const out = reconcile(cal, [ride('r1', '2026-11-10', 'b')], [], secs, '2026-11-19');
    expect(out.find((p) => p.id === 'b')).toMatchObject({ status: 'done', rideId: 'r1' });
    expect(out.find((p) => p.id === 'a')).toMatchObject({ status: 'missed' });
  });

  it('links an outdoor Strava ride that was long enough, but not runs or short spins', () => {
    const cal = [pw('a', '2026-11-10'), pw('b', '2026-11-11'), pw('c', '2026-11-12')];
    const out = reconcile(cal, [], [act(1, '2026-11-10'), act(2, '2026-11-11', 3600, 'Run'), act(3, '2026-11-12', 600)], secs, '2026-11-19');
    expect(out.map((p) => [p.id, p.status, p.stravaId]).sort()).toEqual([
      ['a', 'done', 'strava-1'],
      ['b', 'missed', undefined],
      ['c', 'missed', undefined],
    ]);
  });

  it("doesn't double count the Strava copy of an uploaded RideBox ride", () => {
    const cal = [pw('a', '2026-11-10'), pw('b', '2026-11-10')];
    const out = reconcile(cal, [ride('r1', '2026-11-10', undefined, 9)], [act(9, '2026-11-10')], secs, '2026-11-19');
    expect(out.filter((p) => p.status === 'done')).toHaveLength(1);
  });

  it("leaves today and the future alone, and revives a missed workout when a ride shows up", () => {
    expect(reconcile([pw('t', '2026-11-19'), pw('f', '2026-11-25')], [], [], secs, '2026-11-19')).toEqual([]);
    const out = reconcile([pw('m', '2026-11-10', { status: 'missed' })], [], [act(4, '2026-11-10')], secs, '2026-11-19');
    expect(out[0]).toMatchObject({ status: 'done', stravaId: 'strava-4' });
  });

  it('never reuses a ride already linked elsewhere', () => {
    const cal = [pw('a', '2026-11-10', { status: 'done', rideId: 'r1' }), pw('b', '2026-11-10')];
    const out = reconcile(cal, [ride('r1', '2026-11-10')], [], secs, '2026-11-19');
    expect(out).toEqual([{ ...cal[1], status: 'missed' }]);
  });
});

describe('move / copy', () => {
  it('appends to the target day and revives missed workouts moved forward', () => {
    const cal = [pw('a', '2026-11-10', { status: 'missed' }), pw('b', '2026-11-20', { order: 0 })];
    const m = moveTo(cal[0], '2026-11-20', cal, '2026-11-19');
    expect(m).toMatchObject({ date: '2026-11-20', order: 1, status: 'planned' });
    expect(moveTo(cal[0], '2026-11-12', cal, '2026-11-19').status).toBe('missed');
  });
  it('copies as a fresh planned workout', () => {
    const cal = [pw('a', '2026-11-10', { status: 'done', rideId: 'r' })];
    const c = copyTo(cal[0], '2026-11-21', cal);
    expect(c.id).not.toBe('a');
    expect(c).toMatchObject({ date: '2026-11-21', status: 'planned', rideId: undefined, origin: 'manual' });
  });
});

describe('scaleWorkout', () => {
  it('scales work intervals only and names the variant', () => {
    const e = scaleWorkout(w('Threshold'), 0.95);
    expect(e.name).toBe('Threshold (easier)');
    const rep = e.steps[1] as Extract<Workout['steps'][number], { type: 'repeat' }>;
    expect((rep.steps[0] as { power: number }).power).toBeCloseTo(0.9025, 2);
    expect((rep.steps[1] as { power: number }).power).toBe(0.5); // recovery untouched
    expect(e.steps[0]).toMatchObject({ from: 0.45, to: 0.665 });
    expect((e.steps[2] as { power: number }).power).toBe(285);
    expect(scaleWorkout(e, 1.05).name).toBe('Threshold (harder)');
  });
});

describe('Strava copies of RideBox rides', () => {
  it('never links the Strava copy of an in-app ride to another planned workout', () => {
    const cal = [pw('a', '2026-11-10'), pw('b', '2026-11-10')];
    // same ride reached Strava another way (not uploaded by RideBox): starts within 2 minutes
    const copy = { ...act(77, '2026-11-10'), start: at('2026-11-10') + 60_000 };
    const out = reconcile(cal, [ride('r1', '2026-11-10', 'a')], [copy], secs, '2026-11-19');
    expect(out.find((p) => p.id === 'a')).toMatchObject({ status: 'done', rideId: 'r1' });
    expect(out.find((p) => p.id === 'b')).toMatchObject({ status: 'missed' });
  });

  it('only downloads streams for activities that are not copies and not saved yet', async () => {
    const { streamCandidates } = await import('../src/strava/streams');
    const r = ride('r1', '2026-11-10', 'a', 55);
    const acts = [act(55, '2026-11-10'), { ...act(56, '2026-11-11'), start: at('2026-11-10') + 30_000 }, act(57, '2026-11-12'), act(58, '2026-11-13')];
    expect(streamCandidates(acts, [r], new Set(['strava-58'])).map((a) => a.stravaId)).toEqual([57]);
  });
});
