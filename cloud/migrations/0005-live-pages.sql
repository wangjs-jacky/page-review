CREATE TABLE IF NOT EXISTS live_pages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS live_page_saves (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  page_id TEXT NOT NULL,
  marker TEXT NOT NULL,
  PRIMARY KEY (workspace_id, page_id, marker)
);
CREATE INDEX IF NOT EXISTS annotations_live_page
  ON annotations(workspace_id, json_extract(body_json,'$.note.pageId'), updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
