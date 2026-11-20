-- Large records (rides with 1 Hz samples) are split into chunks here instead of
-- R2, so the backend needs nothing beyond D1. docs.blob holds the chunk key.
CREATE TABLE blob_chunks (
  key  TEXT    NOT NULL,
  seq  INTEGER NOT NULL,
  data TEXT    NOT NULL,
  PRIMARY KEY (key, seq)
);
