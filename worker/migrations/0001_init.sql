-- Synced documents. One row per record in the browser's IndexedDB stores.
-- RideBox is single-user (Cloudflare Access only lets the owner in), so there is no user column.
CREATE TABLE docs (
  store      TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,           -- client write stamp (ms); the newest write wins
  deleted    INTEGER NOT NULL DEFAULT 0, -- tombstone so deletes reach other browsers
  blob       TEXT,                       -- R2 key when the JSON is too big for a row (rides)
  json       TEXT,
  server_at  INTEGER NOT NULL,           -- server clock (ms), the pull cursor
  PRIMARY KEY (store, id)
);
CREATE INDEX docs_server_at ON docs (server_at);

-- Claude coach usage per UTC day, for the daily request cap.
CREATE TABLE coach_usage (
  day           TEXT    PRIMARY KEY,
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);
