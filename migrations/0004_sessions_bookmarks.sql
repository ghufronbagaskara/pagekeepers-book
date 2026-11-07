CREATE TABLE reading_sessions (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES accounts(uid),
  hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  active_ms INTEGER NOT NULL CHECK (active_ms > 0),
  page_start INTEGER NOT NULL CHECK (page_start > 0),
  page_end INTEGER NOT NULL CHECK (page_end > 0)
);
CREATE INDEX reading_sessions_uid_time ON reading_sessions(uid, started_at);
CREATE TABLE bookmarks (
  uid TEXT NOT NULL REFERENCES accounts(uid),
  hash TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page > 0),
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (uid, hash, page)
);
