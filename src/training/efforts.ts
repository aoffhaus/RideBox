// Best efforts, worked out the way Strava does:
// - Power: the best average over each duration on an elapsed-time clock. Seconds
//   with no sample (paused, stopped, dropouts) count as 0 W, and the average is
//   rounded down to a whole watt.
// - Distance (outdoor rides only): the shortest elapsed time between two GPS
//   samples at least that far apart.
// Checked against Strava's own best efforts for real rides (see tests/efforts.test.ts).
//
// Nothing here touches IndexedDB or the DOM.

import type { StravaStreams } from './actual';

/** Bump when the computation changes: stored efforts with an older version are recomputed. */
export const EFFORTS_VERSION = 1;

/** Durations (s) the power curve is sampled at: dense where the curve bends, sparser later. */
export const CURVE_DURATIONS: number[] = (() => {
  const out: number[] = [];
  const add = (from: number, to: number, step: number) => {
    for (let d = from; d <= to; d += step) if (out[out.length - 1] !== d) out.push(d);
  };
  add(1, 30, 1);
  add(30, 120, 5);
  add(120, 600, 15);
  add(600, 3600, 60);
  add(3600, 4 * 3600, 300);
  add(4 * 3600, 12 * 3600, 900);
  add(12 * 3600, 24 * 3600, 3600);
  return out;
})();
const DUR_INDEX = new Map(CURVE_DURATIONS.map((d, i) => [d, i]));
export const durationIndex = (d: number) => DUR_INDEX.get(d) ?? -1;

/** Strava's power best efforts. */
export const POWER_RECORDS: { s: number; label: string }[] = [
  { s: 5, label: '5 sec' },
  { s: 15, label: '15 sec' },
  { s: 30, label: '30 sec' },
  { s: 60, label: '1 min' },
  { s: 120, label: '2 min' },
  { s: 180, label: '3 min' },
  { s: 300, label: '5 min' },
  { s: 480, label: '8 min' },
  { s: 600, label: '10 min' },
  { s: 900, label: '15 min' },
  { s: 1200, label: '20 min' },
  { s: 1800, label: '30 min' },
  { s: 2700, label: '45 min' },
  { s: 3600, label: '1 hr' },
];

const MI = 1609.344;
/** Strava's cycling distance best efforts. */
export const DISTANCE_RECORDS: { m: number; label: string }[] = [
  { m: 5 * MI, label: '5 mi' },
  { m: 10_000, label: '10K' },
  // Strava's 10 mile is 16.09 km (matches its times; the exact 16,093 m comes out a second slower)
  { m: 16_090, label: '10 mi' },
  { m: 20_000, label: '20K' },
  { m: 30_000, label: '30K' },
  { m: 40_000, label: '40K' },
  { m: 50_000, label: '50K' },
  { m: 50 * MI, label: '50 mi' },
  { m: 80_000, label: '80K' },
  { m: 90_000, label: '90K' },
  { m: 100_000, label: '100K' },
  { m: 100 * MI, label: '100 mi' },
  { m: 180_000, label: '180K' },
];

/** Best power per CURVE_DURATIONS entry (up to the ride's length) and where it started. */
export interface PowerCurve {
  /** watts, rounded down */
  w: number[];
  /** start of the best window, in seconds of the ride's moving clock (the timeline its charts use) */
  s: number[];
}

/** Fastest time per DISTANCE_RECORDS entry (up to the ride's distance). */
export interface DistanceEfforts {
  /** elapsed seconds */
  t: number[];
  /** start, in seconds of the moving clock */
  s: number[];
}

export interface RideEfforts {
  v: number;
  power?: PowerCurve;
  dist?: DistanceEfforts;
}

/**
 * Best average power for each curve duration. `clock` maps an index of `power`
 * to the time shown on the ride's charts (identity for a RideBox ride).
 */
export function powerCurve(power: ArrayLike<number>, clock: (i: number) => number = (i) => i): PowerCurve | undefined {
  const n = power.length;
  if (!n) return undefined;
  // prefix sums keep every window O(1)
  const sum = new Float64Array(n + 1);
  let any = false;
  for (let i = 0; i < n; i++) {
    const p = power[i];
    const v = p > 0 && Number.isFinite(p) ? p : 0;
    if (v) any = true;
    sum[i + 1] = sum[i] + v;
  }
  if (!any) return undefined;
  const w: number[] = [];
  const s: number[] = [];
  for (const d of CURVE_DURATIONS) {
    if (d > n) break;
    let best = -1;
    let at = 0;
    for (let i = 0; i + d <= n; i++) {
      const x = sum[i + d] - sum[i];
      if (x > best) {
        best = x;
        at = i;
      }
    }
    // 1e-9 guards against float error turning e.g. 305.0000 into 304
    w.push(Math.floor(best / d + 1e-9));
    s.push(Math.round(clock(at)));
  }
  return { w, s };
}

/**
 * Fastest elapsed time over each record distance. `time` is elapsed seconds and
 * `dist` cumulative metres, one entry per sample.
 */
export function distanceEfforts(time: ArrayLike<number>, dist: ArrayLike<number | null>, clock: (i: number) => number = (i) => time[i]): DistanceEfforts | undefined {
  const n = Math.min(time.length, dist.length);
  if (n < 2) return undefined;
  // carry a missing reading forward so the series never goes backwards
  const d = new Float64Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const v = dist[i];
    last = v != null && Number.isFinite(v) && v >= last ? v : last;
    d[i] = last;
  }
  const t: number[] = [];
  const s: number[] = [];
  for (const { m } of DISTANCE_RECORDS) {
    if (d[n - 1] - d[0] < m) break;
    let best = Infinity;
    let at = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j < n && d[j] - d[i] < m) j++;
      if (j >= n) break;
      const dt = time[j] - time[i];
      if (dt < best) {
        best = dt;
        at = i;
      }
    }
    if (!Number.isFinite(best)) break;
    t.push(best);
    s.push(Math.round(clock(at)));
  }
  return t.length ? { t, s } : undefined;
}

