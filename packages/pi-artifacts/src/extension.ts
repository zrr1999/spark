import { Type } from "typebox";
import type {
  ExtensionAPI,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "pi-extension-api";
import {
  ARTIFACT_FORMATS,
  ARTIFACT_KINDS,
  ARTIFACT_LINK_RELATIONS,
  ARTIFACT_PRODUCERS,
  defaultArtifactStore,
  isArtifactFormat,
  isArtifactKind,
  isArtifactLinkRelation,
  isArtifactProducer,
  type Artifact,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactLink,
  type ArtifactRef,
  type JsonValue,
  type Provenance,
} from "./index.ts";

export interface PiArtifactsExtensionApi {
  registerTool(config: ToolConfig): void;
}

type ArtifactAction = "record" | "list" | "read" | "link" | "compact";
type ArtifactListView = "ref-only" | "summary" | "full";

const DEFAULT_ARTIFACT_READ_PREVIEW_CHARS = 1_500;

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

export function registerPiArtifactTool(pi: PiArtifactsExtensionApi): void {
  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description:
      "Record, list, read, link, or compact artifact/evidence records with strict provenance.",
    promptGuidelines: [
      "Use artifact as the canonical evidence/artifact tool; do not use Spark-specific artifact aliases.",
      "Use action=list/read for inspection, action=record for bounded evidence writes, and action=compact only with dryRun reviewed first.",
      "Every recorded artifact needs concrete provenance; do not use artifacts as arbitrary scratch memory.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "record | list | read | link | compact" }),
      artifactRef: Type.Optional(Type.String({ description: "Artifact ref for read/link." })),
      from: Type.Optional(Type.String({ description: "Source artifact ref for link." })),
      to: Type.Optional(Type.String({ description: "Target ref for link." })),
      relation: Type.Optional(
        Type.String({
          description: "parent | input | output | review-of | answer-to | trace-of | derived-from",
        }),
      ),
      kind: Type.Optional(Type.String({ description: "Artifact kind filter or record kind." })),
      title: Type.Optional(Type.String({ description: "Artifact title for action=record." })),
      format: Type.Optional(
        Type.String({ description: "markdown | json | text for action=record." }),
      ),
      body: Type.Optional(Type.Any({ description: "Artifact body for action=record." })),
      provenance: Type.Optional(
        Type.Any({ description: "Strict provenance object for action=record." }),
      ),
      links: Type.Optional(
        Type.Array(Type.Any({ description: "Typed artifact links for action=record." })),
      ),
      producer: Type.Optional(
        Type.String({ description: "Provenance producer filter for action=list." }),
      ),
      projectRef: Type.Optional(
        Type.String({ description: "Project ref filter for action=list." }),
      ),
      taskRef: Type.Optional(Type.String({ description: "Task ref filter for action=list." })),
      roleRef: Type.Optional(Type.String({ description: "Role ref filter for action=list." })),
      linkedTo: Type.Optional(Type.String({ description: "Target ref filter for action=list." })),
      limit: Type.Optional(
        Type.Number({ description: "Maximum rows for action=list. Default: 20." }),
      ),
      view: Type.Optional(
        Type.String({ description: "List view for action=list: ref-only | summary | full." }),
      ),
      full: Type.Optional(
        Type.Boolean({ description: "Read full body for action=read. Default: false." }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description: "Maximum body chars for action=read when full=false. Default: 1500.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Preview action=compact. Default: true." }),
      ),
      inlineBodyThresholdBytes: Type.Optional(
        Type.Number({ description: "Metadata compaction threshold for action=compact." }),
      ),
      bodyPreviewChars: Type.Optional(
        Type.Number({ description: "Metadata preview chars for action=compact." }),
      ),
    }),
    renderCall(args, theme) {
      return renderArtifactCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requireCwd(ctx, "artifact");
      const store = defaultArtifactStore(cwd);
      const action = normalizeAction(params.action);

      if (action === "list") {
        const artifacts = await store.list({
          kind: normalizeOptionalArtifactKind(params.kind, "kind"),
          producer: normalizeOptionalProducer(params.producer, "producer"),
          projectRef: normalizeOptionalRefOfKind(params.projectRef, "proj", "projectRef"),
          taskRef: normalizeOptionalRefOfKind(params.taskRef, "task", "taskRef"),
          roleRef: normalizeOptionalRefOfKind(params.roleRef, "role", "roleRef"),
          linkedTo: normalizeOptionalRef(params.linkedTo, "linkedTo"),
        });
        const newest = artifacts.slice().reverse();
        const limit = normalizeLimit(params.limit, 20, "limit");
        const view = normalizeArtifactListView(params.view);
        const visible = newest.slice(0, limit);
        const lines = [
          `Artifacts: ${artifacts.length}${visible.length < artifacts.length ? ` (showing ${visible.length})` : ""}`,
          ...visible.map((artifact) => renderArtifactListLine(artifact, view)),
        ];
        if (visible.length === 0) lines.push("- No artifacts.");
        if (visible.length < artifacts.length)
          lines.push(`- … ${artifacts.length - visible.length} more artifact(s)`);
        return toolResult("artifact", action, lines.join("\n"), {
          count: artifacts.length,
          shown: visible.length,
          view,
          artifacts: visible.map((artifact) =>
            view === "full"
              ? compactArtifactDetail(artifact)
              : compactArtifactSummaryDetail(artifact),
          ),
        });
      }

      if (action === "read") {
        const artifactRef = normalizeArtifactRef(params.artifactRef, "artifactRef");
        const artifact = await store.get(artifactRef);
        const body = await store.getBody(artifactRef);
        const full = normalizeBoolean(params.full, false, "full");
        const maxChars = normalizeLimit(
          params.maxChars,
          DEFAULT_ARTIFACT_READ_PREVIEW_CHARS,
          "maxChars",
        );
        const renderedBody = full ? body : truncateBlock(body, maxChars);
        const truncated = !full && renderedBody.length < body.length;
        const lines = [
          `${artifact.ref} [${artifact.kind}] ${artifact.title}`,
          `format=${artifact.format} producer=${artifact.provenance.producer} updated=${artifact.updatedAt}`,
          "",
          renderedBody,
        ];
        if (truncated) {
          lines.push(
            "",
            `… truncated ${body.length - renderedBody.length} char(s); call full=true for the complete artifact body`,
          );
        }
        return toolResult("artifact", action, lines.join("\n"), {
          artifact: compactArtifactDetail(artifact),
          bodyChars: body.length,
          shownChars: renderedBody.length,
          truncated,
        });
      }

      if (action === "record") {
        const kind = normalizeArtifactKind(params.kind, "kind");
        const title = normalizeRequiredString(params.title, "title");
        const format = normalizeArtifactFormat(params.format, "format");
        const body = normalizeArtifactBody(params.body, format);
        const provenance = normalizeProvenance(params.provenance);
        const links = normalizeArtifactLinks(params.links);
        const artifact = await store.put({ kind, title, format, body, provenance, links });
        return toolResult(
          "artifact",
          action,
          `Recorded artifact ${artifact.ref} [${artifact.kind}] ${artifact.title}`,
          {
            changed: true,
            refs: { artifactRef: artifact.ref },
            artifact: compactArtifactDetail(artifact),
          },
        );
      }

      if (action === "link") {
        const from = normalizeArtifactRef(params.from ?? params.artifactRef, "from");
        const to = normalizeRequiredRef(params.to, "to") as ArtifactLink["to"];
        const relation = normalizeArtifactRelation(params.relation, "relation");
        const existing = await store.get(from);
        const links = [...existing.links.map(({ from: _from, ...link }) => link), { to, relation }];
        const artifact = await store.update(from, { links });
        return toolResult("artifact", action, `Linked ${from} -> ${to} (${relation})`, {
          changed: true,
          refs: { artifactRef: artifact.ref, targetRef: to },
          artifact: compactArtifactDetail(artifact),
        });
      }

      const compacted = await store.compactMetadata({
        dryRun: normalizeBoolean(params.dryRun, true, "dryRun"),
        inlineBodyThresholdBytes: normalizeOptionalPositiveNumber(
          params.inlineBodyThresholdBytes,
          "inlineBodyThresholdBytes",
        ),
        bodyPreviewChars: normalizeOptionalPositiveNumber(
          params.bodyPreviewChars,
          "bodyPreviewChars",
        ),
      });
      const lines = [
        `Artifact metadata compaction ${compacted.dryRun ? "preview" : "applied"}: scanned=${compacted.scanned} candidates=${compacted.candidates.length} compacted=${compacted.compacted}`,
        `metadataBytesBefore=${compacted.metadataBytesBefore} metadataBytesAfter=${compacted.metadataBytesAfter} reclaimableBytes=${compacted.reclaimableBytes}`,
      ];
      for (const candidate of compacted.candidates.slice(0, 20)) {
        lines.push(
          `- ${candidate.ref}: ${candidate.metadataBytesBefore} -> ${candidate.metadataBytesAfter} metadata bytes`,
        );
      }
      if (compacted.candidates.length > 20)
        lines.push(`- … ${compacted.candidates.length - 20} more candidate(s)`);
      return toolResult("artifact", action, lines.join("\n"), {
        changed: !compacted.dryRun && compacted.compacted > 0,
        dryRun: compacted.dryRun,
        compaction: compacted,
      });
    },
  });
}

