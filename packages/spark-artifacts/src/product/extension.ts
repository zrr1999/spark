import { Type } from "typebox";
import type { SparkHostAPI, ToolConfig, ToolRenderComponent } from "@zendev-lab/spark-core";
import {
  PRODUCT_ARTIFACT_KINDS,
  applyWorktreeToPrBody,
  attachPrWorktree,
  defaultProductArtifactStore,
  isProductArtifactBody,
  isProductArtifactKind,
  issueBodyFromSnapshot,
  parseForgeUrl,
  prBodyFromSnapshot,
  removePrWorktree,
  syncForgeIssue,
  syncForgePr,
  type PreviewArtifactBody,
  type PreviewContentFormat,
  type ProductArtifact,
  type ProductArtifactKind,
  type ProductArtifactRef,
  type PrArtifactBody,
} from "./index.ts";

export interface PiProductArtifactsExtensionApi {
  registerTool(config: ToolConfig): void;
}

type ProductArtifactAction =
  | "create"
  | "update"
  | "list"
  | "read"
  | "sync"
  | "attach_worktree"
  | "remove_worktree"
  | "open_preview";

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [
      this.text.length > width ? `${this.text.slice(0, Math.max(0, width - 1))}…` : this.text,
    ];
  }
}

const PRODUCT_KIND_DESCRIPTION =
  "Product artifact kind is one of: issue (forge-tracked issue), pr (forge pull/merge request; prefer worktree), preview (md/mdx/html deliverable with continuous progress updates).";

const PRODUCT_PROMPT_GUIDELINES = [
  "Use artifact for product-facing ISSUE / PR / preview only. Internal evidence (document/record/trace/knowledge) uses the evidence tool.",
  "When producing a webpage, MDX, or Markdown deliverable, create a preview artifact and keep updating it as work progresses — do not leave progress only in chat or local files.",
  "When working on a PR artifact, attach and use its git worktree; do not mutate the main working tree by default.",
  "Sync ISSUE/PR state from GitHub (gh) or GitLab (glab) with action=sync so Cockpit stays accurate.",
  PRODUCT_KIND_DESCRIPTION,
];

