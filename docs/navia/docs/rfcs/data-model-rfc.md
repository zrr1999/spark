# RFC: Navia v0.1 SQLite data model

Status: selected for v0.1 development
Date: 2026-05-21

## Summary

Navia v0.1 stores communication, projections, audit, sessions, and artifact-cache metadata in SQLite. Spark-owned truth remains outside the server in `.spark` stores and `@zendev-lab/pi-artifacts`; `packages/navia-runner` bridges task execution into Spark runtime primitives while Navia's SQLite projection cache mirrors task graphs, invocations, asks/reviews, and artifacts for the cockpit.

This RFC freezes the first concrete SQLite schema shape so development can start with explicit migrations instead of ad-hoc tables.

## Global conventions

- **Driver:** Node 26 native `node:sqlite`.
- **Query layer:** Kysely with a thin repo-owned `node:sqlite` adapter/dialect.
- **Migrations:** explicit SQL files under `packages/db/src/migrations`.
- **Pragmas on open:** `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`.
- **IDs:** `TEXT PRIMARY KEY` with stable prefixes and dashless UUID entropy.
- **Timestamps:** UTC ISO-8601 `TEXT`, named `created_at`, `updated_at`, etc.
- **Booleans:** `INTEGER NOT NULL DEFAULT 0/1`.
- **Enums:** `TEXT` plus `CHECK (...)` constraints for stable v0.1 lifecycle values.
- **JSON:** JSON encoded as `TEXT`, validated with Zod at boundaries. Use SQLite JSON functions later only where helpful.
- **Deletes:** prefer soft/archive state for product records; hard delete only for cache blobs, sessions, expired tokens, and explicit maintenance.
- **Events:** append-only except explicit migration/repair operations.

## Table groups

| Group                      | Tables                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Migrations/config          | `schema_migrations`, `app_settings`                                                                                   |
| Local auth                 | `users`, `sessions`                                                                                                   |
| Workspace/project          | `workspaces`, `projects`, `resources`, `project_resources`, `agent_specs`                                             |
| Runner connection/protocol | `runtime_connections`, `runtime_tokens`, `runtime_sessions`, `runtime_workspace_bindings`, `workspace_owner_bindings` |
| Commands/delivery          | `commands`, `command_deliveries`                                                                                      |
| Human interaction          | `human_requests`, `human_responses`, `inbox_items`, `asks`, `reviews`                                                 |
| Task graph projections     | `task_graph_snapshots`, `task_graph_clusters`, `task_graph_tasks`, `task_graph_dependencies`                          |
| Invocation/run projections | `mirrored_invocations`, `invocation_events`, `invocation_log_chunks`                                                  |
| Artifacts/cache            | `artifacts`, `artifact_links`, `artifact_cache_blobs`                                                                 |
| Audit/events               | `events`                                                                                                              |

## Core SQL sketch

The exact migration may split formatting or add helper indexes, but the first migration should preserve these columns and constraints.

### Migrations/config

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Use `app_settings` for local setup state, cache config, and feature flags. Do not use it as an untyped dumping ground for domain records.

### Local auth

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX users_email_unique
  ON users(email)
  WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
```

v0.1 uses local-first owner setup. Hosted/team auth can extend `users` later without changing protocol tables.

### Workspace/project

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'blocked', 'completed', 'archived', 'cancelled')),
  current_conclusion_artifact_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('repo', 'doc', 'url', 'file', 'secret_ref', 'tool', 'other')),
  name TEXT NOT NULL,
  uri TEXT,
  status TEXT NOT NULL CHECK (status IN ('available', 'degraded', 'unavailable', 'archived')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_resources (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'context',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, resource_id)
);

CREATE TABLE agent_specs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin', 'workspace', 'imported')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
  description TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
```

Workspace resources, agent specs, and workspace artifacts can exist before any project.

### Runner connection/protocol

