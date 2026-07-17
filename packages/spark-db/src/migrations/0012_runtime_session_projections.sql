ALTER TABLE runtime_control_commands ADD COLUMN session_id TEXT;

CREATE INDEX runtime_control_commands_session_idx
  ON runtime_control_commands(runtime_id, session_id, created_at)
  WHERE session_id IS NOT NULL;

CREATE TABLE runtime_session_projections (
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT REFERENCES runtime_workspace_bindings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'archived')),
  record_json TEXT NOT NULL,
  snapshot_json TEXT,
  snapshot_total_messages INTEGER NOT NULL DEFAULT 0,
  snapshot_loaded_messages INTEGER NOT NULL DEFAULT 0,
  snapshot_hidden_messages INTEGER NOT NULL DEFAULT 0,
  projected_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, session_id),
  CHECK (
    (scope = 'daemon' AND workspace_id IS NULL AND runtime_workspace_binding_id IS NULL)
    OR
    (scope = 'workspace' AND workspace_id IS NOT NULL AND runtime_workspace_binding_id IS NOT NULL)
  )
);

CREATE INDEX runtime_session_projections_scope_status_idx
  ON runtime_session_projections(runtime_id, scope, workspace_id, status, projected_at);

CREATE TABLE runtime_invocation_projections (
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  runtime_invocation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT REFERENCES runtime_workspace_bindings(id) ON DELETE CASCADE,
  command_id TEXT REFERENCES runtime_control_commands(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost')),
  event_cursor INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  terminal_reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, runtime_invocation_id),
  FOREIGN KEY (runtime_id, session_id)
    REFERENCES runtime_session_projections(runtime_id, session_id) ON DELETE CASCADE,
  CHECK (
    (scope = 'daemon' AND workspace_id IS NULL AND runtime_workspace_binding_id IS NULL)
    OR
    (scope = 'workspace' AND workspace_id IS NOT NULL AND runtime_workspace_binding_id IS NOT NULL)
  )
);

CREATE INDEX runtime_invocation_projections_session_status_idx
  ON runtime_invocation_projections(runtime_id, session_id, status, updated_at);

CREATE TABLE runtime_invocation_event_projections (
  runtime_id TEXT NOT NULL,
  runtime_invocation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, runtime_invocation_id, sequence),
  FOREIGN KEY (runtime_id, runtime_invocation_id)
    REFERENCES runtime_invocation_projections(runtime_id, runtime_invocation_id) ON DELETE CASCADE
);

CREATE INDEX runtime_invocation_event_projections_cursor_idx
  ON runtime_invocation_event_projections(runtime_id, runtime_invocation_id, sequence);