export default function piArtifactsExtension(pi: ExtensionAPI): void {
  if (!pi.registerTool) throw new Error("pi-artifacts extension requires registerTool support");
  registerPiArtifactTool({ registerTool: (config) => pi.registerTool?.(config) });
}

function renderArtifactCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const target =
    typeof args.artifactRef === "string"
      ? args.artifactRef
      : typeof args.from === "string"
        ? args.from
        : undefined;
  const text = ["artifact", `action=${action}`, target].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}

function toolResult(
  tool: "artifact",
  action: ArtifactAction,
  text: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    details: { tool, action, ...details },
  };
}

function compactArtifactDetail(artifact: Artifact): Record<string, unknown> {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    format: artifact.format,
    provenance: artifact.provenance,
    links: artifact.links,
    hash: artifact.hash,
    blobPath: artifact.blobPath,
    bodySize: artifact.bodySize,
    bodyTruncated: artifact.bodyTruncated,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function compactArtifactSummaryDetail(artifact: Artifact): Record<string, unknown> {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    format: artifact.format,
    producer: artifact.provenance.producer,
    projectRef: artifact.provenance.projectRef,
    taskRef: artifact.provenance.taskRef,
    roleRef: artifact.provenance.roleRef,
    bodySize: artifact.bodySize,
    bodyTruncated: artifact.bodyTruncated,
    updatedAt: artifact.updatedAt,
  };
}