```sql
CREATE TABLE runtime_connections (
  id TEXT PRIMARY KEY,
  installation_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'draining', 'disabled')),
  protocol_version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  labels_json TEXT NOT NULL DEFAULT '{}',
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX runtime_connections_installation_unique
  ON runtime_connections(installation_id)
  WHERE installation_id IS NOT NULL;

CREATE TABLE runtime_tokens (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES runtime_tokens(id) ON DELETE SET NULL,
  transport TEXT NOT NULL CHECK (transport IN ('websocket')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'closed', 'stale')),
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  remote_addr_hash TEXT
);

CREATE TABLE runtime_workspace_bindings (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  local_workspace_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'indexing', 'degraded', 'unavailable', 'archived')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  last_snapshot_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (runtime_id, local_workspace_key)
);

CREATE TABLE workspace_owner_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  owner_mode TEXT NOT NULL CHECK (owner_mode IN ('primary')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX workspace_owner_bindings_one_active
  ON workspace_owner_bindings(workspace_id)
  WHERE ended_at IS NULL;
```

v0.1 never routes workspace commands or human responses to non-owning bindings.

### Commands/delivery

```sql
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'acked', 'rejected', 'cancelled', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX commands_idempotency_unique
  ON commands(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE command_deliveries (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'acked', 'rejected', 'cancelled', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  acked_at TEXT,
  rejected_at TEXT,
  reject_code TEXT,
  reject_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Command lifecycle is communication state. Runner invocation lifecycle is mirrored separately.

### Human interaction

```sql
CREATE TABLE human_requests (
  id TEXT PRIMARY KEY,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  runtime_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ask_user', 'review', 'approval', 'blocker')),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  questions_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (runtime_workspace_binding_id, runtime_request_id)
);

CREATE TABLE human_responses (
  id TEXT PRIMARY KEY,
  human_request_id TEXT NOT NULL REFERENCES human_requests(id) ON DELETE CASCADE,
  answered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  answer_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'delivering', 'acked', 'cancelled', 'failed')),
  delivery_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_delivery_at TEXT,
  acked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  human_request_id TEXT REFERENCES human_requests(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'review', 'approval', 'blocker', 'external_event')),
  title TEXT NOT NULL,
  summary TEXT,
  urgency TEXT NOT NULL CHECK (urgency IN ('low', 'normal', 'high')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'resolved', 'archived')),
  resolved_as TEXT,
  next_reminder_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  human_request_id TEXT NOT NULL UNIQUE REFERENCES human_requests(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  human_request_id TEXT REFERENCES human_requests(id) ON DELETE SET NULL,
  subject_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT CHECK (outcome IN ('accepted', 'rejected', 'changes_requested', 'cancelled')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Human decisions wait indefinitely. Time passing may update reminders/badges, never answers/cancels automatically.

### Task graph projections

```sql
CREATE TABLE task_graph_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  runtime_snapshot_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (runtime_workspace_binding_id, runtime_snapshot_id)
);

CREATE TABLE task_graph_clusters (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES task_graph_snapshots(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  runtime_cluster_id TEXT NOT NULL,
  name TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  sort_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE task_graph_tasks (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES task_graph_snapshots(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  runtime_task_id TEXT NOT NULL,
  runtime_cluster_id TEXT,
  name TEXT,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT,
  status TEXT NOT NULL,
  agent_ref TEXT,
  input_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  output_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE task_graph_dependencies (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES task_graph_snapshots(id) ON DELETE CASCADE,
  from_task_runtime_id TEXT NOT NULL,
  to_task_runtime_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'depends_on'
);
```

Snapshot ingestion writes the raw snapshot, deletes/replaces normalized rows for that snapshot/project projection in one transaction, and appends an event.

### Invocation/run projections

```sql
CREATE TABLE mirrored_invocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  runtime_workspace_binding_id TEXT NOT NULL REFERENCES runtime_workspace_bindings(id) ON DELETE RESTRICT,
  runtime_invocation_id TEXT NOT NULL,
  command_id TEXT REFERENCES commands(id) ON DELETE SET NULL,
  task_runtime_id TEXT,
  agent_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost')),
  started_at TEXT,
  completed_at TEXT,
  terminal_reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (runtime_workspace_binding_id, runtime_invocation_id)
);

CREATE TABLE invocation_events (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES mirrored_invocations(id) ON DELETE CASCADE,
  runtime_event_id TEXT,
  kind TEXT NOT NULL,
  sequence INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX invocation_events_runtime_event_unique
  ON invocation_events(invocation_id, runtime_event_id)
  WHERE runtime_event_id IS NOT NULL;

CREATE TABLE invocation_log_chunks (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES mirrored_invocations(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system', 'agent')),
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (invocation_id, stream, sequence)
);
```

Retries create/report new invocations. Terminal invocation evidence is not rewritten except explicit repair/migration.

### Artifacts/cache

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'project')),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'json', 'text', 'blob')),
  source TEXT NOT NULL CHECK (source IN ('runtime', 'human', 'import', 'server')),
  runtime_workspace_binding_id TEXT REFERENCES runtime_workspace_bindings(id) ON DELETE SET NULL,
  invocation_id TEXT REFERENCES mirrored_invocations(id) ON DELETE SET NULL,
  human_request_id TEXT REFERENCES human_requests(id) ON DELETE SET NULL,
  hash TEXT,
  size_bytes INTEGER,
  content_ref_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifact_links (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifact_cache_blobs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  hash TEXT,
  size_bytes INTEGER,
  mime TEXT,
  cache_path TEXT NOT NULL,
  source_ref_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('missing', 'fetching', 'ready', 'failed', 'evicted')),
  is_preview INTEGER NOT NULL DEFAULT 0,
  pin_reason TEXT,
  fetched_at TEXT,
  last_accessed_at TEXT,
  expires_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX artifact_cache_blobs_eviction_idx
  ON artifact_cache_blobs(is_preview, pin_reason, last_accessed_at, expires_at, size_bytes);
