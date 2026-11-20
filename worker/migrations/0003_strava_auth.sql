-- Strava sign-in held by the Worker: the app's client secret is a Worker
-- secret and these tokens never leave the server (single row, the owner's).
CREATE TABLE strava_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT    NOT NULL,
  refresh_token TEXT    NOT NULL,
  expires_at    INTEGER NOT NULL, -- seconds since epoch
  athlete_name  TEXT,
  scope         TEXT    NOT NULL DEFAULT ''
);
