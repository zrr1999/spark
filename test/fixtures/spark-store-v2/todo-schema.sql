PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO schema_meta (key, value)
VALUES ('spark_store_v2_todo_schema_version', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('task', 'session')),
  owner_ref TEXT NOT NULL,
  project_ref TEXT,
  task_ref TEXT,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled', 'deleted')),
  notes_json TEXT NOT NULL DEFAULT '[]',
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  display_number INTEGER CHECK (display_number IS NULL OR display_number > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_kind, owner_ref, id),
  CHECK (
    (owner_kind = 'task' AND task_ref = owner_ref) OR
    (owner_kind = 'session' AND task_ref IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_todo_items_owner_status
  ON todo_items (owner_kind, owner_ref, status);

CREATE INDEX IF NOT EXISTS idx_todo_items_task_status
  ON todo_items (task_ref, status);

CREATE INDEX IF NOT EXISTS idx_todo_items_project_status
  ON todo_items (project_ref, status);

CREATE INDEX IF NOT EXISTS idx_todo_items_updated_at
  ON todo_items (updated_at);
