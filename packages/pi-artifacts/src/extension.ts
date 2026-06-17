import { Type } from "typebox";
import type {
  ExtensionAPI,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/pi-extension-api";
import {
  ARTIFACT_CURATION_STATUSES,
  ARTIFACT_FORMATS,
  ARTIFACT_KINDS,
  ARTIFACT_LINK_RELATIONS,
  ARTIFACT_PRODUCERS,
  ARTIFACT_RETENTIONS,
  defaultArtifactStore,
  isArtifactCurationStatus,
  isArtifactFormat,
  isArtifactKind,
  isArtifactLinkRelation,
  isArtifactProducer,
  isArtifactRetention,
  type Artifact,
  type ArtifactCuration,
  type ArtifactCurationStatus,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactLink,
  type ArtifactRef,
  type ArtifactRetention,
  type JsonValue,
  type Provenance,
} from "./index.ts";

export interface PiArtifactsExtensionApi {
  registerTool(config: ToolConfig): void;
}

type ArtifactAction =
  | "record"
  | "list"
  | "read"
  | "link"
  | "compact"
  | "promote"
  | "archive"
  | "supersede";
type ArtifactListView = "ref-only" | "summary" | "full";

const DEFAULT_ARTIFACT_READ_PREVIEW_CHARS = 1_500;
const ARTIFACT_PRODUCER_DESCRIPTION =
  "Artifact producer must be one of: spark, role, task, review, ask, cue, user. Do not use assistant; use task for parent-session work/evidence, review for reviewer verdicts, ask for ask results, cue for cue-shell execution output, or user for user-supplied material. producer=spark and producer=role are legacy compatibility; prefer producer=task with runRef/taskRef for new execution evidence.";
const ARTIFACT_KIND_DESCRIPTION =
  "Artifact kind is the role/domain-agnostic shape of the artifact, never who produced it (use producer) or its lifecycle (use status). One of: document (prose/markdown deliverable: charter, research, plan), record (structured JSON record of a decision/answer/event; origin via producer ask/review/task), trace (prunable execution output/transcript), knowledge (reusable learning entry).";

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
      "Record, list, read, link, compact, or curate artifact/evidence records with strict provenance.",
    promptGuidelines: [
      "Use artifact as the canonical evidence/artifact tool; do not use package-specific artifact aliases.",
      "Use action=list/read for inspection, action=record for bounded evidence writes, and action=compact only with dryRun reviewed first.",
      "Use artifact curation to keep only essence artifacts visible by default: raw is noisy evidence, candidate is possible essence, curated is durable signal, archived/superseded is hidden unless explicitly requested.",
      "Every recorded artifact needs concrete provenance; do not use artifacts as arbitrary scratch memory.",
      ARTIFACT_KIND_DESCRIPTION,
      ARTIFACT_PRODUCER_DESCRIPTION,
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "record | list | read | link | compact | promote | archive | supersede",
      }),
      artifactRef: Type.Optional(Type.String({ description: "Artifact ref for read/link." })),
      from: Type.Optional(Type.String({ description: "Source artifact ref for link." })),
      to: Type.Optional(Type.String({ description: "Target ref for link." })),
      relation: Type.Optional(
        Type.String({
          description: "parent | input | output | review-of | answer-to | trace-of | derived-from",
        }),
      ),
      kind: Type.Optional(
        Type.String({
          description: "Artifact kind filter or record kind. " + ARTIFACT_KIND_DESCRIPTION,
        }),
      ),
      title: Type.Optional(Type.String({ description: "Artifact title for action=record." })),
      format: Type.Optional(
        Type.String({ description: "markdown | json | text for action=record." }),
      ),
      body: Type.Optional(Type.Any({ description: "Artifact body for action=record." })),
      curation: Type.Optional(
        Type.Any({
          description:
            "Optional curation metadata for action=record. status: raw | candidate | curated | archived | superseded; retention: ephemeral | task | project | durable.",
        }),
      ),
      provenance: Type.Optional(
        Type.Any({
          description:
            "Strict provenance object for action=record. Required shape includes provenance.producer. " +
            ARTIFACT_PRODUCER_DESCRIPTION,
        }),
      ),
      links: Type.Optional(
        Type.Array(Type.Any({ description: "Typed artifact links for action=record." })),
      ),
      producer: Type.Optional(
        Type.String({
          description:
            "Provenance producer filter for action=list. " + ARTIFACT_PRODUCER_DESCRIPTION,
        }),
      ),
      projectRef: Type.Optional(
        Type.String({
          description:
            "Project ref filter for action=list, or provenance shortcut for action=record.",
        }),
      ),
      taskRef: Type.Optional(
        Type.String({
          description: "Task ref filter for action=list, or provenance shortcut for action=record.",
        }),
      ),
      roleRef: Type.Optional(
        Type.String({
          description:
            "Legacy role ref filter for action=list, or provenance shortcut for action=record. Prefer runRef/taskRef for new generic execution evidence.",
        }),
      ),
      linkedTo: Type.Optional(Type.String({ description: "Target ref filter for action=list." })),
      curationStatus: Type.Optional(
        Type.String({ description: "Curation status filter for action=list/promote." }),
      ),
      retention: Type.Optional(
        Type.String({
          description: "Retention filter or update: ephemeral | task | project | durable.",
        }),
      ),
      includeRaw: Type.Optional(
        Type.Boolean({
          description: "Include artifacts marked raw in action=list. Default false.",
        }),
      ),
      includeArchived: Type.Optional(
        Type.Boolean({
          description:
            "Include artifacts marked archived/superseded in action=list. Default false.",
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Curation reason for action=promote/archive/supersede." }),
      ),
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
          curationStatus: normalizeOptionalCurationStatus(params.curationStatus, "curationStatus"),
          retention: normalizeOptionalRetention(params.retention, "retention"),
          includeRaw: normalizeBoolean(params.includeRaw, true, "includeRaw"),
          includeArchived: normalizeBoolean(params.includeArchived, false, "includeArchived"),
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
          `format=${artifact.format} producer=${artifact.provenance.producer} curation=${renderCurationLabel(artifact)} updated=${artifact.updatedAt}`,
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
        const provenance = normalizeRecordProvenance(params);
        const links = normalizeArtifactLinks(params.links);
        const curation = normalizeOptionalCuration(params.curation, "curation");
        const artifact = await store.put({
          kind,
          title,
          format,
          body,
          provenance,
          links,
          curation,
        });
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

      if (action === "promote") {
        const artifactRef = normalizeArtifactRef(params.artifactRef, "artifactRef");
        const existing = await store.get(artifactRef);
        const status =
          normalizeOptionalCurationStatus(params.curationStatus, "curationStatus") ?? "curated";
        if (status !== "candidate" && status !== "curated") {
          throw new Error("promote curationStatus must be candidate or curated");
        }
        const curation: ArtifactCuration = {
          ...(existing.curation ?? {}),
          status,
          retention:
            normalizeOptionalRetention(params.retention, "retention") ??
            existing.curation?.retention ??
            (status === "curated" ? "durable" : "project"),
          reason: normalizeRequiredString(params.reason, "reason"),
        };
        const artifact = await store.update(artifactRef, { curation });
        return toolResult("artifact", action, `Promoted ${artifact.ref} to ${status}`, {
          changed: true,
          refs: { artifactRef: artifact.ref },
          artifact: compactArtifactDetail(artifact),
        });
      }

      if (action === "archive") {
        const artifactRef = normalizeArtifactRef(params.artifactRef, "artifactRef");
        const existing = await store.get(artifactRef);
        const curation: ArtifactCuration = {
          ...(existing.curation ?? {}),
          status: "archived",
          retention:
            normalizeOptionalRetention(params.retention, "retention") ??
            existing.curation?.retention ??
            "ephemeral",
          reason: normalizeRequiredString(params.reason, "reason"),
        };
        const artifact = await store.update(artifactRef, { curation });
        return toolResult("artifact", action, `Archived ${artifact.ref}`, {
          changed: true,
          refs: { artifactRef: artifact.ref },
          artifact: compactArtifactDetail(artifact),
        });
      }

      if (action === "supersede") {
        const artifactRef = normalizeArtifactRef(params.artifactRef, "artifactRef");
        const replacementRef = normalizeArtifactRef(params.to, "to");
        const existing = await store.get(artifactRef);
        const supersededBy = [...(existing.curation?.supersededBy ?? [])];
        if (!supersededBy.includes(replacementRef)) supersededBy.push(replacementRef);
        const curation: ArtifactCuration = {
          ...(existing.curation ?? {}),
          status: "superseded",
          retention: existing.curation?.retention ?? "task",
          reason: normalizeRequiredString(params.reason, "reason"),
          supersededBy,
        };
        const artifact = await store.update(artifactRef, { curation });
        return toolResult("artifact", action, `Superseded ${artifact.ref} by ${replacementRef}`, {
          changed: true,
          refs: { artifactRef: artifact.ref, supersededBy: replacementRef },
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
    curation: artifact.curation,
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
    curation: artifact.curation,
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
    return `- [${artifact.kind}] ${artifact.ref}: ${artifact.title} format=${artifact.format} producer=${artifact.provenance.producer} curation=${renderCurationLabel(artifact)} links=${artifact.links.length} bodySize=${artifact.bodySize ?? "unknown"}`;
  }
  return `- [${artifact.kind}] ${artifact.ref}: ${artifact.title} curation=${renderCurationLabel(artifact)}`;
}

function renderCurationLabel(artifact: Artifact): string {
  const status = artifact.curation?.status ?? "legacy";
  const retention = artifact.curation?.retention;
  return retention ? `${status}/${retention}` : status;
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
    value === "compact" ||
    value === "promote" ||
    value === "archive" ||
    value === "supersede"
  ) {
    return value;
  }
  throw new Error(
    "artifact.action must be record, list, read, link, compact, promote, archive, or supersede",
  );
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
        research: "Use kind=document for analysis/research write-ups.",
        plan: "Use kind=document for plans and breakdowns.",
        "plan-draft": "Use kind=document for plan drafts and finalized plans.",
        review: "Use kind=record with producer=review for a reviewer verdict.",
        verification: "Use kind=record (producer=task/cue) for test/build/validation evidence.",
        test: "Use kind=record (producer=task/cue) for test/build/lint/validation evidence.",
        validation: "Use kind=record (producer=task/cue) for validation evidence.",
        learning: "Use kind=knowledge for reusable learning entries.",
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
          "Use producer=task for execution evidence, with runRef/taskRef when available, or producer=user for user-provided material.",
        assistant:
          "Use producer=task for parent-session work/evidence, review for reviewer verdicts, ask for ask results, cue for cue-shell output, or user for user-provided material.",
      }),
    );
  }
  return value;
}

