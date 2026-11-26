// Strava activities' second-by-second data, downloaded once and kept in the synced
// `strava_streams` store so every browser shares it. On startup only the
// activities still missing are fetched, a limited number per session to stay
// inside Strava's request limits (100 per 15 minutes, 1000 per day).

import type { RideRecord } from '../app/recorder';
import { db, putOne } from '../storage/db';
import { seriesFromStreams, type ActualSeries } from '../training/actual';
import { EFFORTS_VERSION, effortsFromStreams, type RideEfforts } from '../training/efforts';
import { stravaCopyChecker } from '../training/load';
import { isRide, type StravaActivity } from '../training/model';
import { fetchStreams, StravaHttpError } from './activities';

export interface StoredStreams {
  id: string; // same as the activity: `strava-<id>`
  stravaId: number;
  fetchedAt: number;
  /** absent when Strava has no stream data for the activity */
  series?: ActualSeries;
  /** best power and distance efforts, worked out from the raw streams (absent on data saved before they existed) */
  efforts?: RideEfforts;
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
  const efforts = st.time && isRide(act.sportType) ? effortsFromStreams(st) : undefined;
  await putOne<StoredStreams>('strava_streams', { id: act.id, stravaId: act.stravaId, fetchedAt: Date.now(), series, efforts });
  cache.set(act.id, Promise.resolve(series ?? null));
  notify();
  return series ?? null;
}

/** Rides whose best efforts count: power from a power meter, or an outdoor ride (distance). */
export const holdsEfforts = (a: StravaActivity) => isRide(a.sportType) && (a.deviceWatts === true || isOutdoor(a));
export const isOutdoor = (a: StravaActivity) => isRide(a.sportType) && !a.trainer && !/virtual/i.test(a.sportType) && a.distance > 0;

const RECENT_MS = 30 * 86_400_000;

/**
 * Activities worth downloading: not Strava's copy of a RideBox ride (that one has its own data).
 * The last 30 days come first (calendar cards), then older rides with best efforts, then the rest; newest first in each.
 */
export function streamCandidates(acts: StravaActivity[], rides: RideRecord[], have: Set<string>, now = Date.now()) {
  const isCopy = stravaCopyChecker(rides);
  const rank = (a: StravaActivity) => (a.start > now - RECENT_MS ? 0 : holdsEfforts(a) ? 1 : 2);
  return acts.filter((a) => !have.has(a.id) && !isCopy(a)).sort((a, b) => rank(a) - rank(b) || b.start - a.start);
}

/** Saved streams whose best efforts are missing or out of date (downloaded again to work them out). */
export function staleEfforts(acts: StravaActivity[], rides: RideRecord[], stored: Map<string, number | undefined>) {
  const isCopy = stravaCopyChecker(rides);
  return acts.filter((a) => stored.has(a.id) && stored.get(a.id) !== EFFORTS_VERSION && holdsEfforts(a) && !isCopy(a)).sort((a, b) => b.start - a.start);
}

/** Every saved record's efforts version (undefined for none), keyed by activity id; records with no data are left out. */
async function storedVersions(): Promise<Map<string, number | undefined>> {
  const out = new Map<string, number | undefined>();
  const d = await db();
  let cur = await d.transaction('strava_streams').store.openCursor();
  while (cur) {
    const r = cur.value as StoredStreams;
    if (r.series) out.set(r.id, r.efforts?.v);
    cur = await cur.continue();
  }
  return out;
}

/** One activity's saved best efforts (undefined when missing). */
export async function storedEffortsFor(id: string): Promise<RideEfforts | undefined> {
  const r = (await (await db()).get('strava_streams', id)) as StoredStreams | undefined;
  return r?.efforts;
}

/** Every saved record's best efforts (for the power curve and records). */
export async function storedEfforts(): Promise<Map<string, RideEfforts>> {
  const out = new Map<string, RideEfforts>();
  for (const r of (await (await db()).getAll('strava_streams')) as StoredStreams[]) if (r.efforts) out.set(r.id, r.efforts);
  return out;
}

let running: Promise<number> | null = null;

/**
 * Fetch streams for activities that don't have them yet, then again for rides saved
 * before best efforts were worked out. Returns how many were downloaded.
 */
export function syncMissingStreams(acts: StravaActivity[], rides: RideRecord[], max = 60): Promise<number> {
  running ??= (async () => {
    try {
      const have = new Set((await (await db()).getAllKeys('strava_streams')) as string[]);
      const todo = [...streamCandidates(acts, rides, have), ...staleEfforts(acts, rides, await storedVersions())];
      let n = 0;
      for (const a of todo.slice(0, max)) {
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

/** How many rides still need their streams downloaded for best efforts. */
export async function pendingEfforts(acts: StravaActivity[], rides: RideRecord[]): Promise<number> {
  const stored = await storedVersions();
  const have = new Set((await (await db()).getAllKeys('strava_streams')) as string[]);
  return streamCandidates(acts, rides, have).filter(holdsEfforts).length + staleEfforts(acts, rides, stored).length;
}
