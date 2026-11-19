import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, qualityLevels } from '../src/world/adaptive';

const run = (q: AdaptiveQuality, fps: number, seconds: number) => {
  let changes = 0;
  for (let i = 0; i < fps * seconds; i++) if (q.frame(1 / fps)) changes++;
  return changes;
};

describe('qualityLevels', () => {
  it('starts at the display resolution (capped at 2x) and ends with AO off', () => {
    const l = qualityLevels('high', 2);
    expect(l[0]).toEqual({ pixelRatio: 2, ao: true });
    expect(l.map((x) => x.pixelRatio)).toEqual([2, 1.75, 1.5, 1.25, 1, 1, 0.75]);
    expect(l.at(-2)).toEqual({ pixelRatio: 1, ao: false });
  });
  it('low graphics has no AO and starts at 1x', () => {
    expect(qualityLevels('low', 2)).toEqual([
      { pixelRatio: 1, ao: false },
      { pixelRatio: 0.75, ao: false },
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
