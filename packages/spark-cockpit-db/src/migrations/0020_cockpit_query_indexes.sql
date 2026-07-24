-- Cockpit's workbench shell resolves the latest command activity for visible
-- sessions on every layout load. Keep the correlated latest-row lookups and
-- session filter index-backed as command history grows.
CREATE INDEX command_deliveries_command_updated_idx
  ON command_deliveries(command_id, updated_at DESC, id DESC);

CREATE INDEX mirrored_invocations_command_updated_idx
  ON mirrored_invocations(command_id, updated_at DESC, id DESC);

CREATE INDEX commands_assignment_session_updated_idx
  ON commands(
    CAST(json_extract(payload_json, '$.payload.target.sessionId') AS TEXT),
    updated_at DESC,
    created_at DESC,
    id DESC
  )
  WHERE kind = 'assignment.create.request' AND json_valid(payload_json);

-- Workspace-scoped event streams must not scan unrelated workspace traffic.
CREATE INDEX events_workspace_ingest_sequence_idx
  ON events(workspace_id, ingest_sequence);
