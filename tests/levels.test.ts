import { describe, expect, it } from 'vitest';
import type { RideRecord } from '../src/app/recorder';
import { applyOutcome, computeLevels, difficultyLabel, rateWorkout, rideOutcome, startLevels } from '../src/training/levels';
import { BUILTIN_WORKOUTS } from '../src/workout/builtin';
import { parseText } from '../src/workout/parsers';

const byName = (n: string) => BUILTIN_WORKOUTS.find((w) => w.name === n)!;

describe('rateWorkout', () => {
  it('puts workouts in the zone they train', () => {
    expect(rateWorkout(byName('Sweet Spot 3x12'), 250).zone).toBe('sweetspot');
    expect(rateWorkout(byName('VO2 Max 5x3'), 250).zone).toBe('vo2max');
    expect(rateWorkout(byName('Endurance 60'), 250).zone).toBe('endurance');
    // overs and unders merge into one threshold block
    expect(rateWorkout(byName('Over-Unders 3x9'), 250).zone).toBe('threshold');
    // many short efforts at 130% are VO2max work, not anaerobic
    expect(rateWorkout(byName('30/30s'), 250).zone).toBe('vo2max');
    expect(rateWorkout(byName('Ramp Test'), 250).zone).toBe('test');
    expect(rateWorkout(parseText('# Sprints\n15m 55%\n8x(30s 150%, 4m30s 45%)\n10m 50%'), 250).zone).toBe('anaerobic');
  });

  it('rates longer and harder versions higher', () => {
    const r = (t: string) => rateWorkout(parseText(t), 250).level;
    expect(r('# a\n10m 55%\n2x(20m 97%, 5m 50%)\n5m 50%')).toBeGreaterThan(r('# b\n10m 55%\n3x(8m 97%, 5m 50%)\n5m 50%'));
    expect(r('# a\n10m 55%\n3x(20m 90%, 5m 50%)\n5m 50%')).toBeGreaterThan(r('# b\n10m 55%\n3x(12m 90%, 5m 50%)\n5m 50%'));
    expect(r('# a\n3h 68%')).toBeGreaterThan(r('# b\n1h 68%'));
    for (const w of BUILTIN_WORKOUTS) {
      const l = rateWorkout(w, 250).level;
      expect(l).toBeGreaterThanOrEqual(1);
      expect(l).toBeLessThanOrEqual(10);
    }
  });
});

const rideWith = (laps: { target: number; power: number; secs: number }[], feel?: number): RideRecord => {
  const samples: RideRecord['samples'] = [];
  const out: RideRecord['laps'] = [];
  for (const l of laps) {
    const start = samples.length;
    for (let i = 0; i < l.secs; i++) samples.push({ t: 0, elapsed: samples.length, power: l.power, speed: 0, distance: 0, altitude: 0, target: l.target });
    out.push({ startIndex: start, endIndex: samples.length, target: l.target });
  }
  return { id: 'r', name: 'r', routeName: '', startTime: 0, ftp: 250, samples, laps: out, summary: {} as RideRecord['summary'], feel };
};

describe('rideOutcome', () => {
  const plan = [
    { target: 125, power: 125, secs: 600 },
    { target: 240, power: 240, secs: 1200 },
    { target: 125, power: 110, secs: 300 },
  ];
  it('passes a workout ridden as planned (easy laps don\'t count)', () => {
    expect(rideOutcome(rideWith(plan), 2100).outcome).toBe('pass');
  });
  it('fails when work intervals fall well short or the ride is cut short', () => {
    expect(rideOutcome(rideWith([plan[0], { ...plan[1], power: 190 }, plan[2]]), 2100).outcome).toBe('fail');
    expect(rideOutcome(rideWith([plan[0], { ...plan[1], secs: 600 }]), 2100).outcome).toBe('fail');
    expect(rideOutcome(rideWith([plan[0], { ...plan[1], power: 218 }, plan[2]]), 2100).outcome).toBe('struggle');
  });
  it('counts an all-out feel on a barely-held workout as a struggle', () => {
    expect(rideOutcome(rideWith([plan[0], { ...plan[1], power: 232 }, plan[2]], 5), 2100).outcome).toBe('struggle');
  });
});

