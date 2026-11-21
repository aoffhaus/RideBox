// Cross-browser sync: every browser keeps its own IndexedDB copy and trades
// changes with D1 here. The newest write (by client stamp) wins per record;
// deletes travel as tombstones. Big records (rides with 1 Hz samples) are split
// into chunks in the blob_chunks table.

export interface SyncEnv {
  DB: D1Database;
}

/** D1 rows top out around 2 MB; stay well under. */
export const CHUNK = 500_000;

export async function putBlob(db: D1Database, key: string, body: string) {
  const stmts = [db.prepare('DELETE FROM blob_chunks WHERE key = ?').bind(key)];
  for (let i = 0, seq = 0; i < body.length; i += CHUNK, seq++) {
    stmts.push(db.prepare('INSERT INTO blob_chunks (key, seq, data) VALUES (?, ?, ?)').bind(key, seq, body.slice(i, i + CHUNK)));
  }
  await db.batch(stmts);
}
export async function getBlob(db: D1Database, key: string): Promise<string | null> {
  const { results } = await db.prepare('SELECT data FROM blob_chunks WHERE key = ? ORDER BY seq').bind(key).all<{ data: string }>();
  return results.length ? results.map((r) => r.data).join('') : null;
}
export async function deleteBlob(db: D1Database, key: string) {
  await db.prepare('DELETE FROM blob_chunks WHERE key = ?').bind(key).run();
}

export const SYNCED_STORES = ['workouts', 'rides', 'kv', 'calendar', 'plans', 'strava_acts', 'strava_streams'] as const;
export type SyncedStoreName = (typeof SYNCED_STORES)[number];
const STORES = new Set<string>(SYNCED_STORES);

/** Records above this size are chunked instead of stored in one row. */
export const BLOB_THRESHOLD = 200_000;
const PAGE = 500;

export interface DocIn {
  store: string;
  id: string;
  updated_at: number;
  deleted?: boolean;
  /** the record, JSON-encoded (absent for deletes) */
  json?: string;
}

export interface DocOut {
  store: string;
  id: string;
  updated_at: number;
  deleted: boolean;
  /** true: fetch the body from /api/blob */
  blob: boolean;
  json: string | null;
  server_at: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export function validDoc(d: unknown): d is DocIn {
  if (!d || typeof d !== 'object') return false;
  const x = d as DocIn;
  return (
    typeof x.store === 'string' &&
    STORES.has(x.store) &&
    typeof x.id === 'string' &&
    x.id.length > 0 &&
    x.id.length <= 200 &&
    typeof x.updated_at === 'number' &&
    Number.isFinite(x.updated_at) &&
    (x.deleted ? true : typeof x.json === 'string')
  );
}

/** GET /api/sync?since=<server_at> → changes at or after the cursor (callers dedupe). */
export async function pull(env: SyncEnv, url: URL): Promise<Response> {
  const since = Number(url.searchParams.get('since') ?? 0) || 0;
  const { results } = await env.DB.prepare(
    'SELECT store, id, updated_at, deleted, blob, json, server_at FROM docs WHERE server_at >= ? ORDER BY server_at LIMIT ?',
  )
    .bind(since, PAGE)
    .all<{ store: string; id: string; updated_at: number; deleted: number; blob: string | null; json: string | null; server_at: number }>();
  const docs: DocOut[] = results.map((r) => ({
    store: r.store,
    id: r.id,
    updated_at: r.updated_at,
    deleted: !!r.deleted,
    blob: !!r.blob,
    json: r.blob ? null : r.json,
    server_at: r.server_at,
  }));
  const cursor = docs.length ? docs[docs.length - 1].server_at : since;
  return json({ docs, cursor, more: docs.length === PAGE });
}

/**
 * Upserts one record unless the server already has the same or a newer write
 * (by client stamp). Browsers pick the change up on their next pull. Returns
 * false when the stored copy was newer and nothing changed.
 */
export async function writeDoc(db: D1Database, d: DocIn): Promise<boolean> {
  const prev = await db.prepare('SELECT updated_at, blob FROM docs WHERE store = ? AND id = ?').bind(d.store, d.id).first<{ updated_at: number; blob: string | null }>();
  // the server has the same or a newer version; the client will pick it up on its next pull
  if (prev && prev.updated_at >= d.updated_at) return false;
  let blob: string | null = null;
  let body: string | null = d.deleted ? null : d.json!;
  if (body && body.length > BLOB_THRESHOLD) {
    blob = `docs/${d.store}/${encodeURIComponent(d.id)}/${d.updated_at}`;
    await putBlob(db, blob, body);
    body = null;
  }
  const res = await db
    .prepare(
      `INSERT INTO docs (store, id, updated_at, deleted, blob, json, server_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (store, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted,
         blob = excluded.blob, json = excluded.json, server_at = excluded.server_at
       WHERE excluded.updated_at > docs.updated_at`,
    )
    .bind(d.store, d.id, d.updated_at, d.deleted ? 1 : 0, blob, body, Date.now())
    .run();
  // a concurrent newer write won: drop the chunks we just wrote rather than orphan them
  if (blob && res.meta?.changes === 0) {
    await deleteBlob(db, blob);
    return false;
  }
  if (prev?.blob && prev.blob !== blob) await deleteBlob(db, prev.blob);
  return true;
}

/** POST /api/sync {docs:[…]} → upserts each doc unless the server already has a newer write. */
export async function push(env: SyncEnv, req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { docs?: unknown[] } | null;
  if (!body || !Array.isArray(body.docs)) return json({ error: 'Expected {docs: [...]}' }, 400);
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const d of body.docs) {
    if (!validDoc(d)) {
      rejected.push(String((d as DocIn)?.id ?? '?'));
      continue;
    }
    await writeDoc(env.DB, d);
    accepted.push(d.id);
  }
  return json({ accepted, rejected });
}

/** GET /api/blob?store=&id= → a large record's JSON. */
export async function blob(env: SyncEnv, url: URL): Promise<Response> {
  const store = url.searchParams.get('store') ?? '';
  const id = url.searchParams.get('id') ?? '';
  const row = await env.DB.prepare('SELECT blob FROM docs WHERE store = ? AND id = ?').bind(store, id).first<{ blob: string | null }>();
  if (!row?.blob) return json({ error: 'Not found' }, 404);
  const body = await getBlob(env.DB, row.blob);
  if (body == null) return json({ error: 'Not found' }, 404);
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
