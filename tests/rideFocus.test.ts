import { describe, expect, it } from 'vitest';
import { rideFocus } from '../src/strava/uploadRide';
import { rateWorkout, ZONE_NAMES } from '../src/training/levels';
import { BUILTIN_WORKOUTS } from '../src/workout/builtin';
import type { RideRecord } from '../src/app/recorder';

const ride = (over: Partial<RideRecord>): RideRecord =>
  ({ id: 'r', name: 'x', routeName: 'Hills', startTime: 0, ftp: 250, samples: [], laps: [], summary: { if: 0.65 } as RideRecord['summary'], ...over }) as RideRecord;

describe('rideFocus', () => {
  it('rates the built-in sweet spot workout as Sweet Spot', () => {
    const w = BUILTIN_WORKOUTS.find((x) => /sweet spot/i.test(x.name))!;
    expect(ZONE_NAMES[rateWorkout(w, 250).zone]).toBe('Sweet Spot');
  });
  it('uses the stored focus when there is one', () => {
    expect(rideFocus(ride({ focus: 'Threshold' }))).toBe('Threshold');
  });
  it('falls back to the zone of the ride IF', () => {
    expect(rideFocus(ride({}))).toBe('Endurance');
    expect(rideFocus(ride({ summary: { if: 0.91 } as RideRecord['summary'] }))).toBe('Sweet Spot');
  });
});
