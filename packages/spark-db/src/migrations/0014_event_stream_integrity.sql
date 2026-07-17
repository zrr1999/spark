-- Persist every protocol-supported invocation stream. The previous CHECK only
-- accepted the original process-log streams, so INSERT OR IGNORE silently
-- discarded assistant/tool chunks.
ALTER TABLE invocation_log_chunks RENAME TO invocation_log_chunks_legacy;

CREATE TABLE invocation_log_chunks (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES mirrored_invocations(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (
    stream IN ('stdout', 'stderr', 'system', 'agent', 'assistant', 'tool')
  ),
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (invocation_id, stream, sequence)
);

INSERT INTO invocation_log_chunks
  (id, invocation_id, stream, sequence, content, created_at)
SELECT id, invocation_id, stream, sequence, content, created_at
FROM invocation_log_chunks_legacy;

DROP TABLE invocation_log_chunks_legacy;

-- Event timestamps and UUIDs are not a safe cursor: a later insert can have
-- the same millisecond timestamp and a lexicographically smaller UUID. Keep a
-- database-owned monotonic ingest sequence while retaining the legacy fields
-- for old browser cursors.
ALTER TABLE events ADD COLUMN ingest_sequence INTEGER;

UPDATE events
SET ingest_sequence = rowid;

CREATE UNIQUE INDEX events_ingest_sequence_unique ON events(ingest_sequence);

CREATE TABLE event_ingest_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
);

INSERT INTO event_ingest_sequence (singleton, value)
SELECT 1, COALESCE(MAX(ingest_sequence), 0)
FROM events;

-- Keep direct SQL inserts used by snapshot/import tooling safe as well. The
-- normal appendEvent path supplies ingest_sequence explicitly.
CREATE TRIGGER events_assign_ingest_sequence_after_insert
AFTER INSERT ON events
WHEN NEW.ingest_sequence IS NULL
BEGIN
  UPDATE event_ingest_sequence
  SET value = value + 1
  WHERE singleton = 1;

  UPDATE events
  SET ingest_sequence = (
    SELECT value FROM event_ingest_sequence WHERE singleton = 1
  )
  WHERE rowid = NEW.rowid;
END;

-- Snapshot/import paths may preserve an explicit sequence. Advance the
-- allocator so the next ordinary insert remains strictly newer.
CREATE TRIGGER events_advance_ingest_sequence_after_insert
AFTER INSERT ON events
WHEN NEW.ingest_sequence IS NOT NULL
BEGIN
  UPDATE event_ingest_sequence
  SET value = MAX(value, NEW.ingest_sequence)
  WHERE singleton = 1;
END;
