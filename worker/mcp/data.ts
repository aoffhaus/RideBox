// The rider's data as the Claude connector sees it: read from the synced docs
// table, and written back the same way a browser push would, so every browser
// picks Claude's changes up on its next sync. Each write is logged in
// mcp_changes with the record before and after, so it can be undone.

import type { RideRecord, Sample } from '../../src/app/recorder';
import { DEFAULT_SETTINGS, type Settings, type StoredWorkout } from '../../src/storage/types';
import { reconcile } from '../../src/training/calendar';
import { dayKey } from '../../src/training/load';
import type { PlannedWorkout, StravaActivity, TrainingPlan } from '../../src/training/model';
import { flatten, plannedStats } from '../../src/workout/model';
import { getBlob, writeDoc, type SyncedStoreName } from '../sync';

export interface RiderData {
  settings: Settings;
  timezone: string;
  /** today in the rider's time zone */
  today: string;
  /** "now" shifted into the rider's wall clock (see shiftToLocal) */
  now: number;
  /** RideBox rides without their 1 Hz samples (power only), start times shifted to local */
  rides: RideRecord[];
  /** rides still being indexed (left for the next call) */
  ridesPending: number;
  acts: StravaActivity[];
  /** calendar with done / missed statuses brought up to date (not saved) */
  calendar: PlannedWorkout[];
  plans: TrainingPlan[];
  library: StoredWorkout[];
}

// ---------- time zones ----------
//
// The training code works in "local" days with plain Date methods, which run in
// UTC on a Worker. Shifting each timestamp by the rider's UTC offset at that
// moment makes those UTC methods read the rider's wall clock. Shifted values are
// only used for calculations and are never written back.

const formatters = new Map<string, Intl.DateTimeFormat>();
export function validTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
/** Milliseconds to add to a UTC timestamp to get the wall-clock time in `tz`. */
export function tzOffsetMs(tz: string, t: number): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - (t - (t % 1000));
}
export const shiftToLocal = (tz: string, t: number) => t + tzOffsetMs(tz, t);

// ---------- reading ----------

interface DocRow {
  id: string;
  json: string | null;
  blob: string | null;
  updated_at: number;
}

async function rowBody(db: D1Database, r: Pick<DocRow, 'json' | 'blob'>): Promise<string | null> {
  return r.blob ? getBlob(db, r.blob) : r.json;
}

export async function readStore<T>(db: D1Database, store: SyncedStoreName): Promise<T[]> {
  const { results } = await db.prepare('SELECT id, json, blob, updated_at FROM docs WHERE store = ? AND deleted = 0').bind(store).all<DocRow>();
  const out: T[] = [];
  for (const r of results) {
    const body = await rowBody(db, r);
    if (body) out.push(JSON.parse(body) as T);
  }
  return out;
}

export async function readDoc<T>(db: D1Database, store: SyncedStoreName, id: string): Promise<{ value: T; updated_at: number } | null> {
  const r = await db.prepare('SELECT id, json, blob, updated_at FROM docs WHERE store = ? AND id = ? AND deleted = 0').bind(store, id).first<DocRow>();
  if (!r) return null;
  const body = await rowBody(db, r);
  return body ? { value: JSON.parse(body) as T, updated_at: r.updated_at } : null;
}

/** A ride without its samples, plus its power series (what levels and the FTP estimate need). */
interface LiteRide extends Omit<RideRecord, 'samples'> {
  power: number[];
}
export function toLite(r: RideRecord): LiteRide {
  const { samples, ...rest } = r;
  return { ...rest, power: (samples ?? []).map((s) => Math.round(s.power || 0)) };
}
export function fromLite(l: LiteRide): RideRecord {
  const { power, ...rest } = l;
  return { ...rest, samples: power.map((p) => ({ power: p }) as Sample) };
}

/** Rides indexed per call: each needs its full record parsed once, so spread big backlogs over a few calls. */
const INDEX_PER_CALL = 25;

export async function loadRides(db: D1Database): Promise<{ rides: RideRecord[]; pending: number }> {
  const [{ results: docs }, { results: cached }] = await Promise.all([
    db.prepare("SELECT id, updated_at FROM docs WHERE store = 'rides' AND deleted = 0").all<{ id: string; updated_at: number }>(),
    db.prepare('SELECT id, updated_at, json FROM ride_cache').all<{ id: string; updated_at: number; json: string }>(),
  ]);
  const cache = new Map(cached.map((c) => [c.id, c]));
  const live = new Set(docs.map((d) => d.id));
  const stale = docs.filter((d) => cache.get(d.id)?.updated_at !== d.updated_at);
  for (const d of stale.slice(0, INDEX_PER_CALL)) {
    const full = await readDoc<RideRecord>(db, 'rides', d.id);
    if (!full) continue;
    const json = JSON.stringify(toLite(full.value));
    await db.prepare('INSERT INTO ride_cache (id, updated_at, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json').bind(d.id, full.updated_at, json).run();
    cache.set(d.id, { id: d.id, updated_at: full.updated_at, json });
  }
  const gone = cached.filter((c) => !live.has(c.id)).map((c) => c.id);
  for (const id of gone) await db.prepare('DELETE FROM ride_cache WHERE id = ?').bind(id).run();
  const rides = [...cache.values()].filter((c) => live.has(c.id)).map((c) => fromLite(JSON.parse(c.json) as LiteRide));
  return { rides: rides.sort((a, b) => b.startTime - a.startTime), pending: Math.max(0, stale.length - INDEX_PER_CALL) };
}

