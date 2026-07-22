import { Type } from "typebox";
import type {
  SparkHostAPI,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-core";
import {
  EVIDENCE_CURATION_STATUSES,
  EVIDENCE_FORMATS,
  EVIDENCE_KINDS,
  EVIDENCE_LINK_RELATIONS,
  EVIDENCE_PRODUCERS,
  EVIDENCE_RETENTIONS,
  defaultEvidenceStore,
  isEvidenceCurationStatus,
  isEvidenceFormat,
  isEvidenceKind,
  isEvidenceLinkRelation,
  isEvidenceProducer,
  isEvidenceRetention,
  type Evidence,
  type EvidenceCuration,
  type EvidenceCurationStatus,
  type EvidenceFormat,
  type EvidenceKind,
  type EvidenceLink,
  type EvidenceRef,
  type EvidenceRetention,
  type JsonValue,
  type EvidenceProvenance,
} from "./index.ts";
import { registerProductArtifactTool } from "./product/extension.ts";

export interface SparkArtifactsHostApi {
  registerTool(config: ToolConfig): void;
}

type EvidenceAction =
  | "record"
  | "list"
  | "read"
  | "link"
  | "compact"
  | "promote"
  | "archive"
  | "supersede";
type EvidenceListView = "ref-only" | "summary";

const DEFAULT_EVIDENCE_READ_PREVIEW_CHARS = 800;
const EVIDENCE_PRODUCER_DESCRIPTION =
  "producer: spark | role | task | review | ask | cue | user. Prefer producer=task (+ runRef/taskRef) for execution notes; ask/review/cue when that capability owns the write.";
const EVIDENCE_KIND_DESCRIPTION =
  "Internal ledger kinds only: record (default; one JSON fact/decision/result), trace (prunable raw output), knowledge (learning capability), document (rare long prose). Not user-facing; product ISSUE/PR/preview use artifact.";

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

/** Register the agent-internal evidence ledger tool (`evidence`). */
export function registerEvidenceTool(pi: SparkArtifactsHostApi): void {
  pi.registerTool({
    name: "evidence",
    label: "Evidence",
    description:
      "Agent-internal ledger only (not Cockpit/user UI). Compact provenance-backed notes for other tools and later turns. Product ISSUE/PR/preview use artifact.",
    promptGuidelines: [
      "evidence is agent-private: never treat it as user-visible content; Cockpit shows only artifact (issue/pr/preview).",
      "Prefer format=json and kind=record with a compact body: { summary: string, data?: object }. Use kind=trace for raw/prunable tool dumps.",
      "Keep titles short; keep bodies small. Do not write long markdown essays into evidence.",
      "Use list/read to recover prior notes; use record to append. promote/archive/supersede only when curating durable ask/learning contracts.",
      EVIDENCE_KIND_DESCRIPTION,
      EVIDENCE_PRODUCER_DESCRIPTION,
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "record | list | read | link | compact | promote | archive | supersede",
      }),
      evidenceRef: Type.Optional(Type.String({ description: "Evidence ref (evidence:…)." })),
      from: Type.Optional(Type.String({ description: "Source evidence ref for link." })),
      to: Type.Optional(Type.String({ description: "Target ref for link." })),
      relation: Type.Optional(
        Type.String({
          description: "parent | input | output | review-of | answer-to | trace-of | derived-from",
        }),
      ),
      kind: Type.Optional(
        Type.String({
          description:
            "record | trace | knowledge | document. Default for new writes: record. " +
            EVIDENCE_KIND_DESCRIPTION,
        }),
      ),
      title: Type.Optional(Type.String({ description: "Short title for action=record." })),
      format: Type.Optional(Type.String({ description: "Prefer json; also markdown | text." })),
      body: Type.Optional(
        Type.Any({
          description:
            "Prefer compact JSON: { summary: string, data?: object }. Avoid large prose.",
        }),
      ),
      curation: Type.Optional(
        Type.Any({
          description:
            "Optional. status: raw | candidate | curated | archived | superseded; retention: ephemeral | task | project | durable. Default raw/ephemeral for traces.",
        }),
      ),
      provenance: Type.Optional(
        Type.Any({
          description:
            "Required for record. Must include provenance.producer. " +
            EVIDENCE_PRODUCER_DESCRIPTION,
        }),
      ),
      links: Type.Optional(Type.Array(Type.Any({ description: "Typed links for action=record." }))),
      producer: Type.Optional(
        Type.String({
          description: "Filter for list. " + EVIDENCE_PRODUCER_DESCRIPTION,
        }),
      ),
      projectRef: Type.Optional(
        Type.String({
          description: "Project ref filter or provenance shortcut.",
        }),
      ),
      taskRef: Type.Optional(
        Type.String({
          description: "Task ref filter or provenance shortcut.",
        }),
      ),
      roleRef: Type.Optional(
        Type.String({
          description: "Role ref filter or provenance shortcut.",
        }),
      ),
      linkedTo: Type.Optional(Type.String({ description: "Target ref filter for list." })),
      curationStatus: Type.Optional(
        Type.String({ description: "Curation status filter for list/promote." }),
      ),
      retention: Type.Optional(
        Type.String({
          description: "ephemeral | task | project | durable",
        }),
      ),
      includeRaw: Type.Optional(
        Type.Boolean({
          description: "Include raw entries in list. Default false.",
        }),
      ),
      includeArchived: Type.Optional(
        Type.Boolean({
          description: "Include archived/superseded in list. Default false.",
        }),
      ),
      reason: Type.Optional(Type.String({ description: "Reason for promote/archive/supersede." })),
      limit: Type.Optional(Type.Number({ description: "Max rows for list. Default 20." })),
      view: Type.Optional(
        Type.String({
          description: "list view: ref-only (default) | summary",
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description: "Max body chars for read. Default 800.",
        }),
      ),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview compact. Default true." })),
      inlineBodyThresholdBytes: Type.Optional(
        Type.Number({ description: "Compaction threshold." }),
      ),
      bodyPreviewChars: Type.Optional(Type.Number({ description: "Compaction preview chars." })),
    }),
    renderCall(args, theme) {
      return renderEvidenceCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requireCwd(ctx, "evidence");
      const store = defaultEvidenceStore(cwd);
      const action = normalizeAction(params.action);

      if (action === "list") {
        const limit = normalizeLimit(params.limit, 20, "limit");
        const view = normalizeEvidenceListView(params.view ?? "ref-only");
        const evidence = await store.list({
          kind: normalizeOptionalEvidenceKind(params.kind, "kind"),
          producer: normalizeOptionalProducer(params.producer, "producer"),
          projectRef: normalizeOptionalRefOfKind(params.projectRef, "proj", "projectRef"),
          taskRef: normalizeOptionalRefOfKind(params.taskRef, "task", "taskRef"),
          roleRef: normalizeOptionalRefOfKind(params.roleRef, "role", "roleRef"),
          linkedTo: normalizeOptionalRef(params.linkedTo, "linkedTo"),
          curationStatus: normalizeOptionalCurationStatus(params.curationStatus, "curationStatus"),
          retention: normalizeOptionalRetention(params.retention, "retention"),
          includeRaw: normalizeBoolean(params.includeRaw, false, "includeRaw"),
          includeArchived: normalizeBoolean(params.includeArchived, false, "includeArchived"),
        });
        const newest = evidence.slice().reverse();
        const visible = newest.slice(0, limit);
        const lines = [
          `Evidence ledger: ${evidence.length}${visible.length < evidence.length ? ` (showing ${visible.length})` : ""}`,
          ...visible.map((entry) => renderEvidenceListLine(entry, view)),
        ];
        if (visible.length === 0) lines.push("- (empty)");
        if (visible.length < evidence.length)
          lines.push(`- … ${evidence.length - visible.length} more`);
        return toolResult("evidence", action, lines.join("\n"), {
          count: evidence.length,
          shown: visible.length,
          view,
          evidence: visible.map((entry) => compactEvidenceSummaryDetail(entry)),
        });
      }

      if (action === "read") {
        const evidenceRef = normalizeEvidenceRef(params.evidenceRef, "evidenceRef");
        const entry = await store.get(evidenceRef);
        const body = await store.getBody(evidenceRef);
        const maxChars = normalizeLimit(
          params.maxChars,
          DEFAULT_EVIDENCE_READ_PREVIEW_CHARS,
          "maxChars",
        );
        const renderedBody = truncateBlock(body, maxChars);
        const truncated = renderedBody.length < body.length;
        const lines = [
          `${entry.ref} [${entry.kind}] ${entry.title}`,
          `producer=${entry.provenance.producer} updated=${entry.updatedAt}`,
          "",
          renderedBody,
        ];
        if (truncated) {
          lines.push("", `… truncated ${body.length - renderedBody.length} char(s)`);
        }
        return toolResult("evidence", action, lines.join("\n"), {
          evidence: compactEvidenceDetail(entry),
          bodyChars: body.length,
          shownChars: renderedBody.length,
          truncated,
        });
      }

      if (action === "record") {
        const kind = normalizeEvidenceKind(params.kind ?? "record", "kind");
        const title = normalizeRequiredString(params.title, "title");
        const format = normalizeEvidenceFormat(params.format ?? "json", "format");
        const body = normalizeEvidenceBody(params.body, format);
        const provenance = normalizeRecordEvidenceProvenance(params);
        const links = normalizeEvidenceLinks(params.links);
        const curation = normalizeOptionalCuration(params.curation, "curation");
        const entry = await store.put({
          kind,
          title,
          format,
          body,
          provenance,
          links,
          curation,
        });
        return toolResult(
          "evidence",
          action,
          `Recorded ${entry.ref} [${entry.kind}] ${entry.title}`,
          {
            changed: true,
            refs: { evidenceRef: entry.ref },
            evidence: compactEvidenceSummaryDetail(entry),
          },
        );
      }

      if (action === "link") {
        const from = normalizeEvidenceRef(params.from ?? params.evidenceRef, "from");
        const to = normalizeRequiredRef(params.to, "to") as EvidenceLink["to"];
        const relation = normalizeEvidenceRelation(params.relation, "relation");
        const existing = await store.get(from);
        const links = [...existing.links.map(({ from: _from, ...link }) => link), { to, relation }];
        const entry = await store.update(from, { links });
        return toolResult("evidence", action, `Linked ${from} -> ${to} (${relation})`, {
          changed: true,
          refs: { evidenceRef: entry.ref, targetRef: to },
          evidence: compactEvidenceDetail(entry),
        });
      }

      if (action === "promote") {
        const evidenceRef = normalizeEvidenceRef(params.evidenceRef, "evidenceRef");
        const existing = await store.get(evidenceRef);
        const status =
          normalizeOptionalCurationStatus(params.curationStatus, "curationStatus") ?? "curated";
        if (status !== "candidate" && status !== "curated") {
          throw new Error("promote curationStatus must be candidate or curated");
        }
        const curation: EvidenceCuration = {
          ...(existing.curation ?? {}),
          status,
          retention:
            normalizeOptionalRetention(params.retention, "retention") ??
            existing.curation?.retention ??
            (status === "curated" ? "durable" : "project"),
          reason: normalizeRequiredString(params.reason, "reason"),
        };
        const entry = await store.update(evidenceRef, { curation });
        return toolResult("evidence", action, `Promoted ${entry.ref} to ${status}`, {
          changed: true,
          refs: { evidenceRef: entry.ref },
          evidence: compactEvidenceDetail(entry),
        });
      }

      if (action === "archive") {
        const evidenceRef = normalizeEvidenceRef(params.evidenceRef, "evidenceRef");
        const existing = await store.get(evidenceRef);
        const curation: EvidenceCuration = {
          ...(existing.curation ?? {}),
          status: "archived",
          retention:
            normalizeOptionalRetention(params.retention, "retention") ??
            existing.curation?.retention ??
            "ephemeral",
          reason: normalizeRequiredString(params.reason, "reason"),
        };
        const entry = await store.update(evidenceRef, { curation });
        return toolResult("evidence", action, `Archived ${entry.ref}`, {
          changed: true,
          refs: { evidenceRef: entry.ref },
          evidence: compactEvidenceDetail(entry),
        });
      }

      if (action === "supersede") {
        const evidenceRef = normalizeEvidenceRef(params.evidenceRef, "evidenceRef");
        const replacementRef = normalizeEvidenceRef(params.to, "to");
        const existing = await store.get(evidenceRef);
        const supersededBy = [...(existing.curation?.supersededBy ?? [])];
        if (!supersededBy.includes(replacementRef)) supersededBy.push(replacementRef);
        const curation: EvidenceCuration = {
          ...(existing.curation ?? {}),
          status: "superseded",
          retention: existing.curation?.retention ?? "task",
          reason: normalizeRequiredString(params.reason, "reason"),
          supersededBy,
        };
        const entry = await store.update(evidenceRef, { curation });
        return toolResult("evidence", action, `Superseded ${entry.ref} by ${replacementRef}`, {
          changed: true,
          refs: {
            evidenceRef: entry.ref,
            supersededBy: replacementRef,
          },
          evidence: compactEvidenceDetail(entry),
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
        `Evidence metadata compaction ${compacted.dryRun ? "preview" : "applied"}: scanned=${compacted.scanned} candidates=${compacted.candidates.length} compacted=${compacted.compacted}`,
        `metadataBytesBefore=${compacted.metadataBytesBefore} metadataBytesAfter=${compacted.metadataBytesAfter} reclaimableBytes=${compacted.reclaimableBytes}`,
      ];
      for (const candidate of compacted.candidates.slice(0, 20)) {
        lines.push(
          `- ${candidate.ref}: ${candidate.metadataBytesBefore} -> ${candidate.metadataBytesAfter} metadata bytes`,
        );
      }
      if (compacted.candidates.length > 20)
        lines.push(`- … ${compacted.candidates.length - 20} more candidate(s)`);
      return toolResult("evidence", action, lines.join("\n"), {
        changed: !compacted.dryRun && compacted.compacted > 0,
        dryRun: compacted.dryRun,
        compaction: compacted,
      });
    },
  });
}

