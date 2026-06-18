CREATE TABLE runtime_message_receipts (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  replay_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (runtime_id, message_id, message_type)
);

CREATE INDEX runtime_message_receipts_runtime_seen_idx
  ON runtime_message_receipts(runtime_id, last_seen_at);
