import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { createWorkspaceWithOwnerBinding, recordArtifactProjection } from "./projection-services";
import {
  ensureArtifactPreviewCache,
  MAX_PREVIEW_BYTES,
  readArtifactPreviewContent,
} from "./artifact-cache";

function setupWorkspace() {
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

  const workspace = createWorkspaceWithOwnerBinding(db, {
    name: "Cache Workspace",
    slug: "cache-workspace",
    runtimeWorkspaceBindingId,
  });

  return { db, workspace, runtimeWorkspaceBindingId };
}

describe("artifact preview cache", () => {
  it("materializes inline text previews under the Cockpit cache root", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId: "artifact-inline",
          scope: "workspace",
          kind: "document",
          title: "Inline preview",
          format: "markdown",
          source: "runtime",
          contentRef: { inlineMarkdown: "# Hello\n" },
          provenance: { producer: "task" },
          links: [],
        },
      });

      const cache = ensureArtifactPreviewCache(db, "artifact-inline", { cacheRoot });
      expect(cache.previewStatus).toBe("ready");
      expect(readFileSync(cache.cachePath, "utf8")).toBe("# Hello\n");

      const result = readArtifactPreviewContent(db, "artifact-inline", { cacheRoot });
      expect(result.body?.toString("utf8")).toBe("# Hello\n");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("records oversized previews as explicit too_large states", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId: "artifact-large",
          scope: "workspace",
          kind: "document",
          title: "Large preview",
          format: "text",
          source: "runtime",
          contentRef: { inlineText: "x".repeat(MAX_PREVIEW_BYTES + 1) },
          provenance: { producer: "task" },
          links: [],
        },
      });

      const cache = ensureArtifactPreviewCache(db, "artifact-large", { cacheRoot });
      expect(cache.previewStatus).toBe("too_large");
      expect(cache.error?.reason).toBe("too_large");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
