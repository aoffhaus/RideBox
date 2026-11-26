// Every ride's best efforts in one list, for the power curve and the records:
// RideBox rides (worked out from their samples) and Strava rides (saved with
// their streams). Strava's copies of RideBox rides are left out so a ride never
// counts twice, and Strava's estimated power (no power meter) never counts.

import { useEffect, useMemo, useState } from 'react';
import type { RideRecord } from './recorder';
import { listAll, listRides } from '../storage/db';
import { isOutdoor, onStreamsChange, storedEfforts, storedEffortsFor, storedSeries } from '../strava/streams';
import type { ActualSeries } from '../training/actual';
import { effortsFromPower, EFFORTS_VERSION, type EffortSource, type PowerCurve, type RideEfforts } from '../training/efforts';
import { stravaCopyChecker } from '../training/load';
import { isRide, type StravaActivity } from '../training/model';

// a RideBox ride's samples never change, so its efforts are worked out once
const rideCache = new Map<string, { n: number; e: RideEfforts }>();
export function rideEfforts(r: RideRecord): RideEfforts {
  const hit = rideCache.get(r.id);
  if (hit && hit.n === r.samples.length) return hit.e;
  const e = effortsFromPower(r.samples.map((s) => s.power));
  rideCache.set(r.id, { n: r.samples.length, e });
  return e;
}

// Strava data saved before efforts existed: power from the saved 1 Hz series until it is downloaded again
const fallbackCache = new Map<string, RideEfforts>();
async function fallbackEfforts(id: string): Promise<RideEfforts | undefined> {
  if (fallbackCache.has(id)) return fallbackCache.get(id);
  const s = await storedSeries(id);
  const e = s?.power ? effortsFromPower(s.power) : undefined;
  if (e) fallbackCache.set(id, e);
  return e;
}

/** A Strava activity's efforts, keeping only what counts (power-meter watts; distance outdoors). */
function stravaSource(a: StravaActivity, e: RideEfforts): EffortSource {
  const outdoor = isOutdoor(a);
  return {
    id: a.id,
    kind: 'strava',
    name: a.name,
    start: a.start,
    outdoor,
    stravaId: a.stravaId,
    // Strava sets device_watts false for its own estimate; older imports may not say, so only `false` is excluded
    efforts: { v: e.v, power: a.deviceWatts === false ? undefined : e.power, dist: outdoor ? e.dist : undefined },
  };
}

export async function buildSources(rides: RideRecord[], acts: StravaActivity[]): Promise<EffortSource[]> {
  const out: EffortSource[] = [];
  for (const r of rides) {
    const e = rideEfforts(r);
    if (e.power) out.push({ id: r.id, kind: 'ridebox', name: r.name, start: r.startTime, outdoor: false, stravaId: r.strava?.activityId, efforts: e });
  }
  const isCopy = stravaCopyChecker(rides);
  const stored = await storedEfforts();
  for (const a of acts) {
    if (!isRide(a.sportType) || isCopy(a)) continue;
    let e = stored.get(a.id);
    if (!e || e.v !== EFFORTS_VERSION) e = (await fallbackEfforts(a.id)) ?? e;
    if (!e) continue;
    const src = stravaSource(a, e);
    if (src.efforts.power || src.efforts.dist) out.push(src);
  }
  return out;
}

let cached: Promise<EffortSource[]> | null = null;
const listeners = new Set<() => void>();

/** Forget the list (a ride was added or deleted, or new Strava data arrived). */
export function invalidateEfforts() {
  cached = null;
  fallbackCache.clear();
  listeners.forEach((l) => l());
}
// streams arrive one activity at a time during a sync: reload once they settle
let settle: ReturnType<typeof setTimeout> | undefined;
onStreamsChange(() => {
  cached = null;
  clearTimeout(settle);
  settle = setTimeout(() => listeners.forEach((l) => l()), 1500);
});

export function allSources(): Promise<EffortSource[]> {
  cached ??= (async () => buildSources(await listRides(), await listAll<StravaActivity>('strava_acts')))();
  return cached;
}

/** Every ride's efforts; reloads when rides or Strava data change. */
export function useEffortSources(): EffortSource[] | null {
  const [list, setList] = useState<EffortSource[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  useEffect(() => {
    let live = true;
    allSources().then((s) => live && setList(s)).catch((e) => console.warn('best efforts', e));
    return () => {
      live = false;
    };
  }, [version]);
  return list;
}

/**
 * One ride's power curve: a RideBox ride's from its samples; a Strava ride's as saved
 * with its streams (Strava's method), else from the 1 Hz series. None for Strava's estimated power.
 */
export function useRideCurve(ride: RideRecord | undefined, act: StravaActivity | undefined, series: ActualSeries | null): PowerCurve | undefined {
  const [stored, setStored] = useState<{ id: string; e?: RideEfforts } | null>(null);
  const id = !ride ? act?.id : undefined;
  useEffect(() => {
    if (!id) return;
    let live = true;
    storedEffortsFor(id).then((e) => live && setStored({ id, e }));
    return () => {
      live = false;
    };
  }, [id, series]);
  const fromSeries = useMemo(() => (series?.power ? effortsFromPower(series.power).power : undefined), [series]);
  if (ride) return rideEfforts(ride).power;
  if (!act || act.deviceWatts === false || !isRide(act.sportType)) return undefined;
  if (stored?.id === act.id && stored.e?.v === EFFORTS_VERSION && stored.e.power) return stored.e.power;
  return fromSeries;
}
