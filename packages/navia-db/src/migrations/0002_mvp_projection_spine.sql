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

CREATE INDEX projects_workspace_status_idx ON projects(workspace_id, status);

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

CREATE INDEX resources_workspace_kind_idx ON resources(workspace_id, kind);

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

CREATE INDEX agent_specs_workspace_status_idx ON agent_specs(workspace_id, status);

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

CREATE INDEX commands_workspace_status_idx ON commands(workspace_id, status, created_at);

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

CREATE INDEX command_deliveries_binding_status_idx ON command_deliveries(runtime_workspace_binding_id, status);

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

CREATE INDEX human_requests_workspace_status_idx ON human_requests(workspace_id, status, created_at);

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

CREATE INDEX human_responses_status_idx ON human_responses(status, last_delivery_at);

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

CREATE INDEX inbox_items_workspace_status_idx ON inbox_items(workspace_id, status, urgency, created_at);

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

CREATE INDEX task_graph_snapshots_project_version_idx ON task_graph_snapshots(project_id, snapshot_version);

CREATE TABLE task_graph_threads (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES task_graph_snapshots(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  runtime_thread_id TEXT NOT NULL,
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
  runtime_thread_id TEXT,
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

CREATE INDEX mirrored_invocations_workspace_status_idx ON mirrored_invocations(workspace_id, status, updated_at);

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

CREATE INDEX artifacts_workspace_kind_idx ON artifacts(workspace_id, kind, created_at);
CREATE INDEX artifacts_project_kind_idx ON artifacts(project_id, kind, created_at);

CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  human_request_id TEXT NOT NULL UNIQUE REFERENCES human_requests(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
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
