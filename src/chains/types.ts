/** JSON shapes passed between the Worker and the browser. Timestamps are ISO 8601 UTC strings. */

export interface BikeRow {
  bike_id: string;
  name: string;
}

export interface ChainRow {
  chain_id: string;
  name: string;
  notes: string;
  retired: boolean;
  created_at: string | null;
  start_miles: number;
}

export interface InstallRow {
  install_id: string;
  bike_id: string;
  chain_id: string;
  installed_at: string;
  note: string;
  link_id: string;
}

export interface LubeRow {
  lube_id: string;
  bike_id: string;
  chain_id: string;
  lubed_at: string;
  note: string;
}

export interface QuickLinkRow {
  link_id: string;
  chain_id: string;
  added_at: string;
  start_uses: number;
  note: string;
}

/** Compact ride tuple to keep the payload small: [id, gear_id, start, distance_m, moving_time_s, type, trainer]. */
export type RideTuple = [number, string | null, string, number, number, string, 0 | 1];

export interface SyncStatus {
  connected: boolean;
  last_sync: string | null;
  backoff_until: string | null;
  ride_count: number;
  /** RideBox's Strava connection may read the athlete's bikes (profile:read_all). */
  bikes_scope: boolean;
  /** A full pull is in progress and needs more steps. */
  pulling: boolean;
}

export interface Settings {
  /** Bikes whose chains are rotated. Null means not set yet. */
  chain_bikes: string[] | null;
  default_bike_virtual_ride: string;
}

export interface AppData {
  bikes: BikeRow[];
  chains: ChainRow[];
  installs: InstallRow[];
  lubes: LubeRow[];
  quicklinks: QuickLinkRow[];
  rides: RideTuple[];
  settings: Settings;
  sync: SyncStatus;
  user: string | null;
}

export interface SyncResult {
  ok: boolean;
  message: string;
  fetched: number;
  /** More pages remain; call sync again to continue. */
  more: boolean;
}

export interface NewInstall {
  bike_id: string;
  chain_id: string;
  installed_at: string;
  note: string;
  /** Reuse this quick link, or create a new one with the given note. */
  link: { reuse: string } | { new_note: string };
}
