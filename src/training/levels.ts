// Progression levels: how hard a workout is within its training zone (1–10),
// and how far the rider has progressed in each zone.
//
// Athlete levels aren't stored. They are replayed from ride history every time,
// so they're always consistent with the rides (and sync for free):
//   - finishing a workout at or above your level raises the level to it (+0.2),
//   - failing one at or below your level lowers it a little,
//   - a zone you haven't trained in for 4+ weeks slowly decays.

import type { RideRecord } from '../app/recorder';
import { flatten, intervalFtpFraction, plannedStats, type Workout } from '../workout/model';
import { dayKey } from './load';
import type { PlannedWorkout, StravaActivity } from './model';
import { isRide } from './model';

export const LEVEL_ZONES = ['endurance', 'tempo', 'sweetspot', 'threshold', 'vo2max', 'anaerobic'] as const;
export type LevelZone = (typeof LEVEL_ZONES)[number];
/** null = no workout in that zone yet, so the level is unknown */
export type Levels = Record<LevelZone, number | null>;

export const ZONE_NAMES: Record<LevelZone | 'recovery' | 'test', string> = {
  recovery: 'Recovery',
  test: 'Test',
  endurance: 'Endurance',
  tempo: 'Tempo',
  sweetspot: 'Sweet Spot',
  threshold: 'Threshold',
  vo2max: 'VO2max',
  anaerobic: 'Anaerobic',
};

/** Upper bound (fraction of FTP) of each zone. */
const BOUNDS: [LevelZone | 'recovery', number][] = [
  ['recovery', 0.56],
  ['endurance', 0.76],
  ['tempo', 0.88],
  ['sweetspot', 0.95],
  ['threshold', 1.06],
  ['vo2max', 1.21],
  ['anaerobic', Infinity],
];
export const zoneOfFraction = (f: number) => BOUNDS.find(([, max]) => f < max)![0];

export const startLevels = (): Levels => ({ endurance: null, tempo: null, sweetspot: null, threshold: null, vo2max: null, anaerobic: null });

export interface WorkoutRating {
  zone: LevelZone | 'recovery' | 'test';
  level: number; // 1.0 – 10.0
}

const clamp = (v: number) => Math.round(Math.min(10, Math.max(1, v)) * 10) / 10;

interface Block {
  duration: number; // s
  frac: number; // time-weighted average intensity
  zone: LevelZone | 'recovery';
}

/**
 * Back-to-back work intervals (≥ 76% FTP, no recovery between) merge into one
 * block, so over-unders read as one threshold effort. Many short blocks above
 * threshold but below 150% (30/30s, 40/20s) are VO2max work.
 */
export function workBlocks(w: Workout, ftp: number): Block[] {
  const blocks: Block[] = [];
  let cur: { d: number; fw: number } | null = null;
  const flush = () => {
    if (cur) blocks.push({ duration: cur.d, frac: cur.fw / cur.d, zone: zoneOfFraction(cur.fw / cur.d) });
    cur = null;
  };
  for (const iv of flatten(w)) {
    if (iv.free || iv.duration <= 0) continue;
    const f = intervalFtpFraction(iv, ftp);
    if (f >= 0.76) {
      cur ??= { d: 0, fw: 0 };
      cur.d += iv.duration;
      cur.fw += f * iv.duration;
    } else {
      flush();
      blocks.push({ duration: iv.duration, frac: f, zone: zoneOfFraction(f) });
    }
  }
  flush();
  const micro = blocks.filter((b) => b.duration < 60 && b.frac >= 1.06 && b.frac < 1.5);
  if (micro.length >= 6) for (const b of micro) b.zone = 'vo2max';
  return blocks;
}

const isTest = (w: Workout) => /\b(ramp test|ftp test|assessment|time trial test)\b/i.test(w.name);