export function registerProductArtifactTool(pi: PiProductArtifactsExtensionApi): void {
  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description:
      "Create, update, list, read, sync, or attach worktrees for product artifacts: issue, pr, and preview.",
    promptGuidelines: PRODUCT_PROMPT_GUIDELINES,
    parameters: Type.Object({
      action: Type.String({
        description:
          "create | update | list | read | sync | attach_worktree | remove_worktree | open_preview",
      }),
      artifactRef: Type.Optional(
        Type.String({ description: "Product artifact ref (artifact:…)." }),
      ),
      kind: Type.Optional(
        Type.String({
          description: "issue | pr | preview. " + PRODUCT_KIND_DESCRIPTION,
        }),
      ),
      title: Type.Optional(Type.String({ description: "Title for create/update." })),
      body: Type.Optional(Type.Any({ description: "Typed body for create/update." })),
      url: Type.Optional(Type.String({ description: "Forge issue/PR URL for create/sync." })),
      forge: Type.Optional(Type.String({ description: "github | gitlab" })),
      repo: Type.Optional(Type.String({ description: "owner/repo or GitLab path" })),
      number: Type.Optional(Type.Number({ description: "Issue or PR number" })),
      content: Type.Optional(Type.String({ description: "Preview content for create/update." })),
      format: Type.Optional(Type.String({ description: "Preview format: md | mdx | html" })),
      updateMode: Type.Optional(
        Type.String({ description: "Preview update mode: replace | append. Default replace." }),
      ),
      progress: Type.Optional(
        Type.Any({ description: "Preview progress: { label?, percent?, stage? }" }),
      ),
      force: Type.Optional(Type.Boolean({ description: "Force worktree remove." })),
      limit: Type.Optional(Type.Number({ description: "Max rows for list. Default 20." })),
    }),
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const target = typeof args.artifactRef === "string" ? args.artifactRef : undefined;
      const text = ["artifact", `action=${action}`, target].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requireCwd(ctx, "artifact");
      const store = defaultProductArtifactStore(cwd);
      const action = normalizeAction(params.action);

      if (action === "list") {
        const limit = normalizeLimit(params.limit, 20);
        const kind = normalizeOptionalKind(params.kind);
        const artifacts = await store.list({ kind });
        const newest = artifacts.slice().reverse().slice(0, limit);
        const lines = [
          `Product artifacts: ${artifacts.length}${newest.length < artifacts.length ? ` (showing ${newest.length})` : ""}`,
          ...newest.map((artifact) => renderListLine(artifact)),
        ];
        if (newest.length === 0) lines.push("- No product artifacts.");
        return toolResult(action, lines.join("\n"), {
          count: artifacts.length,
          artifacts: newest.map(compactSummary),
        });
      }

      if (action === "read" || action === "open_preview") {
        const ref = normalizeRef(params.artifactRef, "artifactRef");
        const artifact = await store.get(ref);
        if (action === "open_preview" && artifact.kind !== "preview") {
          throw new Error("open_preview requires a preview artifact");
        }
        return toolResult(action, renderDetail(artifact), { artifact: compactDetail(artifact) });
      }

      if (action === "create") {
        const created = await createProductArtifact(store, cwd, params);
        return toolResult(action, `Created ${created.ref} [${created.kind}] ${created.title}`, {
          changed: true,
          refs: { artifactRef: created.ref },
          artifact: compactDetail(created),
        });
      }

      if (action === "update") {
        const ref = normalizeRef(params.artifactRef, "artifactRef");
        const existing = await store.get(ref);
        const updated = await updateProductArtifact(store, existing, params);
        return toolResult(action, `Updated ${updated.ref} [${updated.kind}] ${updated.title}`, {
          changed: true,
          refs: { artifactRef: updated.ref },
          artifact: compactDetail(updated),
        });
      }

      if (action === "sync") {
        const synced = await syncProductArtifact(store, cwd, params);
        return toolResult(action, `Synced ${synced.ref} [${synced.kind}] ${synced.title}`, {
          changed: true,
          refs: { artifactRef: synced.ref },
          artifact: compactDetail(synced),
        });
      }

      if (action === "attach_worktree") {
        const ref = normalizeRef(params.artifactRef, "artifactRef");
        const existing = await store.get(ref);
        if (existing.kind !== "pr" || existing.body.kind !== "pr") {
          throw new Error("attach_worktree requires a pr artifact");
        }
        const attached = await attachPrWorktree({
          cwd,
          forge: existing.body.forge,
          repo: existing.body.repo,
          number: existing.body.number,
          headRef: existing.body.headRef,
          baseRef: existing.body.baseRef,
        });
        const body = applyWorktreeToPrBody(existing.body, attached);
        const updated = await store.update(ref, { body });
        const statusLine =
          attached.worktreeStatus === "attached"
            ? `Attached worktree ${attached.worktreePath}`
            : `Worktree attach ${attached.worktreeStatus}: ${attached.worktreeError ?? "unknown error"}`;
        return toolResult(action, `${statusLine} for ${updated.ref}`, {
          changed: true,
          refs: { artifactRef: updated.ref },
          worktreePath: attached.worktreePath,
          worktreeStatus: attached.worktreeStatus,
          artifact: compactDetail(updated),
        });
      }

      // remove_worktree
      const ref = normalizeRef(params.artifactRef, "artifactRef");
      const existing = await store.get(ref);
      if (existing.kind !== "pr" || existing.body.kind !== "pr") {
        throw new Error("remove_worktree requires a pr artifact");
      }
      if (!existing.body.worktreePath) {
        throw new Error("pr artifact has no worktreePath");
      }
      const removed = await removePrWorktree({
        cwd,
        worktreePath: existing.body.worktreePath,
        force: params.force === true,
      });
      const body: PrArtifactBody = {
        ...existing.body,
        worktreeStatus: removed.worktreeStatus,
        worktreeError: removed.worktreeError,
        worktreePath: removed.worktreeStatus === "removed" ? undefined : existing.body.worktreePath,
      };
      const updated = await store.update(ref, { body });
      return toolResult(action, `Worktree ${removed.worktreeStatus} for ${updated.ref}`, {
        changed: true,
        refs: { artifactRef: updated.ref },
        worktreeStatus: removed.worktreeStatus,
        artifact: compactDetail(updated),
      });
    },
  });
}

export function registerSparkProductArtifactTools(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("spark-artifacts product tool requires registerTool");
  registerProductArtifactTool({ registerTool: (config) => pi.registerTool?.(config) });
}

