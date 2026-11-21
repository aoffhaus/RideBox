import { openDB, type IDBPDatabase } from 'idb';
import type { RideRecord } from '../app/recorder';
import { DEFAULT_SETTINGS, type Settings, type StoredWorkout } from './types';

export { DEFAULT_SETTINGS, reactLabel, uid, type Settings, type StoredWorkout } from './types';

// ---------- IndexedDB ----------
//
// Each browser keeps a full local copy (rides work offline and stay fast).
// Stores listed in SYNCED_STORES are also mirrored to the private Cloudflare
// backend by ./sync.ts when the app is served from there. Every write here stamps
// the record and marks it dirty so the sync engine can push it.

export const SYNCED_STORES = ['workouts', 'rides', 'kv', 'calendar', 'plans', 'strava_acts', 'strava_streams'] as const;
export type SyncedStore = (typeof SYNCED_STORES)[number];

let dbp: Promise<IDBPDatabase> | null = null;
export function db() {
  dbp ??= openDB('ridebox', 3, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('workouts', { keyPath: 'id' });
        d.createObjectStore('rides', { keyPath: 'id' });
        d.createObjectStore('kv');
      }
      if (oldVersion < 2) {
        d.createObjectStore('calendar', { keyPath: 'id' });
        d.createObjectStore('plans', { keyPath: 'id' });
        d.createObjectStore('strava_acts', { keyPath: 'id' });
        // local-only bookkeeping: per-record write stamps, the dirty queue, sync cursor
        d.createObjectStore('meta');
      }
      // second-by-second Strava data, downloaded once per activity
      if (oldVersion < 3) d.createObjectStore('strava_streams', { keyPath: 'id' });
    },
  });
  return dbp;
}

export const stampKey = (store: string, id: string) => `stamp:${store}/${id}`;
export const dirtyKey = (store: string, id: string) => `dirty:${store}/${id}`;

let lastStamp = 0;
/** Strictly increasing ms timestamp, so two quick writes never tie. */
export function nextStamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

type ChangeListener = () => void;
let localChange: ChangeListener | null = null;
/** The sync engine registers here to hear about local writes. */
export function onLocalChange(fn: ChangeListener | null) {
  localChange = fn;
}

async function track(store: SyncedStore, id: string, deleted: boolean) {
  const d = await db();
  const tx = d.transaction('meta', 'readwrite');
  await tx.store.put(nextStamp(), stampKey(store, id));
  await tx.store.put({ store, id, deleted }, dirtyKey(store, id));
  await tx.done;
  localChange?.();
}

async function put(store: SyncedStore, value: unknown, key?: string) {
  await (await db()).put(store, value, key);
  await track(store, key ?? (value as { id: string }).id, false);
}
async function del(store: SyncedStore, id: string) {
  await (await db()).delete(store, id);
  await track(store, id, true);
}


export async function loadSettings(): Promise<Settings> {
  try {
    const s = await (await db()).get('kv', 'settings');
    return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
export async function saveSettings(s: Settings) {
  await put('kv', s, 'settings');
}

export async function listWorkouts(): Promise<StoredWorkout[]> {
  const all = (await (await db()).getAll('workouts')) as StoredWorkout[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function saveWorkout(w: StoredWorkout) {
  await put('workouts', w);
}
export async function deleteWorkout(id: string) {
  await del('workouts', id);
}

export async function listRides(): Promise<RideRecord[]> {
  const all = (await (await db()).getAll('rides')) as RideRecord[];
  return all.sort((a, b) => b.startTime - a.startTime);
}
export async function saveRide(r: RideRecord) {
  await put('rides', r);
}
export async function deleteRide(id: string) {
  await del('rides', id);
}

export async function getFlag(key: string): Promise<unknown> {
  return (await db()).get('kv', key);
}
export async function setFlag(key: string, value: unknown) {
  await put('kv', value, key);
}

/** Generic access for the newer stores (calendar, plans, Strava activities). */
export async function listAll<T>(store: SyncedStore): Promise<T[]> {
  return (await (await db()).getAll(store)) as T[];
}
export async function getOne<T>(store: SyncedStore, id: string): Promise<T | undefined> {
  return (await (await db()).get(store, id)) as T | undefined;
}
export async function putOne<T extends { id: string }>(store: SyncedStore, value: T) {
  await put(store, value);
}
export async function deleteOne(store: SyncedStore, id: string) {
  await del(store, id);
}

// ---------- backup ----------

export interface Backup {
  app: 'ridebox';
  version: 1;
  exportedAt: number;
  stores: Partial<Record<SyncedStore, [string, unknown][]>>;
}

/** Everything this browser has, for moving to another site address (browser storage is per-site). */
export async function exportAll(): Promise<Backup> {
  const d = await db();
  const stores: Backup['stores'] = {};
  for (const s of SYNCED_STORES) {
    const keys = (await d.getAllKeys(s)) as string[];
    const vals = await d.getAll(s);
    stores[s] = keys.map((k, i) => [k, vals[i]]);
  }
  return { app: 'ridebox', version: 1, exportedAt: Date.now(), stores };
}

/**
 * Merges a backup in. Records this browser already has are kept by default: a restored
 * record gets a fresh write stamp, so replacing would let an old backup overwrite newer
 * data on every synced browser. Pass `overwrite` to replace them. Returns how many were written.
 */
export async function importAll(b: Backup, opts: { overwrite?: boolean } = {}): Promise<number> {
  if (b?.app !== 'ridebox' || !b.stores) throw new Error('Not a RideBox backup file.');
  const d = await db();
  let n = 0;
  for (const s of SYNCED_STORES) {
    for (const [key, value] of b.stores[s] ?? []) {
      const id = s === 'kv' ? key : (value as { id: string }).id;
      if (!opts.overwrite && (await d.get(s, id)) !== undefined) continue;
      if (s === 'kv') await put('kv', value, key);
      else await put(s, value);
      n++;
    }
  }
  return n;
}
