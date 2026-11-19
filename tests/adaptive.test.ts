import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, qualityLevels } from '../src/world/adaptive';

const run = (q: AdaptiveQuality, fps: number, seconds: number) => {
  let changes = 0;
  for (let i = 0; i < fps * seconds; i++) if (q.frame(1 / fps)) changes++;
  return changes;
};

describe('qualityLevels', () => {
  it('starts at full detail and display resolution (capped at 2x)', () => {
    const l = qualityLevels('high', 2);
    expect(l[0]).toEqual({ pixelRatio: 2, ao: true, aoLite: false, shadowMap: 1536, bloomScale: 1 });
  });
  it('gives up AO quality and shadow resolution before any pixels', () => {
    const l = qualityLevels('high', 2);
    expect(l.slice(0, 3).map((x) => [x.pixelRatio, x.aoLite, x.shadowMap])).toEqual([
      [2, false, 1536],
      [2, true, 1024],
      [2, true, 768],
    ]);
    expect(l.map((x) => x.pixelRatio)).toEqual([2, 2, 2, 1.75, 1.5, 1.25, 1, 1, 0.75]);
  });
  it('ends with AO off, then lower resolution and half-size bloom', () => {
    const l = qualityLevels('high', 2);
    expect(l.at(-2)).toMatchObject({ pixelRatio: 1, ao: false, bloomScale: 1 });
    expect(l.at(-1)).toMatchObject({ pixelRatio: 0.75, ao: false, bloomScale: 0.5 });
    // never gets better on the way down
    for (let k = 1; k < l.length; k++) {
      expect(l[k].pixelRatio).toBeLessThanOrEqual(l[k - 1].pixelRatio);
      expect(l[k].shadowMap).toBeLessThanOrEqual(l[k - 1].shadowMap);
    }
  });
  it('a 1x display still has the detail steps', () => {
    expect(qualityLevels('high', 1).map((x) => x.pixelRatio)).toEqual([1, 1, 1, 1, 0.75]);
  });
  it('low graphics has no AO and starts at 1x', () => {
    expect(qualityLevels('low', 2).map((x) => [x.pixelRatio, x.ao])).toEqual([
      [1, false],
      [0.75, false],
    ]);
  });
});

describe('AdaptiveQuality', () => {
  it('leaves quality alone at 60 fps', () => {
    const q = new AdaptiveQuality(qualityLevels('high', 2));
    expect(run(q, 60, 30)).toBe(0);
    expect(q.index).toBe(0);
    expect(Math.round(q.fps)).toBe(60);
  });

  it('steps down while choppy and stops once smooth', () => {
    const q = new AdaptiveQuality(qualityLevels('high', 2));
    run(q, 60, 4); // past warm-up
    run(q, 35, 3);
    expect(q.index).toBeGreaterThan(0);
    const after = q.index;
    run(q, 60, 5);
    expect(q.index).toBe(after);
  });

  it('ignores a single hitch and hidden-tab stalls', () => {
    const q = new AdaptiveQuality(qualityLevels('high', 2));
    run(q, 60, 5);
    q.frame(2); // tab was hidden
    run(q, 30, 1); // one slow second (e.g. a scenery rebuild)
    run(q, 60, 5);
    expect(q.index).toBe(0);
  });

  it('tries stepping back up after a long smooth stretch, but not straight into a level that failed', () => {
    const q = new AdaptiveQuality(qualityLevels('high', 2));
    run(q, 60, 4);
    run(q, 35, 3); // level 0 fails → 1
    expect(q.index).toBe(1);
    run(q, 60, 20); // smooth, but level 0 failed recently
    expect(q.index).toBe(1);
    run(q, 60, 60); // retry window passed
    expect(q.index).toBe(0);
  });
});