async function createProductArtifact(
  store: ReturnType<typeof defaultProductArtifactStore>,
  cwd: string,
  params: Record<string, unknown>,
): Promise<ProductArtifact> {
  const kind = normalizeKind(params.kind, "kind");
  if (kind === "preview") {
    const format = normalizePreviewFormat(params.format);
    const content = typeof params.content === "string" ? params.content : "";
    const title = normalizeRequiredString(params.title ?? "Preview", "title");
    const body: PreviewArtifactBody = {
      schemaVersion: 1,
      kind: "preview",
      format,
      content,
      version: 1,
      progress: normalizeProgress(params.progress),
    };
    return store.put({ kind, title, format: format === "html" ? "html" : "mdx", body });
  }

  const fromUrl = typeof params.url === "string" ? parseForgeUrl(params.url) : undefined;
  const number = normalizePositiveInt(params.number ?? fromUrl?.number, "number");
  const forge = normalizeForge(params.forge ?? fromUrl?.forge);
  const repo =
    typeof params.repo === "string" && params.repo.trim() ? params.repo.trim() : fromUrl?.repo;
  if (kind === "issue") {
    const snapshot = await syncForgeIssue({ cwd, forge, repo, number });
    const body = issueBodyFromSnapshot(snapshot);
    const title = normalizeRequiredString(params.title ?? body.title, "title");
    return store.put({ kind, title, format: "json", body });
  }

  const snapshot = await syncForgePr({ cwd, forge, repo, number });
  let body = prBodyFromSnapshot(snapshot);
  const title = normalizeRequiredString(params.title ?? body.title, "title");
  const created = await store.put({ kind: "pr", title, format: "json", body });
  // PR create prefers attaching a worktree immediately.
  const attached = await attachPrWorktree({
    cwd,
    forge: body.forge,
    repo: body.repo,
    number: body.number,
    headRef: body.headRef,
    baseRef: body.baseRef,
  });
  body = applyWorktreeToPrBody(body, attached);
  return store.update(created.ref, { body });
}

async function updateProductArtifact(
  store: ReturnType<typeof defaultProductArtifactStore>,
  existing: ProductArtifact,
  params: Record<string, unknown>,
): Promise<ProductArtifact> {
  if (existing.kind === "preview" && existing.body.kind === "preview") {
    const mode = params.updateMode === "append" ? "append" : "replace";
    const nextContent =
      typeof params.content === "string"
        ? mode === "append"
          ? `${existing.body.content}${params.content}`
          : params.content
        : existing.body.content;
    const format = normalizePreviewFormat(params.format ?? existing.body.format);
    const body: PreviewArtifactBody = {
      ...existing.body,
      format,
      content: nextContent,
      version: existing.body.version + 1,
      progress: normalizeProgress(params.progress) ?? existing.body.progress,
    };
    return store.update(existing.ref, {
      title: typeof params.title === "string" ? params.title : existing.title,
      format: format === "html" ? "html" : "mdx",
      body,
    });
  }

  if (typeof params.body !== "undefined") {
    if (!isProductArtifactBody(params.body) || params.body.kind !== existing.kind) {
      throw new Error("body must match existing product artifact kind");
    }
    return store.update(existing.ref, {
      title: typeof params.title === "string" ? params.title : existing.title,
      body: params.body,
    });
  }

  if (typeof params.title === "string") {
    return store.update(existing.ref, { title: params.title });
  }
  throw new Error("update requires content/progress (preview), body, or title");
}

async function syncProductArtifact(
  store: ReturnType<typeof defaultProductArtifactStore>,
  cwd: string,
  params: Record<string, unknown>,
): Promise<ProductArtifact> {
  if (typeof params.artifactRef === "string") {
    const existing = await store.get(normalizeRef(params.artifactRef, "artifactRef"));
    if (existing.kind === "preview") throw new Error("sync does not apply to preview artifacts");
    if (existing.body.kind === "issue") {
      const snapshot = await syncForgeIssue({
        cwd,
        forge: existing.body.forge,
        repo: existing.body.repo,
        number: existing.body.number,
      });
      const body = issueBodyFromSnapshot(snapshot);
      return store.update(existing.ref, { title: body.title, body });
    }
    if (existing.body.kind === "pr") {
      const snapshot = await syncForgePr({
        cwd,
        forge: existing.body.forge,
        repo: existing.body.repo,
        number: existing.body.number,
      });
      const body: PrArtifactBody = {
        ...prBodyFromSnapshot(snapshot),
        worktreePath: existing.body.worktreePath,
        worktreeBranch: existing.body.worktreeBranch,
        worktreeStatus: existing.body.worktreeStatus,
        worktreeError: existing.body.worktreeError,
      };
      return store.update(existing.ref, { title: body.title, body });
    }
  }

  const fromUrl = typeof params.url === "string" ? parseForgeUrl(params.url) : undefined;
  const kind = normalizeKind(params.kind ?? fromUrl?.kind, "kind");
  if (kind === "preview") throw new Error("sync does not apply to preview artifacts");
  return createProductArtifact(store, cwd, { ...params, kind });
}

