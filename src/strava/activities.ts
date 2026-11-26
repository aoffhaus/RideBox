// Imports the rider's Strava activities so outdoor rides (and other training)
// count toward fitness and the coach can see them.

import { getFlag, listAll, putOne, setFlag } from '../storage/db';
import type { StravaStreams } from '../training/actual';
import type { StravaActivity } from '../training/model';
import { describeError, stravaFetch } from './strava';

const CURSOR_KEY = 'strava-import-after';
/** How far back the first import reaches. */
const FIRST_IMPORT_DAYS = 180;

interface SummaryActivity {
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  start_date: string;
  moving_time: number;
  distance: number;
  total_elevation_gain?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  device_watts?: boolean;
  kilojoules?: number;
  average_heartrate?: number;
  average_cadence?: number;
  max_heartrate?: number;
  trainer?: boolean;
}

export function toActivity(a: SummaryActivity): StravaActivity {
  return {
    id: `strava-${a.id}`,
    stravaId: a.id,
    name: a.name,
    sportType: a.sport_type ?? a.type ?? 'Workout',
    start: Date.parse(a.start_date),
    movingTime: a.moving_time,
    distance: a.distance,
    climb: a.total_elevation_gain,
    avgWatts: a.average_watts,
    weightedWatts: a.weighted_average_watts,
    deviceWatts: a.device_watts,
    kj: a.kilojoules,
    avgHr: a.average_heartrate,
    avgCadence: a.average_cadence,
    maxHr: a.max_heartrate,
    trainer: a.trainer,
  };
}

/** Fetches activities newer than the last import. Returns how many were added or updated. */
export async function importStravaActivities(): Promise<number> {
  const stored = (await getFlag(CURSOR_KEY)) as number | undefined;
  // re-read the last 2 days each time: activities can be edited or arrive late
  const after = Math.floor((stored ? stored - 2 * 86_400_000 : Date.now() - FIRST_IMPORT_DAYS * 86_400_000) / 1000);
  let newest = stored ?? 0;
  let n = 0;
  for (let page = 1; page <= 20; page++) {
    const res = await stravaFetch(`athlete/activities?after=${after}&per_page=100&page=${page}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('Strava didn’t allow reading activities. Disconnect and connect Strava again in Settings to grant it.');
      throw new Error(`Strava activity import failed (${res.status}): ${describeError(json)}`);
    }
    const list = json as SummaryActivity[];
    for (const a of list) {
      const act = toActivity(a);
      await putOne('strava_acts', act);
      newest = Math.max(newest, act.start);
      n++;
    }
    if (list.length < 100) break;
  }
  if (newest) await setFlag(CURSOR_KEY, newest);
  return n;
}

const OLDEST_KEY = 'strava-import-oldest';

/**
 * Imports activities older than anything imported so far, back to the start of the
 * rider's Strava history (the regular import only reaches back 180 days), so all-time
 * best efforts see every ride. Returns how many were added.
 */
export async function importOlderStravaActivities(onProgress?: (n: number) => void): Promise<number> {
  const acts = await listAll<StravaActivity>('strava_acts');
  let before = Math.floor(((await getFlag(OLDEST_KEY)) as number | undefined ?? Math.min(Date.now(), ...acts.map((a) => a.start))) / 1000);
  let n = 0;
  for (;;) {
    const res = await stravaFetch(`athlete/activities?before=${before}&per_page=100`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('Strava didn’t allow reading activities. Disconnect and connect Strava again in Settings to grant it.');
      throw new Error(`Strava history import failed (${res.status}): ${res.status === 429 ? 'request limit reached, try again in 15 minutes' : describeError(json)}`);
    }
    const list = json as SummaryActivity[];
    for (const a of list) {
      const act = toActivity(a);
      await putOne('strava_acts', act);
      before = Math.min(before, Math.floor(act.start / 1000));
      n++;
    }
    onProgress?.(n);
    if (list.length < 100) {
      // reached the first activity: remember it so this never runs again
      await setFlag(OLDEST_KEY, 0);
      return n;
    }
    await setFlag(OLDEST_KEY, before * 1000);
  }
}

/** True once the whole Strava history has been imported. */
export const fullHistoryImported = async () => (await getFlag(OLDEST_KEY)) === 0;

export const listStravaActivities = () => listAll<StravaActivity>('strava_acts');

export class StravaHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Second-by-second power, heart rate, cadence and distance for one activity. Empty when Strava has none (manual entries). */
export async function fetchStreams(stravaId: number): Promise<StravaStreams> {
  const res = await stravaFetch(`activities/${stravaId}/streams?keys=time,watts,heartrate,cadence,moving,distance&key_by_type=true`);
  const json = await res.json().catch(() => ({}));
  if (res.status === 404) return {};
  if (!res.ok) {
    const msg = res.status === 429 ? 'Strava’s request limit was reached; try again in 15 minutes.' : describeError(json);
    throw new StravaHttpError(`Couldn’t load the activity from Strava (${res.status}): ${msg}`, res.status);
  }
  return json as StravaStreams;
}
