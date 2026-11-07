CREATE TABLE accounts (
  uid TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES accounts(uid),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_uid ON sessions(uid);
CREATE TABLE books (
  hash TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  pages INTEGER NOT NULL CHECK (pages > 0)
);
CREATE TABLE progress (
  uid TEXT NOT NULL REFERENCES accounts(uid),
  hash TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page > 0),
  revision INTEGER NOT NULL,
  mutation TEXT NOT NULL,
  PRIMARY KEY (uid, hash)
);
