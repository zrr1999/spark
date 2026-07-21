-- Browser authority is a workspace grant, never a Cockpit-wide grant.
-- Legacy sessions remain local-only because workspace_id is NULL.
ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN refresh_expires_at TEXT;

CREATE UNIQUE INDEX sessions_refresh_token_unique
  ON sessions(refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

CREATE INDEX sessions_workspace_active_idx
  ON sessions(workspace_id, expires_at, revoked_at);

CREATE TABLE workspace_access_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_runtime_id TEXT REFERENCES runtime_connections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX workspace_access_tokens_workspace_state_idx
  ON workspace_access_tokens(workspace_id, used_at, revoked_at, expires_at, created_at);