/** Which zone a workout trains (by NP-weighted time in zone) and how hard it is within it. */
export function rateWorkout(w: Workout, ftp: number): WorkoutRating {
  if (isTest(w)) return { zone: 'test', level: 1 };
  const blocks = workBlocks(w, ftp);
  const weight = new Map<LevelZone, number>();
  for (const b of blocks) {
    if (b.zone === 'recovery') continue;
    // short hard efforts matter more than their minutes suggest
    const boost = b.zone === 'anaerobic' ? 4 : b.zone === 'vo2max' ? 2.5 : b.zone === 'threshold' ? 1.5 : b.zone === 'sweetspot' ? 1.3 : 1;
    weight.set(b.zone, (weight.get(b.zone) ?? 0) + b.duration * Math.pow(b.frac, 4) * boost);
  }
  let zone: LevelZone | undefined;
  let best = 0;
  for (const [z, v] of weight) {
    if (v > best) {
      best = v;
      zone = z;
    }
  }
  if (!zone) return { zone: 'recovery', level: 1 };
  const inZone = blocks.filter((b) => b.zone === zone);
  // for endurance, everything at or above endurance pace counts (tempo bits make it harder, not different)
  const counted = zone === 'endurance' ? blocks.filter((b) => b.frac >= 0.56) : inZone;
  const secs = counted.reduce((a, b) => a + b.duration, 0);
  const tiz = secs / 60;
  const longest = Math.max(...inZone.map((b) => b.duration)) / 60;
  const avg = counted.reduce((a, b) => a + b.frac * b.duration, 0) / Math.max(1, secs);
  const total = plannedStats(flatten(w), ftp).duration / 60;
  let level: number;
  switch (zone) {
    case 'endurance':
      level = 1 + (total - 45) / 22 + (avg - 0.65) * 10;
      break;
    case 'tempo':
      level = tiz / 12 + longest / 30 + (avg - 0.82) * 15;
      break;
    case 'sweetspot':
      level = tiz / 9 + longest / 30 + (avg - 0.91) * 20;
      break;
    case 'threshold':
      level = tiz / 7 + longest / 25 + (avg - 1.0) * 25;
      break;
    case 'vo2max':
      level = tiz / 4 + longest / 3 + (avg - 1.15) * 20;
      break;
    case 'anaerobic':
      level = tiz / 1.2 + longest * 2 + (avg - 1.4) * 10;
      break;
  }
  return { zone, level: clamp(level) };
}

export type Outcome = 'pass' | 'struggle' | 'fail';

/**
 * How a ride went against its workout: the share of target power held on the
 * work intervals (laps whose target is ≥ 75% FTP) and how much of the workout
 * was ridden.
 */
export function rideOutcome(ride: RideRecord, plannedSeconds: number): { outcome: Outcome; compliance: number; coverage: number } {
  let work = 0;
  let held = 0;
  for (const lap of ride.laps) {
    if (!lap.target || lap.target < 0.75 * ride.ftp) continue;
    const s = ride.samples.slice(lap.startIndex, lap.endIndex);
    if (!s.length) continue;
    const avg = s.reduce((a, x) => a + x.power, 0) / s.length;
    work += s.length;
    held += s.length * Math.min(1.05, avg / lap.target);
  }
  const compliance = work ? held / work : 1;
  const coverage = plannedSeconds ? Math.min(1, ride.samples.length / plannedSeconds) : 1;
  const score = Math.min(compliance, coverage + 0.02);
  // how it felt counts too: "all out" on a workout that only just passed is a struggle
  const feel = ride.feel ?? 3;
  const outcome: Outcome = score >= 0.95 ? (feel >= 5 && score < 0.98 ? 'struggle' : 'pass') : score >= 0.85 ? 'struggle' : 'fail';
  return { outcome, compliance, coverage };
}

export function applyOutcome(levels: Levels, r: WorkoutRating, outcome: Outcome, feel = 3): Levels {
  if (r.zone === 'recovery' || r.zone === 'test') return levels;
  const L = levels[r.zone];
  // first workout in a zone sets the starting point
  if (L == null) {
    const first = outcome === 'pass' ? r.level : outcome === 'struggle' ? r.level - 0.5 : r.level - 1;
    return { ...levels, [r.zone]: clamp(first) };
  }
  let next = L;
  if (outcome === 'pass') {
    if (r.level >= L - 0.5) next = Math.max(L, r.level) + 0.2 + (feel <= 2 ? 0.3 : 0);
  } else if (outcome === 'fail') {
    if (r.level <= L + 0.5) next = L - 0.3;
  }
  return { ...levels, [r.zone]: clamp(next) };
}

