// Strava activities' second-by-second data, downloaded once and kept in the synced
// `strava_streams` store so every browser shares it. On startup only the
// activities still missing are fetched, a limited number per session to stay
// inside Strava's request limits (100 per 15 minutes, 1000 per day).

import type { RideRecord } from '../app/recorder';
import { db, putOne } from '../storage/db';
import { seriesFromStreams, type ActualSeries } from '../training/actual';
import { stravaCopyChecker } from '../training/load';
import type { StravaActivity } from '../training/model';
import { fetchStreams, StravaHttpError } from './activities';

export interface StoredStreams {
  id: string; // same as the activity: `strava-<id>`
  stravaId: number;
  fetchedAt: number;
  /** absent when Strava has no stream data for the activity */
  series?: ActualSeries;
}

const cache = new Map<string, Promise<ActualSeries | null | undefined>>();
const listeners = new Set<() => void>();
export function onStreamsChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const notify = () => listeners.forEach((l) => l());

/** Forget what's cached in memory (another browser may have synced new data). */
export function invalidateStreams() {
  cache.clear();
  notify();
}

const round = (a?: (number | null | undefined)[]) => a?.map((v) => (v == null ? null : Math.round(v))) as number[] | undefined;

/** Stored series for an activity: the series, null if Strava has none, undefined if not downloaded yet. */
export function storedSeries(id: string): Promise<ActualSeries | null | undefined> {
  let p = cache.get(id);
  if (!p) {
    p = db()
      .then((d) => d.get('strava_streams', id) as Promise<StoredStreams | undefined>)
      .then((s) => (s ? s.series ?? null : undefined));
    cache.set(id, p);
  }
  return p;
}

/** Download one activity's streams from Strava and save them. */
export async function downloadSeries(act: StravaActivity): Promise<ActualSeries | null> {
  const st = await fetchStreams(act.stravaId);
  const s = st.time ? seriesFromStreams(st) : undefined;
  const series = s && { length: s.length, power: round(s.power), hr: round(s.hr), cadence: round(s.cadence) };
  await putOne<StoredStreams>('strava_streams', { id: act.id, stravaId: act.stravaId, fetchedAt: Date.now(), series });
  cache.set(act.id, Promise.resolve(series ?? null));
  notify();
  return series ?? null;
}

/** Activities worth downloading: not Strava's copy of a RideBox ride (that one has its own data). */
export function streamCandidates(acts: StravaActivity[], rides: RideRecord[], have: Set<string>) {
  const isCopy = stravaCopyChecker(rides);
  return acts.filter((a) => !have.has(a.id) && !isCopy(a)).sort((a, b) => b.start - a.start);
}

let running: Promise<number> | null = null;

/** Fetch streams for activities that don't have them yet, newest first. Returns how many were downloaded. */
export function syncMissingStreams(acts: StravaActivity[], rides: RideRecord[], max = 60): Promise<number> {
  running ??= (async () => {
    try {
      const have = new Set((await (await db()).getAllKeys('strava_streams')) as string[]);
      let n = 0;
      for (const a of streamCandidates(acts, rides, have).slice(0, max)) {
        try {
          await downloadSeries(a);
          n++;
        } catch (e) {
          // over the limit or signed out: stop and pick up next time
          if (!(e instanceof StravaHttpError) || e.status === 429 || e.status === 401 || e.status === 403) break;
        }
      }
      return n;
    } finally {
      running = null;
    }
  })();
  return running;
}
