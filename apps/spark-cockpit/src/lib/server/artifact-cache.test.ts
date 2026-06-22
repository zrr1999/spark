import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/navia-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
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
    slug: "local-default",
    name: "Local default",
    runtimeWorkspaceBindingId,
    createdAt: now,
  });

  return { db, now, runtimeWorkspaceBindingId, workspace };
}

describe("artifact cache", () => {
  it("creates lazy preview cache metadata and writes inline previews when available", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "note",
          title: "Inline note",
          format: "markdown",
          source: "runtime",
          contentRef: { inlineMarkdown: "# Evidence\n" },
          provenance: { smoke: true },
          links: [],
        },
        createdAt: now,
      });

      const cache = ensureArtifactPreviewCache(db, artifactId, { cacheRoot, now });
      expect(cache.state).toBe("ready");
      expect(cache.previewStatus).toBe("ready");
      expect(cache.cachePath).toContain(cacheRoot);
      expect(readFileSync(cache.cachePath, "utf8")).toBe("# Evidence\n");

      const row = db
        .prepare(
          "SELECT state, is_preview AS isPreview FROM artifact_cache_blobs WHERE artifact_id = ?",
        )
        .get(artifactId) as { state: string; isPreview: number };
      expect(row).toEqual({ state: "ready", isPreview: 1 });
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("registers missing preview state for external runtime pointers", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "report",
          title: "Runtime report",
          format: "markdown",
          source: "runtime",
          contentRef: { runtimePathRef: `artifact://runtime/${artifactId}.md` },
          provenance: { smoke: true },
          links: [],
        },
        createdAt: now,
      });

      const cache = ensureArtifactPreviewCache(db, artifactId, { cacheRoot, now });
      expect(cache.state).toBe("missing");
      expect(cache.previewStatus).toBe("missing");
      expect(cache.sourceRef).toEqual({ runtimePathRef: `artifact://runtime/${artifactId}.md` });
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("marks blob-format artifacts as unsupported_binary without materializing inline content", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "screenshot",
          title: "Diagram capture",
          format: "blob",
          source: "runtime",
          contentRef: { runtimePathRef: `artifact://runtime/${artifactId}.png` },
          provenance: {},
          links: [],
        },
        createdAt: now,
      });

      const cache = ensureArtifactPreviewCache(db, artifactId, { cacheRoot, now });
      expect(cache.state).toBe("failed");
      expect(cache.previewStatus).toBe("unsupported_binary");
      expect(cache.error?.reason).toBe("unsupported_binary");
      // No file should be written for an unsupported binary preview.
      expect(() => readFileSync(cache.cachePath)).toThrow();
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("marks oversized inline previews as too_large and skips materialization", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");
    const huge = "x".repeat(MAX_PREVIEW_BYTES + 1024);

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "report",
          title: "Huge report",
          format: "markdown",
          source: "runtime",
          sizeBytes: huge.length,
          contentRef: { inlineMarkdown: huge },
          provenance: {},
          links: [],
        },
        createdAt: now,
      });

      const cache = ensureArtifactPreviewCache(db, artifactId, { cacheRoot, now });
      expect(cache.state).toBe("failed");
      expect(cache.previewStatus).toBe("too_large");
      expect(cache.error?.reason).toBe("too_large");
      expect(() => readFileSync(cache.cachePath)).toThrow();
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("readArtifactPreviewContent returns the cached body when ready", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "note",
          title: "Inline note",
          format: "markdown",
          source: "runtime",
          contentRef: { inlineMarkdown: "# Hello\n" },
          provenance: {},
          links: [],
        },
        createdAt: now,
      });

      const result = readArtifactPreviewContent(db, artifactId, { cacheRoot, now });
      expect(result.cache.previewStatus).toBe("ready");
      expect(result.body?.toString("utf8")).toBe("# Hello\n");
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("readArtifactPreviewContent does not return a body when preview is non-ready", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "report",
          title: "Runtime-only report",
          format: "markdown",
          source: "runtime",
          contentRef: { runtimePathRef: `artifact://runtime/${artifactId}.md` },
          provenance: {},
          links: [],
        },
        createdAt: now,
      });

      const result = readArtifactPreviewContent(db, artifactId, { cacheRoot, now });
      expect(result.cache.previewStatus).toBe("missing");
      expect(result.body).toBeUndefined();
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("readArtifactPreviewContent transitions to read_error when the cached file vanishes", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "navia-artifact-cache-"));
    const artifactId = createId("art");

    try {
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "note",
          title: "Inline note",
          format: "markdown",
          source: "runtime",
          contentRef: { inlineMarkdown: "# Hello\n" },
          provenance: {},
          links: [],
        },
        createdAt: now,
      });

      const cache = ensureArtifactPreviewCache(db, artifactId, { cacheRoot, now });
      expect(cache.previewStatus).toBe("ready");
      // Simulate the cached file getting cleaned up out-of-band.
      rmSync(cache.cachePath, { force: true });

      const result = readArtifactPreviewContent(db, artifactId, { cacheRoot, now });
      expect(result.cache.previewStatus).toBe("error");
      expect(result.cache.error?.reason).toBe("read_error");
      expect(result.body).toBeUndefined();
      // Touch the cache path so finally cleanup is happy if anything else
      // needs it; not strictly necessary for the assertion.
      writeFileSync(cache.cachePath, "leftover");
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