/**
 * The moving-clock second (as seriesFromStreams lays a ride out) of each raw
 * sample: stopped samples and long pauses don't advance it.
 */
export function movingClock(st: StravaStreams): number[] {
  const time = st.time?.data ?? [];
  const moving = st.moving?.data;
  const out: number[] = [];
  let clock = 0;
  let prevT: number | undefined;
  for (let i = 0; i < time.length; i++) {
    out.push(clock);
    if (moving && moving[i] === false) {
      prevT = undefined;
      continue;
    }
    const dt = prevT === undefined ? 1 : time[i] - prevT;
    clock += dt > 0 && dt <= 10 ? dt : 1;
    prevT = time[i];
  }
  return out;
}

/** Best efforts from Strava's raw streams (time, watts, distance, moving). */
export function effortsFromStreams(st: StravaStreams): RideEfforts {
  const time = st.time?.data ?? [];
  const out: RideEfforts = { v: EFFORTS_VERSION };
  if (time.length < 2) return out;
  const mov = movingClock(st);
  const t0 = time[0];
  if (st.watts) {
    // elapsed-time grid; seconds without a sample stay 0 W
    const len = time[time.length - 1] - t0 + 1;
    const grid = new Float64Array(len);
    const clockAt = new Float64Array(len);
    for (let i = 0; i < time.length; i++) {
      const k = time[i] - t0;
      grid[k] = st.watts.data[i] ?? 0;
    }
    // moving clock for every elapsed second (the last sample at or before it)
    for (let k = 0, i = 0; k < len; k++) {
      while (i + 1 < time.length && time[i + 1] - t0 <= k) i++;
      clockAt[k] = mov[i];
    }
    out.power = powerCurve(grid, (k) => clockAt[k]);
  }
  if (st.distance) out.dist = distanceEfforts(time, st.distance.data, (i) => mov[i]);
  return out;
}

/** Power-only efforts from a 1 Hz moving-clock series (RideBox rides, or Strava data saved before efforts existed). */
export function effortsFromPower(power: number[] | undefined): RideEfforts {
  return { v: EFFORTS_VERSION, power: power ? powerCurve(power) : undefined };
}

// ---------- across rides ----------

/** A ride that can hold best efforts. */
export interface EffortSource {
  id: string;
  kind: 'ridebox' | 'strava';
  name: string;
  /** ms since epoch */
  start: number;
  /** outdoor ride: counts for distance records */
  outdoor: boolean;
  stravaId?: number;
  efforts: RideEfforts;
}

export interface CurvePoint {
  d: number;
  w: number;
  src: EffortSource;
  /** start inside the ride (moving clock, s) */
  at: number;
}

/** The best power at every curve duration over these rides. */
export function bestCurve(sources: EffortSource[]): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (const src of sources) {
    const c = src.efforts.power;
    if (!c) continue;
    for (let i = 0; i < c.w.length; i++) {
      const cur = out[i];
      // ties go to the earlier ride (Strava keeps the first time a record was set)
      if (!cur || c.w[i] > cur.w || (c.w[i] === cur.w && src.start < cur.src.start)) out[i] = { d: CURVE_DURATIONS[i], w: c.w[i], src, at: c.s[i] };
    }
  }
  // a gap can only appear if a shorter ride sits between longer ones; there isn't one, but be safe
  return out.filter(Boolean);
}

export interface PowerRecord {
  w: number;
  src: EffortSource;
  at: number;
}

/** The top `k` rides (one entry per ride) for a duration. */
export function topPower(sources: EffortSource[], seconds: number, k = 3): PowerRecord[] {
  const i = durationIndex(seconds);
  if (i < 0) return [];
  const list: PowerRecord[] = [];
  for (const src of sources) {
    const c = src.efforts.power;
    if (c && c.w.length > i && c.w[i] > 0) list.push({ w: c.w[i], src, at: c.s[i] });
  }
  return list.sort((a, b) => b.w - a.w || a.src.start - b.src.start).slice(0, k);
}

export interface DistanceRecord {
  t: number;
  src: EffortSource;
  at: number;
}

/** The `k` fastest outdoor rides (one entry per ride) over a record distance. */
export function topDistance(sources: EffortSource[], index: number, k = 3): DistanceRecord[] {
  const list: DistanceRecord[] = [];
  for (const src of sources) {
    const e = src.efforts.dist;
    if (src.outdoor && e && e.t.length > index) list.push({ t: e.t[index], src, at: e.s[index] });
  }
  return list.sort((a, b) => a.t - b.t || a.src.start - b.src.start).slice(0, k);
}

/** Sources that started inside [from, to] (ms, inclusive). */
export const inRange = (sources: EffortSource[], from: number, to: number) => sources.filter((s) => s.start >= from && s.start <= to);

/** "5s", "1:30", "20:00", "1:05:00" style labels for a duration. */
export function durationLabel(s: number): string {
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return sec ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : m ? `${h}h ${m}m` : `${h}h`;
  return sec ? `${m}:${String(sec).padStart(2, '0')}` : `${m} min`;
}
