/**
 * Chain tracker D1 access: records, settings, the ride cache and sync state.
 * Tables are prefixed ct_ to keep them apart from RideBox's own. Strava tokens
 * are RideBox's (strava_auth), not stored here.
 */

import type {
  AppData,
  BikeRow,
  ChainRow,
  InstallRow,
  LubeRow,
  QuickLinkRow,
  RideTuple,
  Settings,
  SyncStatus,
} from "../../src/chains/types";
import type { CachedRide, SyncStore } from "./sync";

/** Reading the athlete's bikes needs profile:read_all. */
export const hasBikesScope = (scope: string) => scope.split(",").includes("profile:read_all");

export const newId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

/** settings key -> the untagged activity type it assigns a default bike to. */
export const DEFAULT_GEAR_SETTINGS: Record<string, string> = { default_bike_virtual_ride: "VirtualRide" };

export class Db implements SyncStore {
  constructor(private db: D1Database) {}

  // meta (sync state)
  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM ct_meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row ? row.value : null;
  }

  async setMeta(values: Record<string, string | null>): Promise<void> {
    const stmts = Object.entries(values).map(([k, v]) =>
      v === null
        ? this.db.prepare("DELETE FROM ct_meta WHERE key = ?").bind(k)
        : this.db.prepare("INSERT OR REPLACE INTO ct_meta (key, value) VALUES (?, ?)").bind(k, v),
    );
    if (stmts.length) await this.db.batch(stmts);
  }

  // sync store
  async upsertBikes(bikes: { bike_id: string; name: string }[]): Promise<void> {
    if (!bikes.length) return;
    await this.db.batch(
      bikes.map((b) =>
        this.db
          .prepare(
            "INSERT INTO ct_bikes (bike_id, name) VALUES (?, ?) ON CONFLICT(bike_id) DO UPDATE SET name = excluded.name",
          )
          .bind(b.bike_id, b.name),
      ),
    );
  }

  async earliestInstall(): Promise<string | null> {
    const row = await this.db.prepare("SELECT MIN(installed_at) AS m FROM ct_installs").first<{ m: string | null }>();
    return row?.m ?? null;
  }

  async upsertRides(rides: CachedRide[], pullId: string): Promise<void> {
    if (!rides.length) return;
    await this.db.batch(
      rides.map((r) =>
        this.db
          .prepare(
            "INSERT OR REPLACE INTO ct_rides (activity_id, gear_id, start_date, distance_m, moving_time_s, name, type, trainer, pull_id) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(r.activity_id, r.gear_id, r.start_date, r.distance_m, r.moving_time_s, r.name, r.type, r.trainer ? 1 : 0, pullId),
      ),
    );
  }

  async deleteStaleRides(windowStart: string, pullId: string): Promise<number> {
    const res = await this.db
      .prepare("DELETE FROM ct_rides WHERE start_date >= ? AND pull_id != ?")
      .bind(windowStart, pullId)
      .run();
    return res.meta.changes ?? 0;
  }

  /** Empty the ride cache and sync state; keeps Strava tokens. */
  async clearRideCache(): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM ct_rides"),
      this.db.prepare(
        "DELETE FROM ct_meta WHERE key IN ('last_sync', 'window_start', 'backoff_until', 'pull_id', 'pull_window', 'pull_page', 'pull_full_start', 'pull_count')",
      ),
    ]);
  }

  // reads
  async settings(): Promise<Settings> {
    const { results } = await this.db.prepare("SELECT key, value FROM ct_settings").all<{ key: string; value: string }>();
    const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
    return {
      chain_bikes: m.chain_bikes === undefined ? null : m.chain_bikes.split(",").filter(Boolean),
      default_bike_virtual_ride: m.default_bike_virtual_ride ?? "",
    };
  }

  /** `strava`: RideBox's Strava sign-in, if configured and connected. */
  async syncStatus(strava: { scope: string } | null): Promise<SyncStatus> {
    const [meta, count] = await this.db.batch<{ key?: string; value?: string; n?: number }>([
      this.db.prepare("SELECT key, value FROM ct_meta WHERE key IN ('last_sync', 'backoff_until', 'pull_id')"),
      this.db.prepare("SELECT COUNT(*) AS n FROM ct_rides"),
    ]);
    const m = Object.fromEntries(meta.results.map((r) => [r.key!, r.value!]));
    return {
      connected: strava !== null,
      bikes_scope: hasBikesScope(strava?.scope ?? ""),
      last_sync: m.last_sync ?? null,
      backoff_until: m.backoff_until && new Date(m.backoff_until) > new Date() ? m.backoff_until : null,
      ride_count: count.results[0]?.n ?? 0,
      pulling: Boolean(m.pull_id),
    };
  }

  async all(strava: { scope: string } | null, user: string | null): Promise<AppData> {
    const [bikes, chains, installs, lubes, links, rides] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare("SELECT bike_id, name FROM ct_bikes ORDER BY name COLLATE NOCASE"),
      this.db.prepare("SELECT * FROM ct_chains"),
      this.db.prepare("SELECT * FROM ct_installs"),
      this.db.prepare("SELECT * FROM ct_lubes"),
      this.db.prepare("SELECT * FROM ct_quicklinks"),
      this.db.prepare(
        "SELECT activity_id, gear_id, start_date, distance_m, moving_time_s, type, trainer FROM ct_rides ORDER BY start_date",
      ),
    ]);
    return {
      bikes: bikes.results as unknown as BikeRow[],
      chains: (chains.results as Record<string, unknown>[]).map((r) => ({
        ...(r as unknown as ChainRow),
        retired: Boolean(r.retired),
      })),
      installs: installs.results as unknown as InstallRow[],
      lubes: lubes.results as unknown as LubeRow[],
      quicklinks: links.results as unknown as QuickLinkRow[],
      rides: (rides.results as Record<string, unknown>[]).map(
        (r) =>
          [
            r.activity_id,
            r.gear_id,
            r.start_date,
            r.distance_m,
            r.moving_time_s,
            r.type,
            r.trainer ? 1 : 0,
          ] as RideTuple,
      ),
      settings: await this.settings(),
      sync: await this.syncStatus(strava),
      user,
    };
  }

  /** Every durable record, for a backup download. Rides and tokens are left out. */
  async exportAll() {
    const [bikes, chains, installs, lubes, quicklinks, settings] = await this.db.batch([
      this.db.prepare("SELECT * FROM ct_bikes"),
      this.db.prepare("SELECT * FROM ct_chains"),
      this.db.prepare("SELECT * FROM ct_installs"),
      this.db.prepare("SELECT * FROM ct_lubes"),
      this.db.prepare("SELECT * FROM ct_quicklinks"),
      this.db.prepare("SELECT * FROM ct_settings"),
    ]);
    return {
      exported_at: new Date().toISOString(),
      bikes: bikes.results,
      chains: chains.results,
      installs: installs.results,
      lubes: lubes.results,
      quicklinks: quicklinks.results,
      settings: settings.results,
    };
  }

  async exists(table: "chains" | "installs" | "lubes" | "quicklinks", key: string, id: string): Promise<boolean> {
    return (await this.db.prepare(`SELECT 1 FROM ct_${table} WHERE ${key} = ?`).bind(id).first()) !== null;
  }

  // writes
  async addChain(c: Omit<ChainRow, "chain_id" | "created_at">): Promise<string> {
    const id = newId();
    await this.db
      .prepare("INSERT INTO ct_chains (chain_id, name, notes, retired, created_at, start_miles) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, c.name, c.notes, c.retired ? 1 : 0, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), c.start_miles)
      .run();
    return id;
  }

  async chainNameTaken(name: string, exceptId = ""): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM ct_chains WHERE lower(name) = lower(?) AND chain_id != ?")
      .bind(name, exceptId)
      .first();
    return row !== null;
  }

  async saveChain(c: Omit<ChainRow, "created_at">): Promise<void> {
    await this.db
      .prepare("UPDATE ct_chains SET name = ?, notes = ?, retired = ?, start_miles = ? WHERE chain_id = ?")
      .bind(c.name, c.notes, c.retired ? 1 : 0, c.start_miles, c.chain_id)
      .run();
  }

  /** Log a swap. Creates the new quick link in the same transaction when asked. */
  async addInstall(i: Omit<InstallRow, "install_id" | "link_id">, link: { reuse: string } | { new_note: string }) {
    const installId = newId();
    const stmts: D1PreparedStatement[] = [];
    let linkId: string;
    if ("reuse" in link) {
      linkId = link.reuse;
    } else {
      linkId = newId();
      stmts.push(
        this.db
          .prepare("INSERT INTO ct_quicklinks (link_id, chain_id, added_at, start_uses, note) VALUES (?, ?, ?, 0, ?)")
          .bind(linkId, i.chain_id, i.installed_at, link.new_note),
      );
    }
    stmts.push(
      this.db
        .prepare("INSERT INTO ct_installs (install_id, bike_id, chain_id, installed_at, note, link_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(installId, i.bike_id, i.chain_id, i.installed_at, i.note, linkId),
    );
    await this.db.batch(stmts);
    return installId;
  }

  async installClash(bikeId: string, at: string, exceptId = ""): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM ct_installs WHERE bike_id = ? AND installed_at = ? AND install_id != ?")
      .bind(bikeId, at, exceptId)
      .first();
    return row !== null;
  }

  async saveInstall(i: InstallRow): Promise<void> {
    await this.db
      .prepare("UPDATE ct_installs SET bike_id = ?, chain_id = ?, installed_at = ?, note = ?, link_id = ? WHERE install_id = ?")
      .bind(i.bike_id, i.chain_id, i.installed_at, i.note, i.link_id, i.install_id)
      .run();
  }

  async deleteInstall(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM ct_installs WHERE install_id = ?").bind(id).run();
  }

  async addLube(l: Omit<LubeRow, "lube_id">): Promise<string> {
    const id = newId();
    await this.db
      .prepare("INSERT INTO ct_lubes (lube_id, bike_id, chain_id, lubed_at, note) VALUES (?, ?, ?, ?, ?)")
      .bind(id, l.bike_id, l.chain_id, l.lubed_at, l.note)
      .run();
    return id;
  }

  async saveLube(l: LubeRow): Promise<void> {
    await this.db
      .prepare("UPDATE ct_lubes SET bike_id = ?, chain_id = ?, lubed_at = ?, note = ? WHERE lube_id = ?")
      .bind(l.bike_id, l.chain_id, l.lubed_at, l.note, l.lube_id)
      .run();
  }

  async deleteLube(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM ct_lubes WHERE lube_id = ?").bind(id).run();
  }

  async addQuickLink(q: Omit<QuickLinkRow, "link_id">): Promise<string> {
    const id = newId();
    await this.db
      .prepare("INSERT INTO ct_quicklinks (link_id, chain_id, added_at, start_uses, note) VALUES (?, ?, ?, ?, ?)")
      .bind(id, q.chain_id, q.added_at, q.start_uses, q.note)
      .run();
    return id;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.prepare("INSERT OR REPLACE INTO ct_settings (key, value) VALUES (?, ?)").bind(key, value).run();
  }
}
