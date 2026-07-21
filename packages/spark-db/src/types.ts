export interface SchemaMigrationsTable {
  version: string;
  name: string;
  applied_at: string;
}

export interface AppSettingsTable {
  key: string;
  value_json: string;
  updated_at: string;
}

export interface UsersTable {
  id: string;
  email: string | null;
  display_name: string;
  role: "owner" | "member";
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_secret_hash: string | null;
  user_agent_hash: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  workspace_id: string | null;
  refresh_token_hash: string | null;
  refresh_expires_at: string | null;
}

export interface WorkspaceAccessTokensTable {
  id: string;
  workspace_id: string;
  token_hash: string;
  label: string | null;
  created_by_user_id: string | null;
  created_by_runtime_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export interface CockpitAccessTokensTable {
  id: string;
  token_hash: string;
  label: string | null;
  created_by_user_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export interface WorkspacesTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectsTable {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "planned" | "running" | "blocked" | "completed" | "archived" | "cancelled";
  current_conclusion_artifact_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface ResourcesTable {
  id: string;
  workspace_id: string;
  kind: "repo" | "doc" | "url" | "file" | "secret_ref" | "tool" | "other";
  name: string;
  uri: string | null;
  status: "available" | "degraded" | "unavailable" | "archived";
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectResourcesTable {
  project_id: string;
  resource_id: string;
  role: string;
  created_at: string;
}

export interface AgentSpecsTable {
  id: string;
  workspace_id: string;
  name: string;
  source: "builtin" | "workspace" | "imported";
  status: "active" | "disabled" | "archived";
  description: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeConnectionsTable {
  id: string;
  installation_id: string | null;
  name: string;
  status: "online" | "offline" | "draining" | "disabled";
  protocol_version: string | null;
  capabilities_json: string;
  labels_json: string;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeTokensTable {
  id: string;
  runtime_id: string;
  token_hash: string;
  label: string | null;
  scopes_json: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface RuntimeEnrollmentTokensTable {
  id: string;
  token_hash: string;
  label: string | null;
  scopes_json: string;
  created_by_user_id: string | null;
  created_runtime_id: string | null;
  workspace_name: string | null;
  workspace_slug: string | null;
  workspace_id: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

export interface RuntimeDeviceAuthorizationsTable {
  id: string;
  device_code_hash: string;
  user_code_hash: string;
  installation_id: string;
  display_name: string;
  registration_json: string;
  scopes_json: string;
  created_at: string;
  expires_at: string;
  interval_seconds: number;
  last_polled_at: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  denied_by_user_id: string | null;
  denied_at: string | null;
  consumed_at: string | null;
  created_runtime_id: string | null;
}

export interface RuntimeSessionsTable {
  id: string;
  runtime_id: string;
  token_id: string | null;
  transport: "websocket";
  status: "connected" | "closed" | "stale";
  connected_at: string;
  last_seen_at: string;
  closed_at: string | null;
  close_reason: string | null;
  remote_addr_hash: string | null;
}

export interface RuntimeWorkspaceBindingsTable {
  id: string;
  runtime_id: string;
  local_workspace_key: string;
  local_path: string | null;
  display_name: string;
  status: "available" | "indexing" | "degraded" | "unavailable" | "archived";
  capabilities_json: string;
  diagnostics_json: string;
  last_snapshot_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeMessageReceiptsTable {
  id: string;
  runtime_id: string;
  message_id: string;
  message_type: string;
  first_seen_at: string;
  last_seen_at: string;
  replay_count: number;
}

export interface WorkspaceLeasesTable {
  id: string;
  workspace_id: string;
  runtime_workspace_binding_id: string;
  owner_mode: "primary";
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

export interface WorkspaceProfileSourcesTable {
  id: string;
  workspace_id: string;
  source_kind: "builtin" | "git";
  profile_id: string;
  profile_name: string;
  schema_version: string;
  repo_url: string | null;
  source_path: string | null;
  commit_hash: string | null;
  created_at: string;
}

export interface WorkspaceProfileGitAccessTable {
  id: string;
  workspace_profile_source_id: string;
  can_read: 0 | 1;
  can_pull: 0 | 1;
  can_push: 0 | 1;
  reason: string | null;
  checked_at: string;
  created_at: string;
  updated_at: string;
}

export interface CommandsTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  kind: string;
  title: string | null;
  payload_json: string;
  requested_by_user_id: string | null;
  idempotency_key: string | null;
  status: "queued" | "delivered" | "acked" | "rejected" | "cancelled" | "expired";
  created_at: string;
  updated_at: string;
}

export interface CommandDeliveriesTable {
  id: string;
  command_id: string;
  runtime_workspace_binding_id: string;
  status: "pending" | "sent" | "acked" | "rejected" | "cancelled" | "failed";
  attempt_count: number;
  last_attempt_at: string | null;
  acked_at: string | null;
  rejected_at: string | null;
  reject_code: string | null;
  reject_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface HumanRequestsTable {
  id: string;
  runtime_workspace_binding_id: string;
  workspace_id: string;
  project_id: string | null;
  runtime_request_id: string;
  kind: "ask_user" | "review" | "approval" | "blocker";
  title: string;
  prompt: string;
  questions_json: string;
  context_json: string;
  status: "pending" | "answered" | "cancelled" | "archived";
  created_at: string;
  updated_at: string;
}

export interface HumanResponsesTable {
  id: string;
  human_request_id: string;
  answered_by_user_id: string | null;
  answer_json: string;
  status: "recorded" | "delivering" | "acked" | "cancelled" | "failed";
  delivery_attempt_count: number;
  last_delivery_at: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxItemsTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  human_request_id: string | null;
  kind: "ask" | "review" | "approval" | "blocker" | "external_event";
  title: string;
  summary: string | null;
  urgency: "low" | "normal" | "high";
  status: "pending" | "processing" | "resolved" | "archived";
  resolved_as: string | null;
  next_reminder_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AsksTable {
  id: string;
  human_request_id: string;
  artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewsTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  human_request_id: string | null;
  subject_json: string;
  outcome: "accepted" | "rejected" | "changes_requested" | "cancelled" | null;
  status: "pending" | "resolved" | "archived";
  created_at: string;
  updated_at: string;
}

export interface TaskGraphSnapshotsTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  runtime_workspace_binding_id: string;
  runtime_snapshot_id: string;
  snapshot_version: number;
  payload_json: string;
  received_at: string;
}

export interface TaskGraphClustersTable {
  id: string;
  snapshot_id: string;
  workspace_id: string;
  project_id: string | null;
  runtime_cluster_id: string;
  name: string | null;
  title: string;
  status: string;
  sort_key: string | null;
  payload_json: string;
}

export interface TaskGraphTasksTable {
  id: string;
  snapshot_id: string;
  workspace_id: string;
  project_id: string | null;
  runtime_task_id: string;
  runtime_cluster_id: string | null;
  name: string | null;
  title: string;
  description: string | null;
  kind: string | null;
  status: string;
  agent_ref: string | null;
  input_artifact_ids_json: string;
  output_artifact_ids_json: string;
  run_ids_json: string;
  payload_json: string;
}

export interface TaskGraphDependenciesTable {
  id: string;
  snapshot_id: string;
  from_task_runtime_id: string;
  to_task_runtime_id: string;
  kind: string;
}

export interface MirroredInvocationsTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  runtime_workspace_binding_id: string;
  runtime_invocation_id: string;
  command_id: string | null;
  task_runtime_id: string | null;
  agent_name: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "lost";
  started_at: string | null;
  completed_at: string | null;
  terminal_reason: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export interface InvocationEventsTable {
  id: string;
  invocation_id: string;
  runtime_event_id: string | null;
  kind: string;
  sequence: number | null;
  payload_json: string;
  created_at: string;
}

export interface InvocationLogChunksTable {
  id: string;
  invocation_id: string;
  stream: "stdout" | "stderr" | "system" | "agent";
  sequence: number;
  content: string;
  created_at: string;
}

export interface ArtifactsTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  scope: "workspace" | "project";
  kind: string;
  title: string;
  format: "markdown" | "json" | "text" | "blob";
  source: "runtime" | "human" | "import" | "server";
  runtime_workspace_binding_id: string | null;
  invocation_id: string | null;
  human_request_id: string | null;
  hash: string | null;
  size_bytes: number | null;
  content_ref_json: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

export interface ArtifactLinksTable {
  id: string;
  artifact_id: string;
  target_kind: string;
  target_id: string;
  relation: string;
  created_at: string;
}

export interface ArtifactCacheBlobsTable {
  id: string;
  artifact_id: string;
  hash: string | null;
  size_bytes: number | null;
  mime: string | null;
  cache_path: string;
  source_ref_json: string;
  state: "missing" | "fetching" | "ready" | "failed" | "evicted";
  is_preview: 0 | 1;
  pin_reason: string | null;
  fetched_at: string | null;
  last_accessed_at: string | null;
  expires_at: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventsTable {
  id: string;
  ingest_sequence: number;
  workspace_id: string | null;
  project_id: string | null;
  actor_kind: "user" | "runtime" | "server";
  actor_id: string | null;
  kind: string;
  subject_kind: string | null;
  subject_id: string | null;
  payload_json: string;
  created_at: string;
}

export interface EventIngestSequenceTable {
  singleton: 1;
  value: number;
}

export interface SparkDatabase {
  schema_migrations: SchemaMigrationsTable;
  app_settings: AppSettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  workspace_access_tokens: WorkspaceAccessTokensTable;
  cockpit_access_tokens: CockpitAccessTokensTable;
  workspaces: WorkspacesTable;
  projects: ProjectsTable;
  resources: ResourcesTable;
  project_resources: ProjectResourcesTable;
  agent_specs: AgentSpecsTable;
  runtime_connections: RuntimeConnectionsTable;
  runtime_tokens: RuntimeTokensTable;
  runtime_enrollment_tokens: RuntimeEnrollmentTokensTable;
  runtime_device_authorizations: RuntimeDeviceAuthorizationsTable;
  runtime_sessions: RuntimeSessionsTable;
  runtime_workspace_bindings: RuntimeWorkspaceBindingsTable;
  runtime_message_receipts: RuntimeMessageReceiptsTable;
  workspace_leases: WorkspaceLeasesTable;
  workspace_profile_sources: WorkspaceProfileSourcesTable;
  workspace_profile_git_access: WorkspaceProfileGitAccessTable;
  commands: CommandsTable;
  command_deliveries: CommandDeliveriesTable;
  human_requests: HumanRequestsTable;
  human_responses: HumanResponsesTable;
  inbox_items: InboxItemsTable;
  asks: AsksTable;
  reviews: ReviewsTable;
  task_graph_snapshots: TaskGraphSnapshotsTable;
  task_graph_clusters: TaskGraphClustersTable;
  task_graph_tasks: TaskGraphTasksTable;
  task_graph_dependencies: TaskGraphDependenciesTable;
  mirrored_invocations: MirroredInvocationsTable;
  invocation_events: InvocationEventsTable;
  invocation_log_chunks: InvocationLogChunksTable;
  artifacts: ArtifactsTable;
  artifact_links: ArtifactLinksTable;
  artifact_cache_blobs: ArtifactCacheBlobsTable;
  events: EventsTable;
  event_ingest_sequence: EventIngestSequenceTable;
}