function normalizeOptionalCurationStatus(
  value: unknown,
  field: string,
): ArtifactCurationStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isArtifactCurationStatus(value)) {
    throw new Error(
      formatValidValuesError(
        field,
        value,
        "a valid artifact curation status",
        ARTIFACT_CURATION_STATUSES,
      ),
    );
  }
  return value;
}

function normalizeOptionalRetention(value: unknown, field: string): ArtifactRetention | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isArtifactRetention(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid artifact retention", ARTIFACT_RETENTIONS),
    );
  }
  return value;
}

function normalizeOptionalCuration(value: unknown, field: string): ArtifactCuration | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const status = normalizeOptionalCurationStatus(value.status, `${field}.status`);
  if (!status) throw new Error(`${field}.status is required`);
  const curation: ArtifactCuration = { status };
  const retention = normalizeOptionalRetention(value.retention, `${field}.retention`);
  const reason = normalizeOptionalString(value.reason, `${field}.reason`);
  const promotedFrom = normalizeOptionalArtifactRefArray(
    value.promotedFrom,
    `${field}.promotedFrom`,
  );
  const supersededBy = normalizeOptionalArtifactRefArray(
    value.supersededBy,
    `${field}.supersededBy`,
  );
  const compactedInto = normalizeOptionalArtifactRef(value.compactedInto, `${field}.compactedInto`);
  const expiresAt = normalizeOptionalString(value.expiresAt, `${field}.expiresAt`);
  if (retention) curation.retention = retention;
  if (reason) curation.reason = reason;
  if (promotedFrom) curation.promotedFrom = promotedFrom;
  if (supersededBy) curation.supersededBy = supersededBy;
  if (compactedInto) curation.compactedInto = compactedInto;
  if (expiresAt) curation.expiresAt = expiresAt;
  return curation;
}

