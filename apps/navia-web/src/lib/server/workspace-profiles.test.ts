import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
import { createId, runtimeProtocolVersion } from "@zendev-lab/navia-protocol";
import { gitCommand } from "@zendev-lab/navia-system";
import { createWorkspaceWithOwnerBinding } from "./projection-services";
import {
  builtinFreshWorkspaceProfile,
  exportWorkspaceProfileToml,
  loadWorkspaceProfileFromDirectory,
  parseGitHubProfileUrl,
  recordWorkspaceProfileGitAccess,
  resolveWorkspaceProfileInputs,
} from "./workspace-profiles";

describe("workspace profiles", () => {
  it("parses GitHub profile repository and tree URLs", () => {
    expect(parseGitHubProfileUrl("https://github.com/navia-dev/profiles")).toEqual({
      cloneUrl: "https://github.com/navia-dev/profiles.git",
      webUrl: "https://github.com/navia-dev/profiles",
      ref: null,
      sourcePath: null,
    });

    expect(parseGitHubProfileUrl("https://github.com/navia-dev/profiles/tree/main/paddle")).toEqual(
      {
        cloneUrl: "https://github.com/navia-dev/profiles.git",
        webUrl: "https://github.com/navia-dev/profiles",
        ref: "main",
        sourcePath: "paddle",
      },
    );

    expect(() => parseGitHubProfileUrl("https://example.com/navia/profiles")).toThrow(
      "Profile must be an https://github.com/... URL.",
    );
  });

  it("loads a TOML profile repo with settings, agents, and repos", () => {
    const profileDir = createProfileRepo();
    try {
      const profile = loadWorkspaceProfileFromDirectory(profileDir);

      expect(profile.profile).toMatchObject({
        id: "paddle-dev",
        name: "PaddlePaddle Dev",
      });
      expect(profile.settings.defaultModel).toBe("gpt-5-codex");
      expect(profile.agents[0]).toMatchObject({
        name: "reviewer",
        source: "imported",
        status: "active",
        description: "Reviews Paddle changes",
        config: {
          id: "reviewer",
          role: "quality-reviewer",
          tools: ["read", "grep"],
          model: {
            model: "openai-codex/gpt-5.5",
            thinking: "high",
          },
          skills: {
            enable: ["paddle-review"],
            disable: ["web-write"],
          },
          prompts: {
            files: ["AGENTS.md", "TOOLS.md"],
            contents: {
              "AGENTS.md": expect.stringContaining("Review Paddle changes"),
              "TOOLS.md": expect.stringContaining("Prefer read-only tools"),
            },
          },
          roleRef: "role:paddle-reviewer",
          instructions: "Check tests and evidence.",
        },
      });
      expect(profile.resources[0]).toMatchObject({
        config: {
          id: "paddle",
          provider: "github",
          defaultBranch: "develop",
          roles: ["primary"],
          checkout: {
            mode: "shared-root",
            worktree: "per-session",
          },
          sync: {
            remote: "origin",
            ref: "develop",
            autoFetch: false,
          },
          permissions: {
            canRead: true,
            canPush: false,
          },
        },
        name: "Paddle",
        kind: "repo",
        uri: "https://github.com/PaddlePaddle/Paddle",
        status: "available",
      });
      expect(profile.source.kind).toBe("git");
      expect(profile.source.repoUrl).toBe("git@example.test:paddle/profile.git");
      expect(profile.source.commitHash).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("requires declared profile inputs before creating a workspace", () => {
    const fresh = builtinFreshWorkspaceProfile();

    expect(() => resolveWorkspaceProfileInputs(fresh, {})).toThrow(
      "Missing required profile input: workspaceName",
    );
    expect(resolveWorkspaceProfileInputs(fresh, { workspaceName: "Demo Space" })).toMatchObject({
      workspaceName: "Demo Space",
      workspaceSlug: "demo-space",
    });
  });

  it("creates a workspace from a git profile and records imported config", () => {
    const profileDir = createProfileRepo();
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    try {
      const profile = loadWorkspaceProfileFromDirectory(profileDir);
      const resolved = resolveWorkspaceProfileInputs(profile, {
        workspaceName: "Paddle Workspace",
        workspaceSlug: "paddle-workspace",
      });

      const workspace = createWorkspaceWithOwnerBinding(db, {
        slug: resolved.workspaceSlug,
        name: resolved.workspaceName,
        runtimeWorkspaceBindingId,
        settings: { ...profile.settings, profileInputs: resolved.values },
        profileSource: {
          sourceKind: profile.source.kind,
          profileId: profile.profile.id,
          profileName: profile.profile.name,
          schemaVersion: profile.schemaVersion,
          repoUrl: profile.source.repoUrl,
          sourcePath: profile.source.path,
          commitHash: profile.source.commitHash,
        },
        agentSpecs: profile.agents,
        resources: profile.resources,
        createdAt: now,
      });

      const source = db
        .prepare(
          `SELECT profile_id AS profileId, source_kind AS sourceKind, repo_url AS repoUrl, commit_hash AS commitHash
           FROM workspace_profile_sources
           WHERE workspace_id = ?`,
        )
        .get(workspace.id) as {
        profileId: string;
        sourceKind: string;
        repoUrl: string;
        commitHash: string;
      };
      const resourceCount = db
        .prepare("SELECT COUNT(*) AS count FROM resources WHERE workspace_id = ?")
        .get(workspace.id) as { count: number };
      const agentCount = db
        .prepare("SELECT COUNT(*) AS count FROM agent_specs WHERE workspace_id = ?")
        .get(workspace.id) as { count: number };
      const importedResource = db
        .prepare("SELECT config_json AS configJson FROM resources WHERE workspace_id = ? LIMIT 1")
        .get(workspace.id) as { configJson: string };
      const importedAgent = db
        .prepare("SELECT config_json AS configJson FROM agent_specs WHERE workspace_id = ? LIMIT 1")
        .get(workspace.id) as { configJson: string };

      expect(source).toMatchObject({
        profileId: "paddle-dev",
        sourceKind: "git",
        repoUrl: "git@example.test:paddle/profile.git",
      });
      expect(source.commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(resourceCount.count).toBe(1);
      expect(agentCount.count).toBe(1);
      expect(JSON.parse(importedResource.configJson)).toMatchObject({
        id: "paddle",
        checkout: { worktree: "per-session" },
        sync: { ref: "develop" },
      });
      expect(JSON.parse(importedAgent.configJson)).toMatchObject({
        id: "reviewer",
        prompts: {
          contents: {
            "AGENTS.md": expect.stringContaining("Review Paddle changes"),
          },
        },
      });
    } finally {
      db.close();
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("records the latest git access status for a bound profile", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "fresh",
      name: "Fresh",
      runtimeWorkspaceBindingId,
      profileSource: {
        sourceKind: "builtin",
        profileId: "builtin:fresh",
        profileName: "Fresh workspace",
        schemaVersion: "navia.profile/v1",
      },
      createdAt: now,
    });
    const source = db
      .prepare("SELECT id FROM workspace_profile_sources WHERE workspace_id = ?")
      .get(workspace.id) as { id: string };

    const first = recordWorkspaceProfileGitAccess(db, {
      workspaceProfileSourceId: source.id,
      canRead: true,
      canPull: true,
      canPush: false,
      reason: "push denied",
      checkedAt: now,
    });
    const second = recordWorkspaceProfileGitAccess(db, {
      workspaceProfileSourceId: source.id,
      canRead: true,
      canPull: true,
      canPush: true,
      checkedAt: "2026-05-22T00:01:00.000Z",
    });
    const row = db
      .prepare(
        `SELECT can_read AS canRead, can_pull AS canPull, can_push AS canPush, reason, checked_at AS checkedAt
         FROM workspace_profile_git_access
         WHERE workspace_profile_source_id = ?`,
      )
      .get(source.id) as {
      canRead: 0 | 1;
      canPull: 0 | 1;
      canPush: 0 | 1;
      reason: string | null;
      checkedAt: string;
    };

    expect(second.id).toBe(first.id);
    expect(row).toEqual({
      canRead: 1,
      canPull: 1,
      canPush: 1,
      reason: null,
      checkedAt: "2026-05-22T00:01:00.000Z",
    });
    db.close();
  });

  it("exports only workspace profile config files", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "exported",
      name: "Exported",
      runtimeWorkspaceBindingId,
      settings: { defaultModel: "gpt-5-codex" },
      agentSpecs: [
        {
          name: "reviewer",
          source: "workspace",
          status: "active",
          description: "Review evidence",
          config: { id: "reviewer", roleRef: "role:reviewer" },
        },
      ],
      resources: [
        {
          kind: "repo",
          name: "Paddle",
          uri: "https://github.com/PaddlePaddle/Paddle",
          status: "available",
          config: { id: "paddle", defaultBranch: "develop" },
        },
      ],
      createdAt: now,
    });

    const files = exportWorkspaceProfileToml(db, workspace.id);

    expect([...files.keys()].sort((left, right) => left.localeCompare(right))).toEqual([
      "agents/reviewer/agent.toml",
      "repos/paddle.toml",
      "settings.toml",
    ]);
    expect(files.get("settings.toml")).toContain('schemaVersion = "navia.profile/v1"');
    expect(files.get("agents/reviewer/agent.toml")).toContain('id = "reviewer"');
    expect(files.get("repos/paddle.toml")).toContain('defaultBranch = "develop"');
    expect([...files.keys()].some((path) => path.includes("artifacts"))).toBe(false);
    expect([...files.values()].join("\n")).not.toContain("runtime_workspace_binding");
    db.close();
  });
});

function createProfileRepo() {
  const dir = mkdtempSync(join(tmpdir(), "navia-profile-"));
  mkdirSync(join(dir, "agents"));
  mkdirSync(join(dir, "repos"));
  writeFileSync(
    join(dir, "settings.toml"),
    `schemaVersion = "navia.profile/v1"

[profile]
id = "paddle-dev"
name = "PaddlePaddle Dev"
description = "Paddle development workspace profile"

[inputs.workspaceName]
type = "string"
required = true

[inputs.workspaceSlug]
type = "string"
required = true
defaultFrom = "workspaceName"

[settings]
defaultModel = "gpt-5-codex"
trustPolicy = "restricted"
`,
  );
  mkdirSync(join(dir, "agents/reviewer"));
  writeFileSync(
    join(dir, "agents/reviewer/agent.toml"),
    `id = "reviewer"
name = "reviewer"
description = "Reviews Paddle changes"
source = "imported"
status = "active"
role = "quality-reviewer"
tools = ["read", "grep"]

[model]
model = "openai-codex/gpt-5.5"
thinking = "high"

[skills]
enable = ["paddle-review"]
disable = ["web-write"]

[prompts]
files = ["AGENTS.md", "TOOLS.md"]

[config]
roleRef = "role:paddle-reviewer"
instructions = "Check tests and evidence."
`,
  );
  writeFileSync(join(dir, "agents/reviewer/AGENTS.md"), "Review Paddle changes with evidence.\n");
  writeFileSync(
    join(dir, "agents/reviewer/TOOLS.md"),
    "Prefer read-only tools until asked to edit.\n",
  );
  writeFileSync(
    join(dir, "repos/paddle.toml"),
    `id = "paddle"
name = "Paddle"
kind = "repo"
status = "available"
uri = "https://github.com/PaddlePaddle/Paddle"
provider = "github"
defaultBranch = "develop"
roles = ["primary"]

[checkout]
mode = "shared-root"
worktree = "per-session"

[sync]
remote = "origin"
ref = "develop"
autoFetch = false

[permissions]
canRead = true
canPush = false

[config]
owner = "PaddlePaddle"
`,
  );
  const git = gitCommand();
  execFileSync(git, ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync(git, ["remote", "add", "origin", "git@example.test:paddle/profile.git"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync(git, ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync(
    git,
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Navia Test",
      "-c",
      "user.email=navia@example.test",
      "commit",
      "--no-gpg-sign",
      "-m",
      "Initial profile",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Navia Test",
        GIT_AUTHOR_EMAIL: "navia@example.test",
        GIT_COMMITTER_NAME: "Navia Test",
        GIT_COMMITTER_EMAIL: "navia@example.test",
      },
      stdio: "ignore",
    },
  );
  return dir;
}

function setupRuntimeBinding() {
  const db = openMemoryDatabase();
  migrate(db);

  const now = "2026-05-22T00:00:00.000Z";
  const runtimeId = createId("rt");
  const runtimeWorkspaceBindingId = createId("rtwb");

  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);

  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
  ).run(runtimeWorkspaceBindingId, runtimeId, now, now);

  return { db, runtimeWorkspaceBindingId, now };
}