export { registerProductArtifactTool } from "./product/extension.ts";

export function registerSparkArtifactTool(pi: SparkArtifactsHostApi): void {
  registerEvidenceTool(pi);
  registerProductArtifactTool(pi);
}

export default function sparkArtifactsExtension(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("spark-artifacts extension requires registerTool support");
  registerSparkArtifactTool({ registerTool: (config) => pi.registerTool?.(config) });
}

function renderEvidenceCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const target =
    typeof args.evidenceRef === "string"
      ? args.evidenceRef
      : typeof args.from === "string"
        ? args.from
        : undefined;
  const text = ["evidence", `action=${action}`, target].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}

function toolResult(
  tool: "evidence",
  action: EvidenceAction,
  text: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    details: { tool, action, ...details },
  };
}

/** Lean agent-ledger detail (no blob paths / hashes — those are store internals). */
function compactEvidenceDetail(entry: Evidence): Record<string, unknown> {
  return {
    ref: entry.ref,
    kind: entry.kind,
    title: entry.title,
    format: entry.format,
    producer: entry.provenance.producer,
    projectRef: entry.provenance.projectRef,
    taskRef: entry.provenance.taskRef,
    roleRef: entry.provenance.roleRef,
    runRef: entry.provenance.runRef,
    curation: entry.curation?.status ?? "raw",
    bodySize: entry.bodySize,
    updatedAt: entry.updatedAt,
  };
}

