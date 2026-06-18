ALTER TABLE runtime_enrollment_tokens ADD COLUMN workspace_name TEXT;
ALTER TABLE runtime_enrollment_tokens ADD COLUMN workspace_slug TEXT;
ALTER TABLE runtime_enrollment_tokens ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX runtime_enrollment_tokens_workspace_idx
  ON runtime_enrollment_tokens(workspace_slug, workspace_id, created_runtime_id);
