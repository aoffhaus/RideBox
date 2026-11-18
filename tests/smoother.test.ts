import { describe, expect, it } from 'vitest';
import { MotionSmoother } from '../src/world/smoother';
import { DEFAULT_RIDER, stepSpeed } from '../src/physics/rider';

describe('motion smoothing', () => {
  it('renders 60 fps motion without the 10 Hz stair-steps', () => {
    // ride logic at 10 Hz (like RideSession), render at 60 fps
    let v = 0;
    let dist = 0;
    let logicT = 0;
    const sm = new MotionSmoother(0);
    const frame = 1 / 60;
    const rawV: number[] = [];
    const smV: number[] = [];
    let prevRaw = 0;
    let prevSm = 0;
    for (let t = 0; t < 60; t += frame) {
      while (logicT + 0.1 <= t) {
        logicT += 0.1;
        const power = 200 + 60 * Math.sin(logicT * 0.5); // varying effort
        v = stepSpeed(v, power, 0.02 * Math.sin(logicT * 0.1), 0.1, DEFAULT_RIDER);
        dist += v * 0.1;
      }
      const d = sm.update(frame, dist, v);
      if (t > 10) {
        rawV.push((dist - prevRaw) / frame);
        smV.push((d - prevSm) / frame);
        expect(Math.abs(d - dist)).toBeLessThan(1.5); // stays close to the truth
      }
      prevRaw = dist;
      prevSm = d;
    }
    const jitter = (xs: number[]) => {
      let s = 0;
      for (let i = 1; i < xs.length; i++) s += Math.abs(xs[i] - xs[i - 1]);
      return s / (xs.length - 1);
    };
    // per-frame speed changes: raw jumps 0 → 6 × speed every 6th frame; smoothed is tiny
    expect(jitter(rawV)).toBeGreaterThan(5);
    expect(jitter(smV)).toBeLessThan(0.05);
    expect(Math.min(...smV)).toBeGreaterThan(0); // never moves backwards
  });
});
