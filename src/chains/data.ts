/** Turns the API payload into the typed model the pages compute from. */

import type { AppData, SyncStatus } from "./types";
import {
  applyTrainerBike,
  METERS_PER_MILE,
  type Chain,
  type TrainerSwitch,
  type Install,
  type Lube,
  type QuickLink,
  type Ride,
} from "./calc";

export interface Model {
  /** bike_id -> name, in display order. */
  bikes: Map<string, string>;
  chains: Chain[];
  installs: Install[];
  lubes: Lube[];
  links: QuickLink[];
  /** With default bikes applied to untagged rides. */
  rides: Ride[];
  /** Bikes whose chains are rotated. */
  chainBikes: Set<string>;
  defaultVirtualBike: string;
  /** Trainer bike changes, oldest first. */
  trainerHistory: { from: string; bike_id: string }[];
  sync: SyncStatus;
  user: string | null;
  bikeName(id: string): string;
  chainName(id: string): string;
}

const ms = (s: string) => Date.parse(s);

export function toModel(d: AppData): Model {
  const bikes = new Map(d.bikes.map((b) => [b.bike_id, b.name]));
  const chains: Chain[] = d.chains.map((c) => ({
    chain_id: c.chain_id,
    name: c.name,
    notes: c.notes ?? "",
    retired: c.retired,
    created_at: c.created_at ? ms(c.created_at) : null,
    start_distance_m: (Number(c.start_miles) || 0) * METERS_PER_MILE,
  }));
  const installs: Install[] = d.installs.map((i) => ({ ...i, installed_at: ms(i.installed_at), link_id: i.link_id ?? "" }));
  const lubes: Lube[] = d.lubes.map((l) => ({ ...l, lubed_at: ms(l.lubed_at), chain_id: l.chain_id ?? "" }));
  const links: QuickLink[] = d.quicklinks.map((q) => ({ ...q, added_at: ms(q.added_at), start_uses: Number(q.start_uses) || 0 }));
  const trainerSwitches: TrainerSwitch[] = (d.settings.virtual_bike_history ?? []).map((h) => ({
    from: h.from ? ms(h.from) : -Infinity,
    bike_id: h.bike_id,
  }));
  const rides = applyTrainerBike(
    d.rides.map(([activity_id, gear_id, start, distance_m, moving_time_s, type, trainer]) => ({
      activity_id,
      gear_id,
      start: ms(start),
      distance_m,
      moving_time_s,
      type,
      trainer: trainer === 1,
    })),
    trainerSwitches,
  );
  // Not configured yet: bikes that have a logged install.
  const chainBikes = new Set(d.settings.chain_bikes ?? installs.map((i) => i.bike_id));
  const chainNames = new Map(chains.map((c) => [c.chain_id, c.name]));
  return {
    bikes,
    chains,
    installs,
    lubes,
    links,
    rides,
    chainBikes,
    defaultVirtualBike: d.settings.default_bike_virtual_ride,
    trainerHistory: d.settings.virtual_bike_history ?? [],
    sync: d.sync,
    user: d.user,
    bikeName: (id) => bikes.get(id) ?? id,
    chainName: (id) => chainNames.get(id) ?? id,
  };
}
