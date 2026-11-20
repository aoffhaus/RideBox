import { describe, expect, it } from 'vitest';
import { comparePlan, seriesFromStreams, seriesStats, verdict, type ActualSeries } from '../src/training/actual';
import { flatten, type Workout } from '../src/workout/model';

const wk: Workout = {
  name: 'Test',
  steps: [
    { type: 'steady', duration: 60, power: 0.5 },
    { type: 'steady', duration: 120, power: 1.0, label: 'Work' },
    { type: 'ramp', duration: 60, from: 0.6, to: 0.4 },
  ],
};
const series = (power: number[], hr?: number[]): ActualSeries => ({ length: power.length, power, hr, cadence: power.map(() => 90) });

describe('actual vs plan', () => {
  it('lines intervals up by time and compares to target', () => {
    const p = [...Array(60).fill(100), ...Array(120).fill(190), ...Array(30).fill(100)];
    const rows = comparePlan(flatten(wk), 200, series(p, p.map(() => 140)));
    expect(rows.map((r) => [r.targetW, r.avgPower, r.actualDuration])).toEqual([[100, 100, 60], [200, 190, 120], [100, 100, 30]]);
    expect(rows[1].label).toBe('Work');
    expect(rows[1].ratio).toBeCloseTo(0.95);
    expect(rows[2].rampW).toEqual([120, 80]);
    expect(rows.map(verdict)).toEqual(['hit', 'hit', 'short']);
    expect(rows[0].avgHr).toBe(140);
    expect(rows[0].avgCadence).toBe(90);
  });

  it('flags over and under', () => {
    const rows = comparePlan(flatten(wk), 200, series([...Array(60).fill(130), ...Array(120).fill(150), ...Array(60).fill(100)]));
    expect(rows.map(verdict)).toEqual(['over', 'under', 'hit']);
  });

  it('summarizes a series', () => {
    const st = seriesStats(series(Array(3600).fill(200), Array(3600).fill(150)), 200);
    expect(st.np).toBeCloseTo(200);
    expect(st.tss).toBeCloseTo(100);
    expect(st.avgHr).toBe(150);
    expect(st.avgCadence).toBe(90);
  });
});

describe('Strava streams', () => {
  it('fills short recording gaps and drops stopped time', () => {
    const s = seriesFromStreams({
      time: { data: [0, 1, 3, 4, 100, 101] },
      watts: { data: [100, 110, 120, 130, 0, 140] },
      heartrate: { data: [120, 121, 122, 123, 90, 124] },
      moving: { data: [true, true, true, true, false, true] },
    });
    expect(s.power).toEqual([100, 110, 120, 120, 130, 140]);
    expect(s.hr).toEqual([120, 121, 122, 122, 123, 124]);
    expect(s.cadence).toBeUndefined();
    expect(s.length).toBe(6);
  });
});
