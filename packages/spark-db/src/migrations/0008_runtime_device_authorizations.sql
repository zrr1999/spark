CREATE TABLE runtime_device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  registration_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
  last_polled_at TEXT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  denied_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  denied_at TEXT,
  consumed_at TEXT,
  created_runtime_id TEXT REFERENCES runtime_connections(id) ON DELETE SET NULL
);

CREATE INDEX runtime_device_authorizations_state_idx
  ON runtime_device_authorizations(expires_at, approved_at, denied_at, consumed_at, created_at);

CREATE INDEX runtime_device_authorizations_installation_pending_idx
  ON runtime_device_authorizations(installation_id, expires_at)
  WHERE approved_at IS NULL AND denied_at IS NULL AND consumed_at IS NULL;