async function kvValue<T>(db: D1Database, key: string): Promise<T | undefined> {
  const d = await readDoc<T>(db, 'kv', key);
  return d?.value;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await kvValue<Partial<Settings>>(db, 'settings')) ?? {}) };
}

/** The rider's time zone: what the app last saved, else RIDER_TIMEZONE, else UTC. */
export async function loadTimeZone(db: D1Database, fallback?: string): Promise<string> {
  const tz = await kvValue<string>(db, 'timezone');
  if (validTimeZone(tz)) return tz;
  return validTimeZone(fallback) ? fallback : 'UTC';
}

export async function loadRiderData(db: D1Database, fallbackTz?: string): Promise<RiderData> {
  const [settings, timezone, ridesRes, acts, calendar, plans, library] = await Promise.all([
    loadSettings(db),
    loadTimeZone(db, fallbackTz),
    loadRides(db),
    readStore<StravaActivity>(db, 'strava_acts'),
    readStore<PlannedWorkout>(db, 'calendar'),
    readStore<TrainingPlan>(db, 'plans'),
    readStore<StoredWorkout>(db, 'workouts'),
  ]);
  const now = shiftToLocal(timezone, Date.now());
  const today = dayKey(now);
  const rides = ridesRes.rides.map((r) => ({ ...r, startTime: shiftToLocal(timezone, r.startTime) }));
  const localActs = acts.map((a) => ({ ...a, start: shiftToLocal(timezone, a.start) }));
  // the app does this on every load; do the same so statuses aren't stale when no browser has opened lately
  const changed = new Map(reconcile(calendar, rides, localActs, (p) => plannedStats(flatten(p.workout), settings.ftp).duration, today).map((c) => [c.id, c]));
  return {
    settings,
    timezone,
    today,
    now,
    rides,
    ridesPending: ridesRes.pending,
    acts: localActs,
    calendar: calendar.map((c) => changed.get(c.id) ?? c),
    plans,
    library: library.sort((a, b) => b.createdAt - a.createdAt),
  };
}

// ---------- writing ----------

export interface Change {
  store: SyncedStoreName;
  id: string;
  /** the new record, or null to delete it */
  value: unknown | null;
}

/**
 * Saves records the way a browser push does (newer stamp wins) and logs each
 * one. Stamps are at least the stored stamp + 1, so a browser clock running
 * slightly ahead of the Worker's can't make the change silently lose.
 */
export async function saveChanges(db: D1Database, tool: string, summary: string, changes: Change[]): Promise<number[]> {
  const ids: number[] = [];
  for (const c of changes) {
    const prev = await db.prepare('SELECT updated_at, deleted, json, blob FROM docs WHERE store = ? AND id = ?').bind(c.store, c.id).first<DocRow & { deleted: number }>();
    const before = prev && !prev.deleted ? await rowBody(db, prev) : null;
    const updated_at = Math.max(Date.now(), (prev?.updated_at ?? 0) + 1);
    const after = c.value === null ? null : JSON.stringify(c.value);
    await writeDoc(db, after === null ? { store: c.store, id: c.id, updated_at, deleted: true } : { store: c.store, id: c.id, updated_at, json: after });
    const row = await db
      .prepare('INSERT INTO mcp_changes (at, tool, summary, store, doc_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(Date.now(), tool, summary, c.store, c.id, before, after)
      .first<{ id: number }>();
    if (row) ids.push(row.id);
  }
  return ids;
}

export interface ChangeRow {
  id: number;
  at: number;
  tool: string;
  summary: string;
  store: string;
  doc_id: string;
  before: string | null;
  after: string | null;
  undone: number;
}

export async function recentChanges(db: D1Database, limit: number): Promise<ChangeRow[]> {
  const { results } = await db.prepare('SELECT * FROM mcp_changes ORDER BY id DESC LIMIT ?').bind(limit).all<ChangeRow>();
  return results;
}

export async function getChange(db: D1Database, id: number): Promise<ChangeRow | null> {
  return db.prepare('SELECT * FROM mcp_changes WHERE id = ?').bind(id).first<ChangeRow>();
}

export async function markUndone(db: D1Database, id: number) {
  await db.prepare('UPDATE mcp_changes SET undone = 1 WHERE id = ?').bind(id).run();
}

/** The stored record's JSON now (null when missing or deleted). */
export async function currentJson(db: D1Database, store: string, id: string): Promise<string | null> {
  const r = await db.prepare('SELECT deleted, json, blob FROM docs WHERE store = ? AND id = ?').bind(store, id).first<DocRow & { deleted: number }>();
  return r && !r.deleted ? rowBody(db, r) : null;
}