function normalizeArtifactBody(value: unknown, format: ArtifactFormat): JsonValue | string {
  if (format === "markdown" || format === "text") {
    if (typeof value !== "string") throw new Error(`body must be a string for ${format} artifacts`);
    return value;
  }
  if (!isJsonValue(value)) throw new Error("body must be a JSON value for json artifacts");
  return value;
}

function normalizeRecordProvenance(params: Record<string, unknown>): Provenance {
  const provenance = normalizeProvenance(params.provenance);
  const projectRef = normalizeOptionalRefOfKind(params.projectRef, "proj", "projectRef");
  const taskRef = normalizeOptionalRefOfKind(params.taskRef, "task", "taskRef");
  const roleRef = normalizeOptionalRefOfKind(params.roleRef, "role", "roleRef");
  return {
    ...provenance,
    ...(projectRef
      ? {
          projectRef: mergeProvenanceRef(
            provenance.projectRef,
            projectRef,
            "projectRef",
          ) as Provenance["projectRef"],
        }
      : {}),
    ...(taskRef
      ? {
          taskRef: mergeProvenanceRef(
            provenance.taskRef,
            taskRef,
            "taskRef",
          ) as Provenance["taskRef"],
        }
      : {}),
    ...(roleRef
      ? {
          roleRef: mergeProvenanceRef(
            provenance.roleRef,
            roleRef,
            "roleRef",
          ) as Provenance["roleRef"],
        }
      : {}),
  };
}

function mergeProvenanceRef(existing: string | undefined, shortcut: string, field: string): string {
  if (!existing || existing === shortcut) return shortcut;
  throw new Error(`${field} conflicts with provenance.${field}`);
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

function normalizeOptionalArtifactRef(value: unknown, field: string): ArtifactRef | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeArtifactRef(value, field);
}

function normalizeOptionalArtifactRefArray(
  value: unknown,
  field: string,
): ArtifactRef[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => normalizeArtifactRef(entry, `${field}[${index}]`));
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
