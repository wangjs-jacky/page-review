PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('writer','reader')),
 name TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_read_at TEXT
);
CREATE TABLE IF NOT EXISTS assets (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), id TEXT NOT NULL, object_key TEXT NOT NULL,
 mime TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY (workspace_id,id)
);
CREATE TABLE IF NOT EXISTS annotations (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), id TEXT NOT NULL,
 revision INTEGER NOT NULL, body_json TEXT NOT NULL, search_text TEXT NOT NULL,
 domain TEXT NOT NULL, feedback TEXT, updated_at TEXT NOT NULL, deleted_at TEXT, mutation_id TEXT NOT NULL,
 PRIMARY KEY (workspace_id,id)
);
CREATE INDEX IF NOT EXISTS annotations_workspace_updated ON annotations(workspace_id,updated_at,id);
CREATE TABLE IF NOT EXISTS operations (
 workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,request_id)
);
