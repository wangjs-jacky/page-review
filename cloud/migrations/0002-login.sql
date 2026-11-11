ALTER TABLE tokens ADD COLUMN expires_at TEXT;
CREATE TABLE IF NOT EXISTS users (
  subject TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_requests (
  id TEXT PRIMARY KEY,
  callback TEXT NOT NULL,
  client_state TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  subject TEXT,
  name TEXT,
  session_expires_at TEXT,
  code_hash TEXT UNIQUE,
  consumed_at TEXT
);
