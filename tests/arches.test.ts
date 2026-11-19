import { describe, expect, it } from 'vitest';
import { ArchFollower, ArchTracker } from '../src/world/arches';
import { MotionSmoother } from '../src/world/smoother';

/**
 * Ride logic at 10 Hz (like RideSession), rendering at 60 fps (like WorldView).
 * Returns the arch's per-frame movement in world metres over the last `window` seconds
 * before the interval ends; the arch should hold still, not stutter.
 */
function simulate(extrapolate: boolean) {
  const speed = 10; // m/s
  const arch = new ArchTracker();
  const motion = new MotionSmoother(0);
  const follow = new ArchFollower();
  let dist = 0;
  let remaining = 30;
  let tickAt = 0;
  let nextTick = 0.1;
  let last: number | undefined;
  const moves: number[] = [];
  arch.update(0.1, speed);
  for (let t = 0; t < 29.5; t += 1 / 60) {
    while (t >= nextTick) {
      dist += speed * 0.1;
      remaining -= 0.1;
      arch.update(0.1, speed);
      tickAt = nextTick;
      nextTick += 0.1;
    }
    const d = motion.update(1 / 60, dist, speed);
    const pos = extrapolate
      ? follow.update(1 / 60, d + arch.projectedSpeed * Math.max(0, remaining - Math.min(0.2, t - tickAt)))!
      : arch.archDistance(dist, remaining) + (d - dist); // the old placement
    if (t > 20 && last != null) moves.push(Math.abs(pos - last));
    last = pos;
  }
  return Math.max(...moves);
}

describe('interval arch placement', () => {
  it('the old placement stutters ~1 m per tick (the bug)', () => {
    expect(simulate(false)).toBeGreaterThan(0.5);
  });
  it('holds still in the world as you ride up to it', () => {
    expect(simulate(true)).toBeLessThan(0.05);
  });
});
