-- Session navigation must not scan and JSON-decode the complete workspace
-- event history. Materialize the daemon session route and index the activity
-- query used by Cockpit page hydration.
ALTER TABLE events ADD COLUMN session_id TEXT;

UPDATE events
SET session_id = COALESCE(
  json_extract(payload_json, '$.sessionId'),
  json_extract(payload_json, '$.view.sessionId'),
  json_extract(payload_json, '$.view.session.sessionId')
)
WHERE session_id IS NULL;

CREATE INDEX events_workspace_session_created_idx
  ON events(workspace_id, session_id, created_at)
  WHERE session_id IS NOT NULL;

-- Snapshot/import tooling can insert events without going through appendEvent.
-- Keep those rows queryable without forcing every producer to decode payloads.
CREATE TRIGGER events_assign_session_id_after_insert
AFTER INSERT ON events
WHEN NEW.session_id IS NULL
BEGIN
  UPDATE events
  SET session_id = COALESCE(
    json_extract(NEW.payload_json, '$.sessionId'),
    json_extract(NEW.payload_json, '$.view.sessionId'),
    json_extract(NEW.payload_json, '$.view.session.sessionId')
  )
  WHERE rowid = NEW.rowid;
END;
