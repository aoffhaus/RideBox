import { describe, expect, it } from 'vitest';
import { avgPowerBetween, intervalWindow } from '../src/ui/intervalWindow';
import type { Sample } from '../src/app/recorder';

describe('intervalWindow', () => {
  it('shows 2 completed, current and 5 upcoming', () => {
    expect(intervalWindow(20, 6)).toEqual({ from: 4, to: 12 });
  });
  it('clamps at the start and end of the workout', () => {
    expect(intervalWindow(20, 0)).toEqual({ from: 0, to: 6 });
    expect(intervalWindow(20, 19)).toEqual({ from: 17, to: 20 });
    expect(intervalWindow(3, 1)).toEqual({ from: 0, to: 3 });
  });
  it('shows only the last completed ones when finished', () => {
    expect(intervalWindow(10, 10, 3)).toEqual({ from: 7, to: 10 });
  });
  it('handles an empty workout', () => {
    expect(intervalWindow(0, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe('avgPowerBetween', () => {
  const samples: Sample[] = Array.from({ length: 20 }, (_, i) => ({
    t: i * 1000,
    elapsed: i,
    power: i < 10 ? 100 : 300,
    speed: 0,
    distance: 0,
    altitude: 0,
  }));
  it('averages samples inside [start, end)', () => {
    expect(avgPowerBetween(samples, 0, 10)).toBe(100);
    expect(avgPowerBetween(samples, 10, 20)).toBe(300);
    expect(avgPowerBetween(samples, 5, 15)).toBe(200);
  });
  it('returns undefined when no samples fall inside', () => {
    expect(avgPowerBetween(samples, 100, 200)).toBeUndefined();
    expect(avgPowerBetween([], 0, 10)).toBeUndefined();
  });
});