function renderArtifactListLine(artifact: Artifact, view: ArtifactListView): string {
  if (view === "ref-only") return `- ${artifact.ref}`;
  if (view === "full") {
    return `- [${artifact.kind}] ${artifact.ref}: ${artifact.title} format=${artifact.format} producer=${artifact.provenance.producer} links=${artifact.links.length} bodySize=${artifact.bodySize ?? "unknown"}`;
  }
  return `- [${artifact.kind}] ${artifact.ref}: ${artifact.title}`;
}

function formatValidValuesError(
  field: string,
  received: unknown,
  label: string,
  validValues: readonly string[],
  hints: Record<string, string> = {},
): string {
  const rendered = typeof received === "string" ? received : JSON.stringify(received);
  const message = `${field} must be ${label}; valid values: ${validValues.join(", ")}; received: ${rendered ?? String(received)}`;
  const hint = typeof received === "string" ? hints[received] : undefined;
  return hint ? `${message}. Hint: ${hint}` : message;
}

function normalizeAction(value: unknown): ArtifactAction {
  if (
    value === "record" ||
    value === "list" ||
    value === "read" ||
    value === "link" ||
    value === "compact"
  ) {
    return value;
  }
  throw new Error("artifact.action must be record, list, read, link, or compact");
}

function normalizeArtifactListView(value: unknown): ArtifactListView {
  if (value === undefined || value === null) return "summary";
  if (value === "ref-only" || value === "summary" || value === "full") return value;
  throw new Error("view must be ref-only, summary, or full");
}

function normalizeArtifactKind(value: unknown, field: string): ArtifactKind {
  if (!isArtifactKind(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid artifact kind", ARTIFACT_KINDS, {
        "plan-draft":
          "Use kind=research with a title prefix like 'Plan draft: ...', or kind=plan for finalized plans.",
      }),
    );
  }
  return value;
}

function normalizeOptionalArtifactKind(value: unknown, field: string): ArtifactKind | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeArtifactKind(value, field);
}

