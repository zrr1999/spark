CREATE TABLE runtime_enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_runtime_id TEXT REFERENCES runtime_connections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX runtime_enrollment_tokens_state_idx
  ON runtime_enrollment_tokens(revoked_at, used_at, expires_at, created_at);
