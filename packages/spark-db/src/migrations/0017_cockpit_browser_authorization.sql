-- Cockpit-wide browser access is a separate progressive layer from workspace grants.
CREATE TABLE cockpit_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX cockpit_access_tokens_state_idx
  ON cockpit_access_tokens(used_at, revoked_at, expires_at, created_at);
