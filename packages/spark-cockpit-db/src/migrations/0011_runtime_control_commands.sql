CREATE TABLE runtime_control_commands (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT,
  payload_json TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'accepted', 'succeeded', 'failed', 'rejected', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  reject_code TEXT,
  reject_message TEXT,
  result_message_id TEXT,
  result_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'daemon' AND workspace_id IS NULL AND runtime_workspace_binding_id IS NULL AND project_id IS NULL)
    OR
    (scope = 'workspace' AND workspace_id IS NOT NULL AND runtime_workspace_binding_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX runtime_control_commands_idempotency_unique
  ON runtime_control_commands(runtime_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX runtime_control_commands_runtime_status_idx
  ON runtime_control_commands(runtime_id, status, created_at);