```

`artifact_cache_blobs.cache_path` must stay under the XDG server artifact cache, normally `${XDG_CACHE_HOME:-~/.cache}/navia/server/artifacts`. Cleanup may remove cached files and mark rows `evicted`; it never deletes canonical runner content.

### Audit/events

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'runtime', 'server')),
  actor_id TEXT,
  kind TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX events_workspace_created_idx ON events(workspace_id, created_at);
CREATE INDEX events_project_created_idx ON events(project_id, created_at);
```

Events are append-only product/communication/audit records. Do not use them as the only query surface for normal UI.

## Required indexes

The first migration should include indexes for the main UI and protocol paths:

```sql
CREATE INDEX projects_workspace_status_idx ON projects(workspace_id, status);
CREATE INDEX resources_workspace_kind_idx ON resources(workspace_id, kind);
CREATE INDEX agent_specs_workspace_status_idx ON agent_specs(workspace_id, status);
CREATE INDEX runtime_sessions_runtime_status_idx ON runtime_sessions(runtime_id, status);
CREATE INDEX runtime_workspace_bindings_runtime_status_idx ON runtime_workspace_bindings(runtime_id, status);
CREATE INDEX commands_workspace_status_idx ON commands(workspace_id, status, created_at);
CREATE INDEX command_deliveries_binding_status_idx ON command_deliveries(runtime_workspace_binding_id, status);
CREATE INDEX human_requests_workspace_status_idx ON human_requests(workspace_id, status, created_at);
CREATE INDEX human_responses_status_idx ON human_responses(status, last_delivery_at);
CREATE INDEX inbox_items_workspace_status_idx ON inbox_items(workspace_id, status, urgency, created_at);
CREATE INDEX task_graph_snapshots_project_version_idx ON task_graph_snapshots(project_id, snapshot_version);
CREATE INDEX mirrored_invocations_workspace_status_idx ON mirrored_invocations(workspace_id, status, updated_at);
CREATE INDEX artifacts_workspace_kind_idx ON artifacts(workspace_id, kind, created_at);
CREATE INDEX artifacts_project_kind_idx ON artifacts(project_id, kind, created_at);
```

## Transaction rules

- Workspace creation + owner binding selection is one transaction.
- Runner registration with an existing installation id converges in one transaction.
- Human response creation + inbox resolution + response delivery state update is one transaction.
- Task graph snapshot ingestion + normalized projection replacement + event append is one transaction.
- Invocation terminal update + event/log/artifact linkage is one transaction where practical.
- Cache row state and filesystem writes use a two-phase pattern: create/fetching row, write temp file, validate hash/size, atomic rename, mark ready.

## First development migration

`0001_initial.sql` should create all tables above, even if some UI surfaces are stubbed initially. This avoids early churn around FK targets and lets protocol fixtures test realistic persistence.

If implementation pressure is high, code can first exercise this subset:

1. `schema_migrations`, `app_settings`
2. `users`, `sessions`
3. `workspaces`
4. `runtime_connections`, `runtime_tokens`, `runtime_sessions`, `runtime_workspace_bindings`, `workspace_owner_bindings`
5. `events`

But the migration should still include the full v0.1 skeleton.