/**
 * Untrained zones lose 0.1 per week after 4 weeks. `trained` holds each zone's
 * level as of the last workout in it, so decay is always measured from that
 * level, never from an already-decayed one.
 */
function decay(trained: Levels, lastTrained: Partial<Record<LevelZone, number>>, now: number): Levels {
  const out = { ...trained };
  for (const z of LEVEL_ZONES) {
    const last = lastTrained[z];
    const L = trained[z];
    if (last == null || L == null) continue;
    const weeks = (now - last) / (7 * 86_400_000) - 4;
    if (weeks > 0) out[z] = clamp(L - 0.1 * Math.floor(weeks));
  }
  return out;
}

export interface LevelEvent {
  date: string;
  name: string;
  zone: LevelZone;
  workoutLevel: number;
  outcome: Outcome;
  before: number | null;
  after: number;
}

/**
 * Replays every ride (oldest first) to get today's levels. A ride's workout is
 * the calendar workout it completed, or a library workout with the same name.
 * Long, steady outdoor rides from Strava count as endurance work.
 */
export function computeLevels(
  rides: RideRecord[],
  acts: StravaActivity[],
  calendar: PlannedWorkout[],
  library: Workout[],
  ftp: number,
  now = Date.now(),
): { levels: Levels; history: LevelEvent[] } {
  const byRide = new Map(calendar.filter((p) => p.rideId).map((p) => [p.rideId!, p.workout]));
  const byName = new Map(library.map((w) => [w.name, w]));
  type Ev = { t: number; name: string; rating: WorkoutRating; outcome: Outcome; feel?: number };
  const evs: Ev[] = [];
  for (const r of rides) {
    const w = byRide.get(r.id) ?? (r.workoutName ? byName.get(r.workoutName) : undefined);
    if (!w) continue;
    const rideFtp = r.ftp || ftp;
    const rating = rateWorkout(w, rideFtp);
    const { outcome } = rideOutcome(r, plannedStats(flatten(w), rideFtp).duration);
    evs.push({ t: r.startTime, name: r.name, rating, outcome, feel: r.feel });
  }
  const uploaded = new Set(rides.map((r) => r.strava?.activityId).filter(Boolean));
  for (const a of acts) {
    if (!isRide(a.sportType) || uploaded.has(a.stravaId) || a.movingTime < 75 * 60) continue;
    const np = a.weightedWatts && a.deviceWatts ? a.weightedWatts : undefined;
    if (!np || np / ftp >= 0.78) continue;
    const minutes = a.movingTime / 60;
    evs.push({ t: a.start, name: a.name, rating: { zone: 'endurance', level: clamp(1 + (minutes - 45) / 22) }, outcome: 'pass' });
  }
  evs.sort((x, y) => x.t - y.t);
  // each zone's level as of its last workout (undecayed)
  let trained = startLevels();
  const last: Partial<Record<LevelZone, number>> = {};
  const history: LevelEvent[] = [];
  for (const e of evs) {
    if (e.rating.zone === 'recovery' || e.rating.zone === 'test') continue;
    const z = e.rating.zone;
    const current = decay(trained, last, e.t);
    const before = current[z];
    const after = applyOutcome(current, e.rating, e.outcome, e.feel)[z]!;
    trained = { ...trained, [z]: after };
    last[z] = e.t;
    history.push({ date: dayKey(e.t), name: e.name, zone: z, workoutLevel: e.rating.level, outcome: e.outcome, before, after });
  }
  return { levels: decay(trained, last, now), history };
}

/** How a workout compares with the rider's current level in its zone. */
export function difficultyLabel(r: WorkoutRating, levels: Levels): { label: string; cls: string } {
  if (r.zone === 'recovery') return { label: 'Recovery', cls: 'diff-easy' };
  if (r.zone === 'test') return { label: 'Test', cls: 'diff-test' };
  const L = levels[r.zone];
  if (L == null) return { label: 'Not rated yet', cls: 'diff-unknown' };
  const d = r.level - L;
  if (d <= -1) return { label: 'Easy', cls: 'diff-easy' };
  if (d <= 0.5) return { label: 'Productive', cls: 'diff-productive' };
  if (d <= 1.5) return { label: 'Challenging', cls: 'diff-challenging' };
  return { label: 'Very hard', cls: 'diff-hard' };
}