function compactEvidenceSummaryDetail(entry: Evidence): Record<string, unknown> {
  return {
    ref: entry.ref,
    kind: entry.kind,
    title: entry.title,
    producer: entry.provenance.producer,
    projectRef: entry.provenance.projectRef,
    taskRef: entry.provenance.taskRef,
    curation: entry.curation?.status ?? "raw",
    updatedAt: entry.updatedAt,
  };
}

function renderEvidenceListLine(entry: Evidence, view: EvidenceListView): string {
  if (view === "ref-only") return `- ${entry.ref}`;
  return `- [${entry.kind}] ${entry.ref}: ${entry.title} curation=${renderCurationLabel(entry)}`;
}

function renderCurationLabel(entry: Evidence): string {
  const status = entry.curation?.status ?? "uncurated";
  const retention = entry.curation?.retention;
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

function normalizeAction(value: unknown): EvidenceAction {
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
    "evidence.action must be record, list, read, link, compact, promote, archive, or supersede",
  );
}

function normalizeEvidenceListView(value: unknown): EvidenceListView {
  if (value === undefined || value === null) return "ref-only";
  if (value === "ref-only" || value === "summary") return value;
  throw new Error("view must be ref-only or summary");
}

function normalizeEvidenceKind(value: unknown, field: string): EvidenceKind {
  if (!isEvidenceKind(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid evidence kind", EVIDENCE_KINDS, {
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

function normalizeOptionalEvidenceKind(value: unknown, field: string): EvidenceKind | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeEvidenceKind(value, field);
}

function normalizeEvidenceFormat(value: unknown, field: string): EvidenceFormat {
  if (!isEvidenceFormat(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid evidence format", EVIDENCE_FORMATS),
    );
  }
  return value;
}

function normalizeEvidenceRelation(value: unknown, field: string): EvidenceLink["relation"] {
  if (!isEvidenceLinkRelation(value)) {
    throw new Error(
      formatValidValuesError(
        field,
        value,
        "a valid evidence link relation",
        EVIDENCE_LINK_RELATIONS,
      ),
    );
  }
  return value;
}

function normalizeOptionalProducer(
  value: unknown,
  field: string,
): EvidenceProvenance["producer"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isEvidenceProducer(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid evidence producer", EVIDENCE_PRODUCERS, {
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
): EvidenceCurationStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isEvidenceCurationStatus(value)) {
    throw new Error(
      formatValidValuesError(
        field,
        value,
        "a valid evidence curation status",
        EVIDENCE_CURATION_STATUSES,
      ),
    );
  }
  return value;
}

function normalizeOptionalRetention(value: unknown, field: string): EvidenceRetention | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isEvidenceRetention(value)) {
    throw new Error(
      formatValidValuesError(field, value, "a valid evidence retention", EVIDENCE_RETENTIONS),
    );
  }
  return value;
}

