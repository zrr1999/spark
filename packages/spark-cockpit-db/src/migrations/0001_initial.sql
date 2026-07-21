CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX users_email_unique
  ON users(email)
  WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runtime_connections (
  id TEXT PRIMARY KEY,
  installation_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'draining', 'disabled')),
  protocol_version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  labels_json TEXT NOT NULL DEFAULT '{}',
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX runtime_connections_installation_unique
  ON runtime_connections(installation_id)
  WHERE installation_id IS NOT NULL;

CREATE TABLE runtime_tokens (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES runtime_tokens(id) ON DELETE SET NULL,
  transport TEXT NOT NULL CHECK (transport IN ('websocket')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'closed', 'stale')),
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  remote_addr_hash TEXT
);

CREATE INDEX runtime_sessions_runtime_status_idx
  ON runtime_sessions(runtime_id, status);

CREATE TABLE runtime_workspace_bindings (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  local_workspace_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'indexing', 'degraded', 'unavailable', 'archived')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  last_snapshot_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (runtime_id, local_workspace_key)
);

CREATE INDEX runtime_workspace_bindings_runtime_status_idx
  ON runtime_workspace_bindings(runtime_id, status);

CREATE TABLE workspace_owner_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  owner_mode TEXT NOT NULL CHECK (owner_mode IN ('primary')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX workspace_owner_bindings_one_active
  ON workspace_owner_bindings(workspace_id)
  WHERE ended_at IS NULL;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'runtime', 'server')),
  actor_id TEXT,
  kind TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX events_workspace_created_idx ON events(workspace_id, created_at);
CREATE INDEX events_project_created_idx ON events(project_id, created_at);