function renderDetail(artifact: ProductArtifact): string {
  const lines = [
    `${artifact.ref} [${artifact.kind}] ${artifact.title}`,
    `format=${artifact.format} updated=${artifact.updatedAt}`,
    "",
  ];
  if (artifact.body.kind === "preview") {
    lines.push(
      `version=${artifact.body.version} previewFormat=${artifact.body.format}`,
      artifact.body.progress
        ? `progress=${JSON.stringify(artifact.body.progress)}`
        : "progress=(none)",
      "",
      artifact.body.content,
    );
  } else {
    lines.push(JSON.stringify(artifact.body, null, 2));
  }
  return lines.join("\n");
}

function renderListLine(artifact: ProductArtifact): string {
  if (artifact.body.kind === "preview") {
    const progress = artifact.body.progress?.label ?? artifact.body.progress?.stage ?? "";
    return `- [preview] ${artifact.ref}: ${artifact.title} v${artifact.body.version}${progress ? ` (${progress})` : ""}`;
  }
  if (artifact.body.kind === "pr") {
    const wt = artifact.body.worktreeStatus ? ` worktree=${artifact.body.worktreeStatus}` : "";
    return `- [pr] ${artifact.ref}: ${artifact.title} ${artifact.body.repo}#${artifact.body.number}${wt}`;
  }
  return `- [issue] ${artifact.ref}: ${artifact.title} ${artifact.body.repo}#${artifact.body.number}`;
}

function compactDetail(artifact: ProductArtifact): Record<string, unknown> {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    format: artifact.format,
    body: artifact.body,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function compactSummary(artifact: ProductArtifact): Record<string, unknown> {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    updatedAt: artifact.updatedAt,
  };
}

function toolResult(
  action: ProductArtifactAction,
  text: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    details: { tool: "artifact", action, ...details },
  };
}

function normalizeAction(value: unknown): ProductArtifactAction {
  if (
    value === "create" ||
    value === "update" ||
    value === "list" ||
    value === "read" ||
    value === "sync" ||
    value === "attach_worktree" ||
    value === "remove_worktree" ||
    value === "open_preview"
  ) {
    return value;
  }
  throw new Error(
    "artifact.action must be create, update, list, read, sync, attach_worktree, remove_worktree, or open_preview",
  );
}

function normalizeKind(value: unknown, field: string): ProductArtifactKind {
  if (!isProductArtifactKind(value)) {
    throw new Error(
      `${field} must be one of: ${PRODUCT_ARTIFACT_KINDS.join(", ")}; received: ${String(value)}`,
    );
  }
  return value;
}

function normalizeOptionalKind(value: unknown): ProductArtifactKind | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeKind(value, "kind");
}

function normalizeRef(value: unknown, field: string): ProductArtifactRef {
  if (typeof value !== "string" || !value.startsWith("artifact:") || value.length <= 9) {
    throw new Error(`${field} must be an artifact: ref`);
  }
  return value as ProductArtifactRef;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return value;
}

function normalizePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeForge(value: unknown): "github" | "gitlab" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "github" || value === "gitlab") return value;
  throw new Error("forge must be github or gitlab");
}

function normalizePreviewFormat(value: unknown): PreviewContentFormat {
  if (value === undefined || value === null) return "mdx";
  if (value === "md" || value === "mdx" || value === "html") return value;
  throw new Error("format must be md, mdx, or html");
}

function normalizeProgress(value: unknown): PreviewArtifactBody["progress"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("progress must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    label: typeof record.label === "string" ? record.label : undefined,
    percent: typeof record.percent === "number" ? record.percent : undefined,
    stage: typeof record.stage === "string" ? record.stage : undefined,
  };
}

function requireCwd(ctx: { cwd?: string } | undefined, tool: string): string {
  const cwd = ctx?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error(`${tool} requires ctx.cwd`);
  }
  return cwd;
}