describe('level updates', () => {
  const L = { ...startLevels(), threshold: 4 };
  it('raises a level to a harder workout that was completed', () => {
    expect(applyOutcome(L, { zone: 'threshold', level: 5 }, 'pass').threshold).toBe(5.2);
    expect(applyOutcome(L, { zone: 'threshold', level: 5 }, 'pass', 2).threshold).toBe(5.5);
  });
  it('keeps the level for easy or struggled workouts, lowers it a little on a failure', () => {
    expect(applyOutcome(L, { zone: 'threshold', level: 2 }, 'pass').threshold).toBe(4);
    expect(applyOutcome(L, { zone: 'threshold', level: 5 }, 'struggle').threshold).toBe(4);
    expect(applyOutcome(L, { zone: 'threshold', level: 4 }, 'fail').threshold).toBe(3.7);
    expect(applyOutcome(L, { zone: 'threshold', level: 6 }, 'fail').threshold).toBe(4); // failing a stretch costs nothing
  });
  it('sets the first level in a zone from the first workout', () => {
    expect(applyOutcome(startLevels(), { zone: 'vo2max', level: 5 }, 'pass').vo2max).toBe(5);
    expect(applyOutcome(startLevels(), { zone: 'vo2max', level: 5 }, 'fail').vo2max).toBe(4);
    expect(difficultyLabel({ zone: 'vo2max', level: 5 }, startLevels()).label).toBe('Not rated yet');
  });

  it('labels workouts relative to the level', () => {
    expect(difficultyLabel({ zone: 'threshold', level: 2.5 }, L).label).toBe('Easy');
    expect(difficultyLabel({ zone: 'threshold', level: 4.3 }, L).label).toBe('Productive');
    expect(difficultyLabel({ zone: 'threshold', level: 5.3 }, L).label).toBe('Challenging');
    expect(difficultyLabel({ zone: 'threshold', level: 6 }, L).label).toBe('Very hard');
  });
});

describe('computeLevels', () => {
  it('replays rides linked to workouts, and decays untrained zones', () => {
    const w = parseText('# Thr\n10m 55%\n2x(20m 97%, 5m 50%)\n5m 50%');
    const rating = rateWorkout(w, 250);
    const ride = { ...rideWith([{ target: 137, power: 137, secs: 600 }, { target: 242, power: 245, secs: 1200 }, { target: 125, power: 125, secs: 300 }, { target: 242, power: 245, secs: 1200 }, { target: 125, power: 125, secs: 600 }]), id: 'r1', workoutName: 'Thr', startTime: Date.UTC(2026, 0, 5) };
    const now = Date.UTC(2026, 0, 10);
    const { levels, history } = computeLevels([ride], [], [], [w], 250, now);
    expect(levels.threshold).toBeCloseTo(rating.level, 5); // first workout in a zone sets the level
    expect(history).toHaveLength(1);
    const later = computeLevels([ride], [], [], [w], 250, Date.UTC(2026, 2, 30)).levels.threshold!;
    expect(later).toBeLessThan(levels.threshold!);
    expect(levels.vo2max).toBeNull();
  });

  it('decays an idle zone by 0.1 a week after 4 weeks, however much other zones are ridden', () => {
    const w = parseText('# Thr\n10m 55%\n2x(20m 97%, 5m 50%)\n5m 50%');
    const t0 = Date.UTC(2026, 0, 5);
    const day = 86_400_000;
    const ride = { ...rideWith([{ target: 137, power: 137, secs: 600 }, { target: 242, power: 245, secs: 1200 }, { target: 125, power: 125, secs: 300 }, { target: 242, power: 245, secs: 1200 }, { target: 125, power: 125, secs: 600 }]), id: 'r1', workoutName: 'Thr', startTime: t0 };
    // three long endurance rides a week for 10 weeks, no threshold work
    const acts = Array.from({ length: 30 }, (_, i) => ({
      id: `strava-${i}`, stravaId: i + 1, name: 'Long ride', sportType: 'Ride',
      start: t0 + (Math.floor(i / 3) * 7 + 1 + 2 * (i % 3)) * day, movingTime: 2 * 3600, distance: 60000, weightedWatts: 160, deviceWatts: true,
    }));
    const now = t0 + 70 * day + 3600_000;
    const start = computeLevels([ride], [], [], [w], 250, t0 + day).levels.threshold!;
    const idle = computeLevels([ride], acts, [], [w], 250, now).levels.threshold!;
    expect(idle).toBeCloseTo(start - 0.6, 5); // 10 weeks idle = 6 weeks of decay
    expect(computeLevels([ride], [], [], [w], 250, now).levels.threshold!).toBeCloseTo(idle, 5);
  });

  it('counts long steady outdoor rides as endurance', () => {
    const act = { id: 'strava-1', stravaId: 1, name: 'Long ride', sportType: 'Ride', start: Date.UTC(2026, 0, 5), movingTime: 3 * 3600, distance: 90000, weightedWatts: 170, deviceWatts: true };
    expect(computeLevels([], [act], [], [], 250, Date.UTC(2026, 0, 6)).levels.endurance).toBeGreaterThan(5);
  });
});
