-- Claude connector (worker/mcp).

-- OAuth state for @cloudflare/workers-oauth-provider: registered clients, grants
-- and tokens (stored only as hashes / encrypted by the library). The library
-- expects a KV namespace; worker/oauthKv.ts serves it from this table so the
-- backend still needs nothing beyond D1.
CREATE TABLE oauth_kv (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  expires_at INTEGER,          -- seconds since epoch; NULL = never
  metadata   TEXT              -- JSON, as KV key metadata
);
CREATE INDEX oauth_kv_expires ON oauth_kv (expires_at);

-- A light copy of each RideBox ride for the connector: the record without its
-- 1 Hz samples, plus the power series that levels and the FTP estimate need.
-- Disposable: rebuilt from docs whenever a ride's updated_at changes.
CREATE TABLE ride_cache (
  id         TEXT    PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  json       TEXT    NOT NULL
);

-- Every change Claude makes through the connector, with the record before and
-- after, so it can be listed and undone.
CREATE TABLE mcp_changes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,   -- ms since epoch
  tool    TEXT    NOT NULL,
  summary TEXT    NOT NULL,
  store   TEXT    NOT NULL,
  doc_id  TEXT    NOT NULL,
  before  TEXT,               -- JSON, NULL when the record was created
  after   TEXT,               -- JSON, NULL when the record was deleted
  undone  INTEGER NOT NULL DEFAULT 0
);
