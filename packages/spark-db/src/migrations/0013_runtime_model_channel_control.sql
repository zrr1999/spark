CREATE TABLE runtime_model_control_projections (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_connections(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  projected_at TEXT NOT NULL
);

CREATE TABLE runtime_channel_control_projections (
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  projected_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, workspace_id)
);

CREATE INDEX runtime_channel_control_projections_workspace_idx
  ON runtime_channel_control_projections(workspace_id, projected_at);

CREATE TABLE runtime_ephemeral_secret_audit (
  request_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  browser_request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'provider.auth.api_key.set',
    'provider.auth.login.respond',
    'channel.configure'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'pending',
    'succeeded',
    'failed',
    'rejected',
    'disconnected',
    'timed_out'
  )),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX runtime_ephemeral_secret_audit_runtime_created_idx
  ON runtime_ephemeral_secret_audit(runtime_id, created_at);
