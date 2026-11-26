import { describe, expect, it } from 'vitest';
import {
  bestCurve,
  CURVE_DURATIONS,
  DISTANCE_RECORDS,
  distanceEfforts,
  durationIndex,
  effortsFromStreams,
  movingClock,
  POWER_RECORDS,
  powerCurve,
  topDistance,
  topPower,
  type EffortSource,
} from '../src/training/efforts';

const at = (d: number) => durationIndex(d);

describe('power curve', () => {
  it('finds the best average for each duration and where it starts', () => {
    const p = [...Array(100).fill(100), ...Array(10).fill(400), ...Array(100).fill(150)];
    const c = powerCurve(p)!;
    expect(c.w[at(1)]).toBe(400);
    expect(c.s[at(1)]).toBe(100);
    expect(c.w[at(10)]).toBe(400);
    expect(c.w[at(20)]).toBe(275); // 10 s at 400 + 10 s at 150
    expect(c.w.length).toBe(CURVE_DURATIONS.filter((d) => d <= p.length).length);
  });

  it('rounds down like Strava, without float error', () => {
    expect(powerCurve([305, 305, 305])!.w[at(3)]).toBe(305);
    expect(powerCurve([100, 101])!.w[at(2)]).toBe(100);
  });

  it('has no curve without power', () => {
    expect(powerCurve([0, 0, 0])).toBeUndefined();
    expect(powerCurve([])).toBeUndefined();
  });

  it('includes every Strava record duration', () => {
    for (const r of POWER_RECORDS) expect(at(r.s)).toBeGreaterThanOrEqual(0);
  });
});

describe('from Strava streams', () => {
  it('counts seconds without samples as 0 W on the elapsed clock', () => {
    // 60 s at 300 W, a 60 s pause (no samples), 60 s at 300 W
    const time = [...Array(60).keys(), ...Array.from({ length: 60 }, (_, i) => 120 + i)];
    const watts = time.map(() => 300);
    const e = effortsFromStreams({ time: { data: time }, watts: { data: watts } });
    expect(e.power!.w[at(60)]).toBe(300);
    expect(e.power!.w[at(120)]).toBe(150);
    // the second block starts at second 60 of the moving clock (the pause collapses)
    const best = e.power!.s[at(60)];
    expect([0, 60]).toContain(best);
  });

  it('maps samples to the moving clock like the ride charts', () => {
    const st = { time: { data: [0, 1, 2, 3, 4, 100, 101] }, moving: { data: [true, true, true, false, false, true, true] } };
    expect(movingClock(st)).toEqual([0, 1, 2, 3, 3, 3, 4]);
  });
});

describe('distance efforts', () => {
  it('finds the shortest elapsed time between samples at least that far apart', () => {
    // 10 m/s, then 20 m/s for 2 km, then 10 m/s; 1 Hz
    const time: number[] = [];
    const dist: number[] = [];
    let d = 0;
    for (let t = 0; t <= 3000; t++) {
      time.push(t);
      dist.push(d);
      d += t >= 1000 && t < 1100 ? 20 : 10;
    }
    const e = distanceEfforts(time, dist)!;
    const i10 = DISTANCE_RECORDS.findIndex((r) => r.label === '10K');
    // 2 km at 20 m/s (100 s) + 8 km at 10 m/s (800 s)
    expect(e.t[i10]).toBe(900);
    // the record list stops at the ride's distance (31 km)
    expect(e.t.length).toBe(DISTANCE_RECORDS.filter((r) => r.m <= dist[dist.length - 1]).length);
  });

  it('ignores missing or backwards readings', () => {
    // the missing reading holds 0 m, so 9 km (5 mi, not 10K) takes 1 s; the dip back to 8,999 m is ignored
    const e = distanceEfforts([0, 1, 2, 3], [0, null, 9000, 8999])!;
    expect(e.t).toEqual([1]);
  });
});

const src = (id: string, start: number, w: number[], opts: Partial<EffortSource> = {}): EffortSource => ({
  id,
  kind: 'strava',
  name: id,
  start,
  outdoor: false,
  efforts: { v: 1, power: { w, s: w.map(() => 0) } },
  ...opts,
});

describe('across rides', () => {
  it('takes the best ride at each duration, earliest on a tie', () => {
    const a = src('a', 1, [500, 400, 300]);
    const b = src('b', 2, [600, 400, 200]);
    const c = bestCurve([a, b]);
    expect(c.map((p) => [p.w, p.src.id])).toEqual([[600, 'b'], [400, 'a'], [300, 'a']]);
  });

  it('ranks the top rides per duration, one entry per ride', () => {
    const list = [src('a', 1, [500]), src('b', 2, [700]), src('c', 3, [600]), src('d', 4, [550])];
    expect(topPower(list, 1).map((r) => r.src.id)).toEqual(['b', 'c', 'd']);
  });

  it('counts only outdoor rides for distance records', () => {
    const out = src('out', 1, [], { outdoor: true, efforts: { v: 1, dist: { t: [700], s: [0] } } });
    const indoor = src('in', 2, [], { outdoor: false, efforts: { v: 1, dist: { t: [500], s: [0] } } });
    expect(topDistance([out, indoor], 0).map((r) => r.src.id)).toEqual(['out']);
  });
});
