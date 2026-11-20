-- Chain tracker (ported from the standalone chain-tracker app). Its tables are
-- prefixed ct_ to stay apart from RideBox's. Strava tokens are RideBox's own
-- (strava_auth); nothing here holds them.
-- Durable records (formerly Google Sheet tabs). Timestamps are ISO 8601 UTC strings.
CREATE TABLE ct_bikes (
  bike_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE ct_chains (
  chain_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  retired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  start_miles REAL NOT NULL DEFAULT 0
);

CREATE TABLE ct_installs (
  install_id TEXT PRIMARY KEY,
  bike_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  link_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ct_lubes (
  lube_id TEXT PRIMARY KEY,
  bike_id TEXT NOT NULL,
  chain_id TEXT NOT NULL DEFAULT '',
  lubed_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ct_quicklinks (
  link_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  start_uses INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ct_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Ride cache pulled from Strava. Disposable: it can always be rebuilt.
CREATE TABLE ct_rides (
  activity_id INTEGER PRIMARY KEY,
  gear_id TEXT,
  start_date TEXT NOT NULL,
  distance_m REAL NOT NULL,
  moving_time_s INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  trainer INTEGER NOT NULL DEFAULT 0,
  -- Pull that last wrote this row; rides a pull didn't see are deleted when it finishes.
  pull_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ct_rides_start ON ct_rides(start_date);

-- Sync state (pull progress, last sync, rate-limit backoff). Never sent to the browser.
CREATE TABLE ct_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
