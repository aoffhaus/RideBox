// A D1Database for tests, on Node's built-in SQLite (in memory), with the
// RideBox migrations applied. Covers the parts of the D1 API the Worker uses:
// prepare().bind().first() / all() / run().

const MIGRATIONS = ['0001_init.sql', '0002_blob_chunks.sql', '0003_strava_auth.sql', '0004_chain_tracker.sql', '0005_mcp.sql'];

type Row = Record<string, unknown>;

export async function fakeD1(): Promise<D1Database> {
  // Node built-ins via process.getBuiltinModule: keeps Vite from rewriting the
  // import and the Worker's type check (no Node types) out of it
  const node = (globalThis as unknown as { process: { getBuiltinModule: (id: string) => any } }).process;
  const sqlite = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (p: string) => any };
  const fs = node.getBuiltinModule('node:fs') as { readFileSync: (p: URL, enc: string) => string };
  const db = new sqlite.DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(fs.readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8'));
  const plain = (r: Row | undefined) => (r ? { ...r } : null);
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async <T>() => plain(db.prepare(sql).get(...args)) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...args).map((r: Row) => ({ ...r })) as T[] }),
    run: async () => {
      db.prepare(sql).run(...args);
      return { success: true };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => db.exec(sql),
  } as unknown as D1Database;
}