function normalizeArtifactFormat(value: unknown, field: string): ArtifactFormat {
  if (!isArtifactFormat(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid artifact format", ARTIFACT_FORMATS),
    );
  }
  return value;
}

function normalizeArtifactRelation(value: unknown, field: string): ArtifactLink["relation"] {
  if (!isArtifactLinkRelation(value)) {
    throw new Error(
      formatValidValuesError(
        field,
        value,
        "a valid artifact link relation",
        ARTIFACT_LINK_RELATIONS,
      ),
    );
  }
  return value;
}

function normalizeOptionalProducer(
  value: unknown,
  field: string,
): Provenance["producer"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isArtifactProducer(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid artifact producer", ARTIFACT_PRODUCERS, {
        agent:
          "Use producer=role for subagent output artifacts, or producer=task for parent-session task evidence.",
      }),
    );
  }
  return value;
}

function normalizeArtifactBody(value: unknown, format: ArtifactFormat): JsonValue | string {
  if (format === "markdown" || format === "text") {
    if (typeof value !== "string") throw new Error(`body must be a string for ${format} artifacts`);
    return value;
  }
  if (!isJsonValue(value)) throw new Error("body must be a JSON value for json artifacts");
  return value;
}

function normalizeProvenance(value: unknown): Provenance {
  if (!isRecord(value)) throw new Error("provenance must be an object");
  const producer = normalizeOptionalProducer(value.producer, "provenance.producer");
  if (!producer) throw new Error("provenance.producer is required");
  const provenance: Provenance = { producer };
  const runRef = normalizeOptionalRefOfKind(value.runRef, "run", "provenance.runRef");
  const projectRef = normalizeOptionalRefOfKind(value.projectRef, "proj", "provenance.projectRef");
  const taskRef = normalizeOptionalRefOfKind(value.taskRef, "task", "provenance.taskRef");
  const roleRef = normalizeOptionalRefOfKind(value.roleRef, "role", "provenance.roleRef");
  const note = normalizeOptionalString(value.note, "provenance.note");
  const parentArtifactRefs = normalizeOptionalStringArray(
    value.parentArtifactRefs,
    "provenance.parentArtifactRefs",
  ) as ArtifactRef[] | undefined;
  if (runRef) provenance.runRef = runRef as Provenance["runRef"];
  if (projectRef) provenance.projectRef = projectRef as Provenance["projectRef"];
  if (taskRef) provenance.taskRef = taskRef as Provenance["taskRef"];
  if (roleRef) provenance.roleRef = roleRef as Provenance["roleRef"];
  if (note) provenance.note = note;
  if (parentArtifactRefs) provenance.parentArtifactRefs = parentArtifactRefs;
  return provenance;
}

function normalizeArtifactLinks(value: unknown): Omit<ArtifactLink, "from">[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("links must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`links[${index}] must be an object`);
    return {
      to: normalizeRequiredRef(entry.to, `links[${index}].to`) as ArtifactLink["to"],
      relation: normalizeArtifactRelation(entry.relation, `links[${index}].relation`),
    };
  });
}

function normalizeArtifactRef(value: unknown, field: string): ArtifactRef {
  const ref = normalizeRequiredRef(value, field);
  if (!ref.startsWith("artifact:")) throw new Error(`${field} must be an artifact ref`);
  return ref as ArtifactRef;
}

function normalizeRequiredRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[-a-z]+:[^:]+$/u.test(value)) {
    throw new Error(`${field} must be a valid ref`);
  }
  return value;
}

function normalizeOptionalRef(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredRef(value, field);
}

function normalizeOptionalRefOfKind(
  value: unknown,
  kind: string,
  field: string,
): string | undefined {
  const ref = normalizeOptionalRef(value, field);
  if (ref === undefined) return undefined;
  if (!ref.startsWith(`${kind}:`)) throw new Error(`${field} must be a ${kind}: ref`);
  return ref;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredString(value, field);
}

function normalizeOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => normalizeRequiredString(entry, `${field}[${index}]`));
}

function normalizeLimit(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeOptionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return value;
}

function normalizeBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function truncateBlock(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… truncated ${text.length - maxChars} char(s)`;
}

function requireCwd(ctx: { cwd?: string }, tool: string): string {
  if (!ctx.cwd) throw new Error(`${tool} requires ctx.cwd`);
  return ctx.cwd;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
