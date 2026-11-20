// Sync engine: mirrors the local IndexedDB stores to the private Cloudflare
// backend (worker/sync.ts) so rides, workouts, the calendar and settings are the
// same in every browser.
//
// Model: each record carries a write stamp. Local writes are queued ("dirty")
// and pushed; pulls apply any remote record whose stamp is newer than ours.
// Newest write wins, deletes travel as tombstones. When the site isn't served
// by the Worker (GitHub Pages, `npm run dev`) /api/me fails and sync stays off.

import { SYNCED_STORES, db, dirtyKey, onLocalChange, stampKey, type SyncedStore } from './db';

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'offline' | 'error';

interface RemoteDoc {
  store: SyncedStore;
  id: string;
  updated_at: number;
  deleted: boolean;
  blob: boolean;
  json: string | null;
  server_at: number;
}

interface Dirty {
  store: SyncedStore;
  id: string;
  deleted: boolean;
}

/** Should a remote version replace what this browser has? */
export function remoteWins(remoteStamp: number, localStamp: number | undefined): boolean {
  return remoteStamp > (localStamp ?? 0);
}

/** Splits a push into requests of roughly `maxBytes` each. */
export function batchBySize<T extends { json?: string }>(docs: T[], maxBytes = 4_000_000): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const d of docs) {
    const n = (d.json?.length ?? 0) + 200;
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(d);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const keyPathStores = new Set<SyncedStore>(['workouts', 'rides', 'calendar', 'plans', 'strava_acts', 'strava_streams']);

class SyncEngine {
  status: SyncStatus = 'off';
  email = '';
  private listeners = new Set<(s: SyncStatus) => void>();
  private remoteListeners = new Set<(stores: Set<SyncedStore>) => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  onStatus(fn: (s: SyncStatus) => void) {
    this.listeners.add(fn);
    fn(this.status);
    return () => void this.listeners.delete(fn);
  }
  /** Fires after a pull changed local data (the UI should reload those stores). */
  onRemoteChange(fn: (stores: Set<SyncedStore>) => void) {
    this.remoteListeners.add(fn);
    return () => void this.remoteListeners.delete(fn);
  }
  private set(s: SyncStatus) {
    this.status = s;
    for (const l of this.listeners) l(s);
  }

  /** Detects the backend; resolves true when sync is available. Pulls once before returning. */
  async start(): Promise<boolean> {
    try {
      const res = await fetch('api/me', { headers: { Accept: 'application/json' } });
      if (!res.ok || !(res.headers.get('Content-Type') ?? '').includes('json')) return false;
      this.email = ((await res.json()) as { email: string }).email;
    } catch {
      return false;
    }
    onLocalChange(() => this.schedulePush());
    window.addEventListener('focus', () => void this.syncNow());
    window.addEventListener('online', () => void this.syncNow());
    setInterval(() => void this.syncNow(), 5 * 60_000);
    await this.syncNow();
    return true;
  }

  private schedulePush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.syncNow(), 1500);
  }

  /** Pull then push. Calls made while one is running coalesce into one more round. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.set('syncing');
        try {
          await this.pull();
          await this.push();
          this.set('synced');
        } catch (e) {
          console.warn('sync failed', e);
          this.set(navigator.onLine ? 'error' : 'offline');
        }
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async pull() {
    const d = await db();
    const firstSync = (await d.get('meta', 'cursor')) === undefined;
    let cursor = ((await d.get('meta', 'cursor')) as number | undefined) ?? 0;
    const changed = new Set<SyncedStore>();
    for (;;) {
      const res = await fetch(`api/sync?since=${cursor}`);
      if (!res.ok) throw new Error(`pull ${res.status}`);
      const page = (await res.json()) as { docs: RemoteDoc[]; cursor: number; more: boolean };
      for (const r of page.docs) {
        if (!SYNCED_STORES.includes(r.store)) continue;
        const local = (await d.get('meta', stampKey(r.store, r.id))) as number | undefined;
        if (!remoteWins(r.updated_at, local)) continue;
        let value: unknown;
        if (!r.deleted) {
          const text = r.blob ? await (await fetch(`api/blob?store=${r.store}&id=${encodeURIComponent(r.id)}`)).text() : r.json;
          value = JSON.parse(text ?? 'null');
        }
        const tx = d.transaction([r.store, 'meta'], 'readwrite');
        const st = tx.objectStore(r.store);
        if (r.deleted) await st.delete(r.id);
        else if (keyPathStores.has(r.store)) await st.put(value);
        else await st.put(value, r.id);
        await tx.objectStore('meta').put(r.updated_at, stampKey(r.store, r.id));
        await tx.objectStore('meta').delete(dirtyKey(r.store, r.id));
        await tx.done;
        changed.add(r.store);
      }
      const advanced = page.cursor !== cursor;
      cursor = page.cursor;
      if (!page.more || !advanced) break;
    }
    await d.put('meta', cursor, 'cursor');
    // First sync in this browser: anything only it has goes up (records the server
    // already had were just replaced by the server's copy above).
    if (firstSync) await this.markUnstampedDirty();
    if (changed.size) for (const l of this.remoteListeners) l(changed);
  }

  private async markUnstampedDirty() {
    const d = await db();
    let stamp = Date.now();
    for (const store of SYNCED_STORES) {
      const keys = (await d.getAllKeys(store)) as string[];
      for (const id of keys) {
        if ((await d.get('meta', stampKey(store, id))) !== undefined) continue;
        await d.put('meta', stamp++, stampKey(store, id));
        await d.put('meta', { store, id, deleted: false } satisfies Dirty, dirtyKey(store, id));
      }
    }
  }

  private async push() {
    const d = await db();
    const range = IDBKeyRange.bound('dirty:', 'dirty:￿');
    const dirty = (await d.getAll('meta', range)) as Dirty[];
    if (!dirty.length) return;
    const docs: { store: string; id: string; updated_at: number; deleted?: boolean; json?: string }[] = [];
    for (const x of dirty) {
      const updated_at = (await d.get('meta', stampKey(x.store, x.id))) as number;
      const value = x.deleted ? undefined : await d.get(x.store, x.id);
      // a record that vanished locally without a tombstone is pushed as a delete
      docs.push(value === undefined ? { store: x.store, id: x.id, updated_at, deleted: true } : { store: x.store, id: x.id, updated_at, json: JSON.stringify(value) });
    }
    for (const batch of batchBySize(docs)) {
      const res = await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs: batch }) });
      if (!res.ok) throw new Error(`push ${res.status}`);
      // clear the queue only for records that weren't written again meanwhile
      for (const doc of batch) {
        const now = await d.get('meta', stampKey(doc.store, doc.id));
        if (now === doc.updated_at) await d.delete('meta', dirtyKey(doc.store, doc.id));
      }
    }
  }
}

export const sync = new SyncEngine();
