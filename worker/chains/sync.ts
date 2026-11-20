/**
 * Pull bikes and rides from Strava into D1. Ported from the Python sync.py.
 *
 * Differences from the Python version: a pull is split into steps of a few
 * pages each, so a long first pull fits in Workers' per-request limits. Pull
 * progress is saved in meta, and the next call (cron, "Sync now", or the
 * browser looping while `more` is true) carries on where the last one stopped.
 * Rides inside the pulled window that the pull didn't see (deleted on Strava,
 * or moved earlier) are removed when the pull finishes.
 */

import type { SyncResult } from "../../src/chains/types";
import { NotConnected, RateLimited, StravaError, type StravaActivity, type StravaApi } from "./strava";

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** Re-fetch this far back to catch edits and deletions. */
export const REPULL_MS = 30 * 24 * 3600 * 1000;
/** Start the cache a little before the earliest install. */
export const WINDOW_PAD_MS = 24 * 3600 * 1000;
export const PAGES_PER_STEP = 3;
const PER_PAGE = 200;

export interface CachedRide {
  activity_id: number;
  gear_id: string | null;
  start_date: string;
  distance_m: number;
  moving_time_s: number;
  name: string;
  type: string;
  trainer: boolean;
}

export interface SyncStore {
  getMeta(key: string): Promise<string | null>;
  setMeta(values: Record<string, string | null>): Promise<void>;
  upsertBikes(bikes: { bike_id: string; name: string }[]): Promise<void>;
  /** Earliest installed_at across all installs, or null if none. */
  earliestInstall(): Promise<string | null>;
  upsertRides(rides: CachedRide[], pullId: string): Promise<void>;
  /** Delete rides starting at or after windowStart whose pull_id differs. */
  deleteStaleRides(windowStart: string, pullId: string): Promise<number>;
}

export const toIso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function activityToRide(a: StravaActivity): CachedRide {
  return {
    activity_id: a.id,
    gear_id: a.gear_id || null,
    start_date: toIso(new Date(a.start_date)),
    distance_m: Number(a.distance) || 0,
    moving_time_s: Math.trunc(Number(a.moving_time) || 0),
    name: a.name || "",
    type: a.sport_type || a.type || "",
    trainer: Boolean(a.trainer),
  };
}

const PULL_KEYS = ["pull_id", "pull_window", "pull_page", "pull_full_start", "pull_count"] as const;

function fmtWhen(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

export async function backoffUntil(store: SyncStore, now: Date): Promise<Date | null> {
  const v = await store.getMeta("backoff_until");
  return v && new Date(v) > now ? new Date(v) : null;
}

export async function isDue(store: SyncStore, now: Date): Promise<boolean> {
  if (await backoffUntil(store, now)) return false;
  if (await store.getMeta("pull_id")) return true; // an unfinished pull always continues
  const last = await store.getMeta("last_sync");
  return last === null || now.getTime() - new Date(last).getTime() >= SYNC_INTERVAL_MS;
}

/**
 * Run one sync step. Starts a new pull if none is in progress (and one is due,
 * unless `force`), then fetches up to `maxPages` pages.
 */
export async function syncStep(
  store: SyncStore,
  client: StravaApi,
  opts: { now?: Date; force?: boolean; maxPages?: number; newId?: () => string } = {},
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const maxPages = opts.maxPages ?? PAGES_PER_STEP;
  const newId = opts.newId ?? (() => crypto.randomUUID());

  const until = await backoffUntil(store, now);
  if (until) {
    return { ok: false, message: `Strava rate limit reached. Sync paused until ${fmtWhen(until)}.`, fetched: 0, more: false };
  }
  if (!opts.force && !(await isDue(store, now))) {
    return { ok: true, message: "Already up to date.", fetched: 0, more: false };
  }

  try {
    const earliestInstall = await store.earliestInstall();
    let pullId = await store.getMeta("pull_id");
    let window = new Date(0);
    let page = 1;
    let fullStart: string | null = null;
    let count = 0;

    if (pullId) {
      window = new Date((await store.getMeta("pull_window")) ?? 0);
      page = Number(await store.getMeta("pull_page"));
      fullStart = await store.getMeta("pull_full_start");
      count = Number((await store.getMeta("pull_count")) ?? 0);
      // An install logged earlier than this pull's window since it started: start over.
      if (earliestInstall && new Date(new Date(earliestInstall).getTime() - WINDOW_PAD_MS) < window) pullId = null;
    }

    if (!pullId) {
      await store.upsertBikes(await client.bikes());
      if (!earliestInstall) {
        await store.setMeta({ last_sync: toIso(now) });
        return { ok: true, message: "Bikes updated. No installs logged yet, so no rides to pull.", fetched: 0, more: false };
      }
      const earliest = new Date(new Date(earliestInstall).getTime() - WINDOW_PAD_MS);
      const cachedStart = await store.getMeta("window_start");
      const last = await store.getMeta("last_sync");
      const full = cachedStart === null || new Date(cachedStart) > earliest || last === null;
      window = full ? earliest : new Date(Math.max(earliest.getTime(), new Date(last!).getTime() - REPULL_MS));
      pullId = newId();
      page = 1;
      fullStart = full ? toIso(earliest) : null;
      count = 0;
      await store.setMeta({
        pull_id: pullId,
        pull_window: toIso(window),
        pull_page: "1",
        pull_full_start: fullStart,
        pull_count: "0",
      });
    }

    // `after` is exclusive; step back a second so a ride exactly at `window` is refetched.
    const after = new Date(window.getTime() - 1000);
    for (let i = 0; i < maxPages; i++) {
      const batch = await client.activitiesPage(after, page);
      const rides = batch.map(activityToRide).filter((r) => new Date(r.start_date) >= window);
      await store.upsertRides(rides, pullId);
      count += rides.length;
      page += 1;
      if (batch.length < PER_PAGE) {
        await store.deleteStaleRides(toIso(window), pullId);
        const done: Record<string, string | null> = { last_sync: toIso(now), backoff_until: null };
        for (const k of PULL_KEYS) done[k] = null;
        if (fullStart) done.window_start = fullStart;
        await store.setMeta(done);
        const kind = fullStart ? "Full pull" : "Synced";
        return {
          ok: true,
          message: `${kind}: ${count} activities since ${toIso(window).slice(0, 10)}.`,
          fetched: count,
          more: false,
        };
      }
    }
    await store.setMeta({ pull_page: String(page), pull_count: String(count) });
    return { ok: true, message: `Pulled ${count} activities so far…`, fetched: count, more: true };
  } catch (e) {
    if (e instanceof RateLimited) {
      await store.setMeta({ backoff_until: toIso(e.retryAfter) });
      return { ok: false, message: `${e.message} Try again after ${fmtWhen(e.retryAfter)}.`, fetched: 0, more: false };
    }
    if (e instanceof NotConnected) return { ok: false, message: e.message, fetched: 0, more: false };
    if (e instanceof StravaError || e instanceof TypeError) {
      return { ok: false, message: `Sync failed: ${e.message}`, fetched: 0, more: false };
    }
    throw e;
  }
}
