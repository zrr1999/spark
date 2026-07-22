CREATE TABLE workspace_profile_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin', 'git')),
  profile_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  repo_url TEXT,
  source_path TEXT,
  commit_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX workspace_profile_sources_profile_idx
  ON workspace_profile_sources(profile_id, source_kind);

CREATE TABLE workspace_profile_git_access (
  id TEXT PRIMARY KEY,
  workspace_profile_source_id TEXT NOT NULL UNIQUE REFERENCES workspace_profile_sources(id) ON DELETE CASCADE,
  can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
  can_pull INTEGER NOT NULL CHECK (can_pull IN (0, 1)),
  can_push INTEGER NOT NULL CHECK (can_push IN (0, 1)),
  reason TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
