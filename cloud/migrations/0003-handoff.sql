ALTER TABLE login_requests ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'writer';
CREATE TABLE IF NOT EXISTS cli_connections (
 token_id TEXT PRIMARY KEY REFERENCES tokens(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 device_name TEXT NOT NULL,
 verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 body_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