function normalizeOptionalCuration(value: unknown, field: string): EvidenceCuration | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const status = normalizeOptionalCurationStatus(value.status, `${field}.status`);
  if (!status) throw new Error(`${field}.status is required`);
  const curation: EvidenceCuration = { status };
  const retention = normalizeOptionalRetention(value.retention, `${field}.retention`);
  const reason = normalizeOptionalString(value.reason, `${field}.reason`);
  const promotedFrom = normalizeOptionalEvidenceRefArray(
    value.promotedFrom,
    `${field}.promotedFrom`,
  );
  const supersededBy = normalizeOptionalEvidenceRefArray(
    value.supersededBy,
    `${field}.supersededBy`,
  );
  const compactedInto = normalizeOptionalEvidenceRef(value.compactedInto, `${field}.compactedInto`);
  const expiresAt = normalizeOptionalString(value.expiresAt, `${field}.expiresAt`);
  if (retention) curation.retention = retention;
  if (reason) curation.reason = reason;
  if (promotedFrom) curation.promotedFrom = promotedFrom;
  if (supersededBy) curation.supersededBy = supersededBy;
  if (compactedInto) curation.compactedInto = compactedInto;
  if (expiresAt) curation.expiresAt = expiresAt;
  return curation;
}

function normalizeEvidenceBody(value: unknown, format: EvidenceFormat): JsonValue | string {
  if (format === "markdown" || format === "text") {
    if (typeof value !== "string") throw new Error(`body must be a string for ${format} evidence`);
    return value;
  }
  if (!isJsonValue(value)) throw new Error("body must be a JSON value for json evidence");
  return value;
}

