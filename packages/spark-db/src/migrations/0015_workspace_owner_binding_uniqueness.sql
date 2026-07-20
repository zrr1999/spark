-- A daemon-owned directory may be projected into at most one active Cockpit
-- workspace. Historical bindings remain available through ended_at.
-- Normalize legacy duplicates deterministically before enforcing the rule:
-- the most recently started projection remains active.
WITH ranked AS (
  SELECT
    id,
    MAX(started_at) OVER (
      PARTITION BY runtime_workspace_binding_id
    ) AS latest_started_at,
    ROW_NUMBER() OVER (
      PARTITION BY runtime_workspace_binding_id
      ORDER BY started_at DESC, created_at DESC, id DESC
    ) AS position
  FROM workspace_owner_bindings
  WHERE ended_at IS NULL
)
UPDATE workspace_owner_bindings
SET ended_at = (
  SELECT latest_started_at
  FROM ranked
  WHERE ranked.id = workspace_owner_bindings.id
)
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX workspace_owner_bindings_one_active_per_runtime_binding
  ON workspace_owner_bindings(runtime_workspace_binding_id)
  WHERE ended_at IS NULL;
