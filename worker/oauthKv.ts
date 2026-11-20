// A KV namespace served from D1, for @cloudflare/workers-oauth-provider.
//
// The OAuth library stores clients, grants and tokens through the Workers KV
// API (get / put / delete / list). RideBox keeps everything in D1, so this
// implements the part of that API the library uses on the oauth_kv table.
// Expired rows read as missing and are swept by the cron (purgeExpiredKv).

type GetType = 'text' | 'json';
interface PutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}
interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}
interface ListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class D1Kv {
  constructor(
    private db: D1Database,
    private clock: () => number = nowSec,
  ) {}

  async get(key: string, opts?: GetType | { type?: GetType }): Promise<unknown> {
    const type = typeof opts === 'string' ? opts : (opts?.type ?? 'text');
    const row = await this.db
      .prepare('SELECT value FROM oauth_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
      .bind(key, this.clock())
      .first<{ value: string }>();
    if (!row) return null;
    return type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async getWithMetadata(key: string, opts?: GetType | { type?: GetType }): Promise<{ value: unknown; metadata: unknown }> {
    const type = typeof opts === 'string' ? opts : (opts?.type ?? 'text');
    const row = await this.db
      .prepare('SELECT value, metadata FROM oauth_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
      .bind(key, this.clock())
      .first<{ value: string; metadata: string | null }>();
    if (!row) return { value: null, metadata: null };
    return { value: type === 'json' ? JSON.parse(row.value) : row.value, metadata: row.metadata ? JSON.parse(row.metadata) : null };
  }

  async put(key: string, value: string, opts: PutOptions = {}): Promise<void> {
    if (typeof value !== 'string') throw new TypeError('D1Kv.put stores strings only');
    const expires = opts.expiration ?? (opts.expirationTtl != null ? this.clock() + opts.expirationTtl : null);
    await this.db
      .prepare(
        `INSERT INTO oauth_kv (key, value, expires_at, metadata) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, metadata = excluded.metadata`,
      )
      .bind(key, value, expires, opts.metadata === undefined ? null : JSON.stringify(opts.metadata))
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_kv WHERE key = ?').bind(key).run();
  }

  /** Keys in order; the cursor is the last key returned. */
  async list(opts: ListOptions = {}): Promise<{ keys: ListKey[]; list_complete: boolean; cursor?: string }> {
    const prefix = opts.prefix ?? '';
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 1000));
    const after = opts.cursor ?? '';
    const { results } = await this.db
      .prepare(
        `SELECT key, expires_at, metadata FROM oauth_kv
         WHERE substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`,
      )
      .bind(prefix.length, prefix, after, this.clock(), limit + 1)
      .all<{ key: string; expires_at: number | null; metadata: string | null }>();
    const more = results.length > limit;
    const page = results.slice(0, limit);
    const keys = page.map((r) => {
      const k: ListKey = { name: r.key };
      if (r.expires_at != null) k.expiration = r.expires_at;
      if (r.metadata) k.metadata = JSON.parse(r.metadata);
      return k;
    });
    return more ? { keys, list_complete: false, cursor: page[page.length - 1].key } : { keys, list_complete: true };
  }
}

/** Deletes expired rows (run from the cron). */
export async function purgeExpiredKv(db: D1Database, now = nowSec()) {
  await db.prepare('DELETE FROM oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run();
}
