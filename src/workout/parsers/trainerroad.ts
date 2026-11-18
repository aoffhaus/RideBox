import type { Step, Workout } from '../model';
import { mergeSteady } from './erg';

/**
 * Converts the workout JSON that trainerroad.com's own web app loads (saved by
 * the RideBox bookmarklet) into a RideBox workout.
 *
 * TrainerRoad's JSON isn't documented and may change, so this searches the
 * object generically for:
 *   - a name (WorkoutName / workoutName / Name / name)
 *   - a time series: an array of objects with a time key (seconds/Seconds/time/Time)
 *     and an FTP percent key (memberFtpPercent/ftpPercent/FtpPercent/...)
 * and turns the second-by-second series back into steady/ramp steps.
 */

type Json = any;

const TIME_KEYS = ['seconds', 'second', 'time', 'timeseconds', 't', 'offset'];
const PCT_KEYS = ['memberftppercent', 'ftppercent', 'ftp_percent', 'percentftp', 'targetftppercent', 'percent', 'power'];
const NAME_KEYS = ['workoutname', 'name', 'title', 'displayname'];
const DESC_KEYS = ['workoutdescription', 'description', 'goaldescription'];

function keyOf(obj: Json, candidates: string[]): string | undefined {
  const keys = Object.keys(obj);
  for (const c of candidates) {
    const k = keys.find((x) => x.toLowerCase() === c);
    if (k && typeof obj[k] === 'number') return k;
  }
  return undefined;
}

interface Series {
  t: number[];
  v: number[];
}

function findSeries(root: Json): Series | undefined {
  let best: Series | undefined;
  const seen = new Set<Json>();
  const visit = (o: Json, depth: number) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 8) return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length > 10 && typeof o[0] === 'object' && o[0]) {
        const tk = keyOf(o[0], TIME_KEYS);
        const pk = keyOf(o[0], PCT_KEYS);
        if (tk && pk) {
          const t = o.map((x: Json) => Number(x[tk]));
          const v = o.map((x: Json) => Number(x[pk]));
          if (!best || t.length > best.t.length) best = { t, v };
        }
      }
      o.forEach((x) => visit(x, depth + 1));
    } else {
      Object.values(o).forEach((x) => visit(x, depth + 1));
    }
  };
  visit(root, 0);
  return best;
}

function findString(root: Json, candidates: string[]): string | undefined {
  // breadth-first so top-level names win over nested interval names
  const queue: Json[] = [root];
  while (queue.length) {
    const o = queue.shift();
    if (!o || typeof o !== 'object') continue;
    if (!Array.isArray(o)) {
      for (const c of candidates) {
        const k = Object.keys(o).find((x) => x.toLowerCase() === c);
        if (k && typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
      }
      queue.push(...Object.values(o).filter((x) => x && typeof x === 'object' && !Array.isArray(x)));
    }
  }
  return undefined;
}

/** Rebuild steady/ramp steps from a uniformly sampled %FTP series. */
export function seriesToSteps(series: Series): Step[] {
  const n = series.t.length;
  if (n < 2) return [];
  const diffs = series.t.slice(1).map((x, i) => x - series.t[i]).sort((a, b) => a - b);
  let dt = diffs[Math.floor(diffs.length / 2)] || 1;
  let t = series.t;
  if (dt >= 500) {
    // milliseconds
    t = t.map((x) => x / 1000);
    dt /= 1000;
  }
  // Percent vs fraction
  const maxV = Math.max(...series.v);
  const v = maxV <= 3 ? series.v.map((x) => x * 100) : series.v;

  const steps: Step[] = [];
  const TOL = 0.6;
  let i = 0;
  while (i < n) {
    let j = i;
    const slope = i + 1 < n ? (v[i + 1] - v[i]) / (t[i + 1] - t[i] || dt) : 0;
    // A jump between neighbours means a new step starts at i+1
    const isJump = Math.abs(v[(i + 1) % n] - v[i]) > 3;
    const s = isJump ? 0 : slope;
    while (j + 1 < n && Math.abs(v[j + 1] - (v[i] + s * (t[j + 1] - t[i]))) < TOL) j++;
    const start = t[i];
    const end = j + 1 < n ? t[j + 1] : t[j] + dt;
    const duration = Math.round(end - start);
    if (duration > 0) {
      const from = v[i];
      const to = v[i] + s * (end - start);
      if (Math.abs(to - from) < 1) {
        steps.push({ type: 'steady', duration, power: Math.round(((from + to) / 2) * 10) / 1000 });
      } else {
        steps.push({ type: 'ramp', duration, from: Math.round(from * 10) / 1000, to: Math.round(to * 10) / 1000 });
      }
    }
    i = j + 1;
  }
  return mergeSteady(steps);
}

export function looksLikeTrainerRoad(j: Json): boolean {
  return !!findSeries(j);
}

export function parseTrainerRoadJson(src: string | Json): Workout {
  const j = typeof src === 'string' ? JSON.parse(src) : src;
  const series = findSeries(j);
  if (!series) throw new Error("Couldn't find TrainerRoad workout data in this file");
  const steps = seriesToSteps(series);
  if (!steps.length) throw new Error('TrainerRoad workout has no intervals');
  // Known shape (2024+): { Workout: { Details: { WorkoutName, WorkoutDescription, GoalDescription },
  //                                   WorkoutData: [{ Seconds: <ms>, FtpPercent }] } }
  const details = j?.Workout?.Details ?? j?.Details;
  const strip = (h?: string) => h?.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const desc = [strip(details?.WorkoutDescription), strip(details?.GoalDescription)].filter(Boolean).join('\n\n');
  return {
    name: (typeof details?.WorkoutName === 'string' && details.WorkoutName.trim()) || findString(j, NAME_KEYS) || 'TrainerRoad workout',
    description: desc || strip(findString(j, DESC_KEYS)),
    author: 'TrainerRoad',
    steps,
  };
}
