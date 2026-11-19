import type { Sample } from '../app/recorder';

/**
 * Which slice of the interval list to show around the current interval:
 * up to `before` completed ones, the current one, and up to `after` upcoming.
 * When the workout is finished (`current >= count`) only the last completed
 * intervals are shown. `to` is exclusive.
 */
export function intervalWindow(count: number, current: number, before = 2, after = 5): { from: number; to: number } {
  if (count <= 0) return { from: 0, to: 0 };
  const cur = Math.max(0, Math.min(current, count));
  const from = Math.max(0, cur - before);
  const to = Math.min(count, cur + 1 + after);
  return { from, to };
}

/**
 * Average recorded power over [start, end) seconds of ride time.
 * Samples are 1 Hz and sorted by `elapsed`. Returns undefined if none fall
 * inside the window.
 */
export function avgPowerBetween(samples: readonly Sample[], start: number, end: number): number | undefined {
  // binary search for the first sample with elapsed >= start
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].elapsed < start) lo = mid + 1;
    else hi = mid;
  }
  let sum = 0;
  let n = 0;
  for (let i = lo; i < samples.length && samples[i].elapsed < end; i++) {
    sum += samples[i].power;
    n++;
  }
  return n ? sum / n : undefined;
}
