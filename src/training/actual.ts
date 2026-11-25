// What was actually ridden: 1 Hz power/HR/cadence series from a RideBox ride or
// Strava streams, summary stats, and a per-interval comparison with the plan.

import type { RideRecord } from '../app/recorder';
import { normalizedPower } from '../app/recorder';
import { intervalFtpFraction, toWatts, type Interval } from '../workout/model';

/** One value per second of moving time. Missing readings are undefined. */
export interface ActualSeries {
  power?: number[];
  hr?: (number | undefined)[];
  cadence?: (number | undefined)[];
  /** target watts the trainer was holding (RideBox rides only) */
  target?: (number | undefined)[];
  length: number;
}

export function seriesFromRide(r: RideRecord): ActualSeries {
  const s = r.samples;
  const has = (k: 'hr' | 'cadence' | 'target') => s.some((x) => x[k] != null && x[k]! > 0);
  return {
    length: s.length,
    power: s.map((x) => x.power),
    hr: has('hr') ? s.map((x) => x.hr || undefined) : undefined,
    cadence: has('cadence') ? s.map((x) => x.cadence) : undefined,
    target: has('target') ? s.map((x) => x.target) : undefined,
  };
}

/** Strava's `streams?key_by_type=true` response (only the streams we ask for). */
export interface StravaStreams {
  time?: { data: number[] };
  watts?: { data: (number | null)[] };
  heartrate?: { data: (number | null)[] };
  cadence?: { data: (number | null)[] };
  moving?: { data: boolean[] };
}

/**
 * Resample Strava streams to 1 Hz on a moving clock: stopped samples are dropped
 * and pauses collapse, so the timeline lines up with a trainer workout's.
 */
export function seriesFromStreams(st: StravaStreams): ActualSeries {
  const time = st.time?.data ?? [];
  const moving = st.moving?.data;
  const power: number[] = [];
  const hr: (number | undefined)[] = [];
  const cad: (number | undefined)[] = [];
  let clock = 0;
  let prevT: number | undefined;
  for (let i = 0; i < time.length; i++) {
    if (moving && moving[i] === false) {
      prevT = undefined;
      continue;
    }
    // a gap of a few seconds (smart recording) is filled; longer gaps are pauses
    const dt = prevT === undefined ? 1 : time[i] - prevT;
    const fill = dt > 0 && dt <= 10 ? dt : 1;
    prevT = time[i];
    for (let k = 0; k < fill; k++) {
      power[clock] = st.watts?.data[i] ?? 0;
      hr[clock] = st.heartrate?.data[i] || undefined;
      cad[clock] = st.cadence?.data[i] ?? undefined;
      clock++;
    }
  }
  return {
    length: clock,
    power: st.watts ? power : undefined,
    hr: st.heartrate ? hr : undefined,
    cadence: st.cadence ? cad : undefined,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const present = (xs: (number | undefined)[] | undefined, from = 0, to = Infinity, positive = false) =>
  (xs ?? []).slice(from, to).filter((x): x is number => x != null && Number.isFinite(x) && (!positive || x > 0));

export interface ActualStats {
  duration: number;
  avgPower?: number;
  maxPower?: number;
  np?: number;
  if?: number;
  tss?: number;
  avgHr?: number;
  maxHr?: number;
  avgCadence?: number;
}

export function seriesStats(s: ActualSeries, ftp: number): ActualStats {
  const hr = present(s.hr);
  const out: ActualStats = { duration: s.length, avgHr: mean(hr), maxHr: hr.length ? Math.max(...hr) : undefined, avgCadence: mean(present(s.cadence, 0, Infinity, true)) };
  if (s.power?.length) {
    const np = normalizedPower(s.power);
    out.avgPower = mean(s.power);
    out.maxPower = Math.max(...s.power);
    out.np = np;
    if (ftp) {
      out.if = np / ftp;
      out.tss = ((s.length * np * out.if) / (ftp * 3600)) * 100;
    }
  }
  return out;
}

export interface IntervalComparison {
  index: number;
  label?: string;
  free: boolean;
  start: number;
  /** planned length (s) */
  duration: number;
  /** planned average watts (undefined for free ride) */
  targetW?: number;
  /** ramp: watts at start and end */
  rampW?: [number, number];
  /** seconds of actual data inside this interval (less than duration if the ride ended early) */
  actualDuration: number;
  avgPower?: number;
  avgHr?: number;
  maxHr?: number;
  avgCadence?: number;
  /** avg power / target */
  ratio?: number;
}

/** Seconds at the start of each interval ignored when scoring it (ramp-up to the new target). */
export const INTERVAL_SETTLE_SECONDS = 10;

/** Seconds to skip at the start of an interval of this length (none when it is too short to spare them). */
export function settleSkip(duration: number): number {
  return duration > INTERVAL_SETTLE_SECONDS * 2 ? INTERVAL_SETTLE_SECONDS : 0;
}

/** Line the actual series up with the planned intervals by elapsed time. */
export function comparePlan(intervals: Interval[], ftp: number, s: ActualSeries): IntervalComparison[] {
  return intervals.map((iv) => {
    const from = Math.round(iv.start);
    const to = Math.round(iv.start + iv.duration);
    const n = Math.max(0, Math.min(to, s.length) - from);
    const w0 = toWatts(iv.powerStart, iv.unit, ftp);
    const w1 = toWatts(iv.powerEnd, iv.unit, ftp);
    const targetW = iv.free ? undefined : intervalFtpFraction(iv, ftp) * ftp;
    // skip the settle window for scoring, unless the interval is too short to spare it
    const skip = settleSkip(iv.duration);
    const scoreFrom = from + skip;
    const hr = present(s.hr, scoreFrom, to);
    // the target over the scored window (a ramp's average shifts when its start is skipped)
    const scoredTargetW = iv.free ? undefined : w0 + (w1 - w0) * ((skip + iv.duration) / (2 * iv.duration));
    const avgPower = n && s.power && scoreFrom < Math.min(to, s.length) ? mean(s.power.slice(scoreFrom, to)) : undefined;
    return {
      index: iv.index,
      label: iv.label,
      free: iv.free,
      start: iv.start,
      duration: iv.duration,
      targetW,
      rampW: !iv.free && Math.round(w0) !== Math.round(w1) ? [w0, w1] : undefined,
      actualDuration: n,
      avgPower,
      avgHr: mean(hr),
      maxHr: hr.length ? Math.max(...present(s.hr, from, to)) : undefined,
      avgCadence: mean(present(s.cadence, scoreFrom, to, true)),
      ratio: avgPower != null && scoredTargetW ? avgPower / scoredTargetW : undefined,
    };
  });
}

/** How close an interval came to its target: 'hit' within ±5% (the first INTERVAL_SETTLE_SECONDS are ignored), 'over', 'under', or 'short' when it wasn't finished. */
export function verdict(c: IntervalComparison): 'hit' | 'over' | 'under' | 'short' | undefined {
  if (c.actualDuration < c.duration * 0.9) return 'short';
  if (c.ratio == null) return undefined;
  if (c.ratio > 1.05) return 'over';
  if (c.ratio < 0.95) return 'under';
  return 'hit';
}
