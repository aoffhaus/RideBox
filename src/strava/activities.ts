// Imports the rider's Strava activities so outdoor rides (and other training)
// count toward fitness and the coach can see them.

import { getFlag, listAll, putOne, setFlag } from '../storage/db';
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

export const listStravaActivities = () => listAll<StravaActivity>('strava_acts');
