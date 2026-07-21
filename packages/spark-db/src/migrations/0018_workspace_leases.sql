-- L3b.2: rename Cockpit origin-lease table (was ownership-framed).
-- Historical migrations keep the old CREATE TABLE name; this renames live DBs.

ALTER TABLE workspace_owner_bindings RENAME TO workspace_leases;

DROP INDEX IF EXISTS workspace_owner_bindings_one_active;
DROP INDEX IF EXISTS workspace_owner_bindings_one_active_per_runtime_binding;

CREATE UNIQUE INDEX workspace_leases_one_active
  ON workspace_leases(workspace_id)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX workspace_leases_one_active_per_runtime_binding
  ON workspace_leases(runtime_workspace_binding_id)
  WHERE ended_at IS NULL;
