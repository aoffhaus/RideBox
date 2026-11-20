/**
 * Pure chain-usage calculations, ported from the Python app's calc.py. No I/O.
 *
 * Distances are meters and durations are seconds; conversion to miles/hours
 * happens at the display edge. Timestamps are epoch milliseconds (UTC).
 */

export const METERS_PER_MILE = 1609.344;
/** Starting miles entered for a chain have no recorded time; estimate it at this speed. */
export const ESTIMATE_SPEED_MPH = 16;
export const INDOOR_TYPES = new Set(["VirtualRide"]);

export interface Ride {
  activity_id: number;
  gear_id: string | null;
  start: number;
  distance_m: number;
  moving_time_s: number;
  type: string;
  trainer: boolean;
}

export interface Install {
  install_id: string;
  bike_id: string;
  chain_id: string;
  installed_at: number;
  note: string;
  /** Quick link used to close the chain on this install, if recorded. */
  link_id: string;
}

export interface Chain {
  chain_id: string;
  name: string;
  notes: string;
  retired: boolean;
  created_at: number | null;
  start_distance_m: number;
}

/** A lube/wax service. chain_id is set on bikes with rotated chains, blank otherwise. */
export interface Lube {
  lube_id: string;
  bike_id: string;
  chain_id: string;
  lubed_at: number;
  note: string;
}

/** A quick link fitted to a chain. The newest one on a chain is the one in use. */
export interface QuickLink {
  link_id: string;
  chain_id: string;
  added_at: number;
  /** Times it was used before it was tracked here. */
  start_uses: number;
  note: string;
}

export interface Usage {
  distance_m: number;
  moving_time_s: number;
  rides: number;
}

/** Zwift-style virtual rides, or any ride Strava marks as on a trainer. */
export function isIndoor(r: Ride): boolean {
  return r.trainer || INDOOR_TYPES.has(r.type);
}

export function usage(rides: Ride[]): Usage {
  let distance_m = 0;
  let moving_time_s = 0;
  for (const r of rides) {
    distance_m += r.distance_m;
    moving_time_s += r.moving_time_s;
  }
  return { distance_m, moving_time_s, rides: rides.length };
}

export function indoorOutdoor(rides: Ride[]): { indoor: Usage; outdoor: Usage } {
  return { indoor: usage(rides.filter(isIndoor)), outdoor: usage(rides.filter((r) => !isIndoor(r))) };
}

/** One stretch of a chain on a bike: [start, end). end is null while current. */
export interface Period {
  install: Install;
  start: number;
  end: number | null;
  rides: Ride[];
}

export const periodUsage = (p: Period): Usage => usage(p.rides);

function contains(p: Period, ride: Ride): boolean {
  if (ride.gear_id !== p.install.bike_id) return false;
  if (ride.start < p.start) return false;
  return p.end === null || ride.start < p.end;
}

export interface ChainStats {
  chain: Chain;
  periods: Period[];
  start_time_estimated_s: number;
  current: Period | null;
  current_bike_id: string | null;
  ridden: Usage;
  lifetime_distance_m: number;
  lifetime_time_s: number;
  /** Null when the chain isn't on a bike. */
  since_install: Usage | null;
}

export interface BikeStatus {
  bike_id: string;
  current: Period | null;
  unassigned: Ride[];
}

export function estimatedTimeS(distance_m: number, speed_mph = ESTIMATE_SPEED_MPH): number {
  if (distance_m <= 0) return 0;
  return distance_m / ((speed_mph * METERS_PER_MILE) / 3600);
}

/**
 * Give rides with no gear_id a bike based on their type, e.g. {VirtualRide: bike_id}.
 * Rides already tagged with a bike on Strava keep their tag.
 */
export function applyDefaultGear(rides: Ride[], defaults: Record<string, string>): Ride[] {
  if (Object.keys(defaults).length === 0) return rides;
  return rides.map((r) => (!r.gear_id && defaults[r.type] ? { ...r, gear_id: defaults[r.type] } : r));
}

