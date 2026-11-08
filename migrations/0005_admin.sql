ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
UPDATE accounts SET role = 'admin' WHERE uid IN (SELECT id FROM auth_user WHERE email = 'ghufronbagaskara08@gmail.com');
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
CREATE INDEX audit_log_action ON audit_log(action, id);