function normalizeRecordEvidenceProvenance(params: Record<string, unknown>): EvidenceProvenance {
  const provenance = normalizeEvidenceProvenance(params.provenance);
  const projectRef = normalizeOptionalRefOfKind(params.projectRef, "proj", "projectRef");
  const taskRef = normalizeOptionalRefOfKind(params.taskRef, "task", "taskRef");
  const roleRef = normalizeOptionalRefOfKind(params.roleRef, "role", "roleRef");
  return {
    ...provenance,
    ...(projectRef
      ? {
          projectRef: mergeEvidenceProvenanceRef(
            provenance.projectRef,
            projectRef,
            "projectRef",
          ) as EvidenceProvenance["projectRef"],
        }
      : {}),
    ...(taskRef
      ? {
          taskRef: mergeEvidenceProvenanceRef(
            provenance.taskRef,
            taskRef,
            "taskRef",
          ) as EvidenceProvenance["taskRef"],
        }
      : {}),
    ...(roleRef
      ? {
          roleRef: mergeEvidenceProvenanceRef(
            provenance.roleRef,
            roleRef,
            "roleRef",
          ) as EvidenceProvenance["roleRef"],
        }
      : {}),
  };
}

function mergeEvidenceProvenanceRef(
  existing: string | undefined,
  shortcut: string,
  field: string,
): string {
  if (!existing || existing === shortcut) return shortcut;
  throw new Error(`${field} conflicts with provenance.${field}`);
}