function compareInstalls(a: Install, b: Install): number {
  if (a.installed_at !== b.installed_at) return a.installed_at - b.installed_at;
  return a.install_id < b.install_id ? -1 : a.install_id > b.install_id ? 1 : 0;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Turn the swap log into periods. Each install runs until the next install on the same bike. */
export function buildPeriods(installs: Install[]): Period[] {
  const periods: Period[] = [];
  for (const bikeInstalls of groupBy(installs, (i) => i.bike_id).values()) {
    const sorted = [...bikeInstalls].sort(compareInstalls);
    sorted.forEach((inst, idx) => {
      const next = sorted[idx + 1];
      periods.push({ install: inst, start: inst.installed_at, end: next ? next.installed_at : null, rides: [] });
    });
  }
  return periods.sort((a, b) => compareInstalls(a.install, b.install));
}

/**
 * Attach each ride to the period on its bike that covers its start.
 *
 * A ride starting exactly at a swap timestamp belongs to the newly installed
 * chain. Rides with no gear_id are ignored. Rides on a known bike that fall
 * before its first install (or on a bike with no installs) are unassigned.
 */
export function assignRides(
  installs: Install[],
  rides: Ride[],
  bikeIds: string[] = [],
): { periods: Period[]; unassigned: Map<string, Ride[]> } {
  const periods = buildPeriods(installs);
  const byBike = groupBy(periods, (p) => p.install.bike_id);
  const known = new Set([...bikeIds, ...byBike.keys()]);
  const unassigned = new Map<string, Ride[]>([...known].map((b) => [b, []]));

  for (const ride of [...rides].sort((a, b) => a.start - b.start)) {
    if (!ride.gear_id || !known.has(ride.gear_id)) continue;
    const match = (byBike.get(ride.gear_id) ?? []).find((p) => contains(p, ride));
    if (match) match.rides.push(ride);
    else unassigned.get(ride.gear_id)!.push(ride);
  }
  return { periods, unassigned };
}

export function chainStats(chains: Chain[], installs: Install[], rides: Ride[]): Map<string, ChainStats> {
  const { periods } = assignRides(installs, rides);
  const byChain = groupBy(periods, (p) => p.install.chain_id);
  const out = new Map<string, ChainStats>();
  for (const chain of chains) {
    const ps = byChain.get(chain.chain_id) ?? [];
    const current = ps.find((p) => p.end === null) ?? null;
    const ridden = usage(ps.flatMap((p) => p.rides));
    const start_time_estimated_s = estimatedTimeS(chain.start_distance_m);
    out.set(chain.chain_id, {
      chain,
      periods: ps,
      start_time_estimated_s,
      current,
      current_bike_id: current ? current.install.bike_id : null,
      ridden,
      lifetime_distance_m: chain.start_distance_m + ridden.distance_m,
      lifetime_time_s: start_time_estimated_s + ridden.moving_time_s,
      since_install: current ? periodUsage(current) : null,
    });
  }
  return out;
}

export function bikeStatus(bikeIds: string[], installs: Install[], rides: Ride[]): Map<string, BikeStatus> {
  const { periods, unassigned } = assignRides(installs, rides, bikeIds);
  const current = new Map(periods.filter((p) => p.end === null).map((p) => [p.install.bike_id, p]));
  return new Map(
    bikeIds.map((b) => [b, { bike_id: b, current: current.get(b) ?? null, unassigned: unassigned.get(b) ?? [] }]),
  );
}

export interface LubeStatus {
  /** Most recent lube, or null if never logged. */
  lube: Lube | null;
  rides: Ride[];
}

function latest<T>(items: T[], at: (t: T) => number, tiebreak: (t: T) => string = () => ""): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (
      best === null ||
      at(item) > at(best) ||
      (at(item) === at(best) && tiebreak(item) > tiebreak(best))
    ) {
      best = item;
    }
  }
  return best;
}

/** Times a quick link has been closed: its starting uses plus each install that used it. */
export function linkUses(link: QuickLink, installs: Install[]): number {
  return link.start_uses + installs.filter((i) => i.link_id === link.link_id).length;
}

export function currentLink(chainId: string, links: QuickLink[]): QuickLink | null {
  return latest(
    links.filter((l) => l.chain_id === chainId),
    (l) => l.added_at,
    (l) => l.link_id,
  );
}

/** The chain installed on a bike at a moment, or null before its first install. */
export function chainOnBikeAt(installs: Install[], bikeId: string, at: number): string | null {
  for (const p of buildPeriods(installs)) {
    if (p.install.bike_id === bikeId && p.start <= at && (p.end === null || at < p.end)) {
      return p.install.chain_id;
    }
  }
  return null;
}

/** Usage of a chain since its last lube, following it across bikes and swaps. */
export function chainLubeStatus(chainId: string, lubes: Lube[], installs: Install[], rides: Ride[]): LubeStatus {
  const lube = latest(
    lubes.filter((l) => l.chain_id === chainId),
    (l) => l.lubed_at,
  );
  if (!lube) return { lube: null, rides: [] };
  const { periods } = assignRides(installs, rides);
  const since = periods
    .filter((p) => p.install.chain_id === chainId)
    .flatMap((p) => p.rides)
    .filter((r) => r.start >= lube.lubed_at)
    .sort((a, b) => a.start - b.start);
  return { lube, rides: since };
}

/** Usage of a bike since its last lube, for bikes whose chains aren't rotated. */
export function bikeLubeStatus(bikeId: string, lubes: Lube[], rides: Ride[]): LubeStatus {
  const lube = latest(
    lubes.filter((l) => l.bike_id === bikeId),
    (l) => l.lubed_at,
  );
  if (!lube) return { lube: null, rides: [] };
  const since = rides
    .filter((r) => r.gear_id === bikeId && r.start >= lube.lubed_at)
    .sort((a, b) => a.start - b.start);
  return { lube, rides: since };
}

export const mToMi = (m: number): number => m / METERS_PER_MILE;
export const sToH = (s: number): number => s / 3600;
