import { describe, expect, it } from 'vitest';
import { PhotoPlanner, PHOTO_WARMUP_S, SCENIC_EVERY_S } from '../src/app/photos';
import type { Sample } from '../src/app/recorder';

const sample = (elapsed: number, power: number): Sample => ({ t: elapsed * 1000, elapsed, power, speed: 8, distance: elapsed * 8, altitude: 0 });

/** Feeds a 1 Hz power profile through the planner; returns [elapsed, kind] for each shot. */
function run(power: (t: number) => number, seconds: number) {
  const p = new PhotoPlanner();
  const samples: Sample[] = [];
  const shots: [number, string][] = [];
  for (let t = 1; t <= seconds; t++) {
    samples.push(sample(t, power(t)));
    const k = p.tick(samples);
    if (k) shots.push([t, k]);
  }
  return shots;
}

describe('PhotoPlanner', () => {
  it('takes a scenic shot every few minutes on a steady ride, and no highlight', () => {
    const shots = run(() => 150, 20 * 60);
    expect(shots.filter(([, k]) => k === 'scenic').map(([t]) => t)).toEqual([SCENIC_EVERY_S, 2 * SCENIC_EVERY_S, 3 * SCENIC_EVERY_S, 4 * SCENIC_EVERY_S, 5 * SCENIC_EVERY_S]);
    expect(shots.filter(([, k]) => k === 'highlight')).toHaveLength(0);
  });

  it('shoots the highlight during the hardest effort, not in the warm-up', () => {
    // a sprint in the warm-up, then a hard 3-minute effort at 12 min
    const shots = run((t) => (t > 60 && t < 90 ? 600 : t >= 720 && t < 900 ? 320 : 150), 20 * 60);
    const highlights = shots.filter(([, k]) => k === 'highlight').map(([t]) => t);
    expect(highlights.every((t) => t >= PHOTO_WARMUP_S)).toBe(true);
    const last = highlights[highlights.length - 1];
    expect(last).toBeGreaterThanOrEqual(730); // into the effort, not its first second
    expect(last).toBeLessThan(900);
  });

  it('catches a short sprint while it is still on', () => {
    const shots = run((t) => (t >= 600 && t < 615 ? 700 : 150), 15 * 60);
    expect(shots.filter(([, k]) => k === 'highlight').map(([t]) => t)).toEqual([610]);
  });

  it('skips frames when not pedalling', () => {
    expect(run(() => 0, 10 * 60)).toEqual([]);
  });

  it('ignores repeated ticks without a new sample', () => {
    const p = new PhotoPlanner();
    const samples = Array.from({ length: SCENIC_EVERY_S }, (_, i) => sample(i + 1, 150));
    expect(p.tick(samples)).toBe('scenic');
    expect(p.tick(samples)).toBeNull();
  });
});