function normalizeEvidenceProvenance(value: unknown): EvidenceProvenance {
  if (!isRecord(value)) throw new Error("provenance must be an object");
  const producer = normalizeOptionalProducer(value.producer, "provenance.producer");
  if (!producer) throw new Error("provenance.producer is required");
  const provenance: EvidenceProvenance = { producer };
  const runRef = normalizeOptionalRefOfKind(value.runRef, "run", "provenance.runRef");
  const projectRef = normalizeOptionalRefOfKind(value.projectRef, "proj", "provenance.projectRef");
  const taskRef = normalizeOptionalRefOfKind(value.taskRef, "task", "provenance.taskRef");
  const roleRef = normalizeOptionalRefOfKind(value.roleRef, "role", "provenance.roleRef");
  const note = normalizeOptionalString(value.note, "provenance.note");
  const parentEvidenceRefs = normalizeOptionalStringArray(
    value.parentEvidenceRefs,
    "provenance.parentEvidenceRefs",
  ) as EvidenceRef[] | undefined;
  if (runRef) provenance.runRef = runRef as EvidenceProvenance["runRef"];
  if (projectRef) provenance.projectRef = projectRef as EvidenceProvenance["projectRef"];
  if (taskRef) provenance.taskRef = taskRef as EvidenceProvenance["taskRef"];
  if (roleRef) provenance.roleRef = roleRef as EvidenceProvenance["roleRef"];
  if (note) provenance.note = note;
  if (parentEvidenceRefs) provenance.parentEvidenceRefs = parentEvidenceRefs;
  return provenance;
}

function normalizeEvidenceLinks(value: unknown): Omit<EvidenceLink, "from">[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("links must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`links[${index}] must be an object`);
    return {
      to: normalizeRequiredRef(entry.to, `links[${index}].to`) as EvidenceLink["to"],
      relation: normalizeEvidenceRelation(entry.relation, `links[${index}].relation`),
    };
  });
}

function normalizeEvidenceRef(value: unknown, field: string): EvidenceRef {
  const ref = normalizeRequiredRef(value, field);
  if (!ref.startsWith("evidence:")) throw new Error(`${field} must be an evidence: ref`);
  return ref as EvidenceRef;
}

function normalizeOptionalEvidenceRef(value: unknown, field: string): EvidenceRef | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeEvidenceRef(value, field);
}

function normalizeOptionalEvidenceRefArray(
  value: unknown,
  field: string,
): EvidenceRef[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => normalizeEvidenceRef(entry, `${field}[${index}]`));
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
