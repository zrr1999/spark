import { Type } from "typebox";
import {
  defaultLearningStore,
  type LearningLocation,
  type LearningStore,
} from "@zendev-lab/pi-learnings";
import { normalizeArtifactLimit, truncateBlock } from "./artifact-tools.ts";
import { registerSparkLearningImportExportTools } from "./learning-import-export-tool-registration.ts";
import {
  compactLearningDetail,
  compactLearningSearchResult,
  formatLearningLine,
  formatLearningSearchLine,
  normalizeLearningArtifactRef,
  normalizeLearningBoolean,
  normalizeLearningCategory,
  normalizeLearningInput,
  normalizeLearningLocation,
  normalizeLearningStatusFilter,
  normalizeLearningString,
  normalizeStringArray,
} from "./learning-tools.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

export function registerSparkLearningTools(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "impl_learning_record",
    label: "Spark Learning Record",
    description:
      "Record one evidence-backed reusable learning under local .learnings/ or the user learning directory. Use export tools for sharing.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Stable learning id. Defaults to a content hash." }),
      ),
      title: Type.String({ description: "Short learning title." }),
      statement: Type.String({ description: "Reusable judgment or rule learned from evidence." }),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      status: Type.Optional(
        Type.String({ description: "candidate | active | stale | superseded | rejected" }),
      ),
      applicability: Type.Optional(Type.String({ description: "When this learning applies." })),
      nonApplicability: Type.Optional(
        Type.String({ description: "When this learning should not apply." }),
      ),
      rationale: Type.Optional(Type.String({ description: "Why this learning is useful." })),
      evidenceRefs: Type.Optional(
        Type.Array(Type.String({ description: "Evidence refs or paths." })),
      ),
      sourcePaths: Type.Optional(Type.Array(Type.String({ description: "Source file paths." }))),
      sourceHash: Type.Optional(Type.String({ description: "Hash of imported source content." })),
      sourceContent: Type.Optional(
        Type.String({ description: "Original source Markdown content." }),
      ),
      dependsOn: Type.Optional(
        Type.Array(Type.String({ description: "Learning or fact refs this depends on." })),
      ),
      supersedes: Type.Optional(
        Type.Array(Type.String({ description: "Learning refs this replaces." })),
      ),
      contradictedBy: Type.Optional(
        Type.Array(Type.String({ description: "Refs that contradict this learning." })),
      ),
      tags: Type.Optional(Type.Array(Type.String({ description: "Search tags." }))),
      confidence: Type.Optional(Type.Number({ description: "Evidence confidence from 0 to 1." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctx.cwd, normalizeLearningLocation(params.location));
      const artifact = await store.record(normalizeLearningInput(params));
      return {
        content: [
          {
            type: "text",
            text: `Recorded learning ${artifact.ref} [${artifact.body.status}] ${artifact.body.title}`,
          },
        ],
        details: { learning: compactLearningDetail(artifact, store.location) },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_search",
    label: "Spark Learning Search",
    description:
      "Search local Spark learnings. Defaults to active learnings only; candidates are opt-in.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      status: Type.Optional(
        Type.Union([
          Type.String({ description: "Single learning status." }),
          Type.Array(Type.String({ description: "Learning status." })),
        ]),
      ),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      includeCandidates: Type.Optional(Type.Boolean({ default: false })),
      includeInactive: Type.Optional(Type.Boolean({ default: false })),
      limit: Type.Optional(Type.Number({ description: "Maximum results. Default: 10." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const stores = learningStoresForQuery(ctx.cwd, normalizeLearningLocation(params.location));
      const limit = normalizeArtifactLimit(params.limit, 10, "limit");
      const query = {
        query: normalizeLearningString(params.query, "query", { required: true }) ?? "",
        status: normalizeLearningStatusFilter(params.status),
        category: normalizeLearningCategory(params.category),
        tag: normalizeLearningString(params.tag, "tag"),
        includeCandidates: normalizeLearningBoolean(
          params.includeCandidates,
          false,
          "includeCandidates",
        ),
        includeInactive: normalizeLearningBoolean(params.includeInactive, false, "includeInactive"),
        limit,
      };
      const results = (await Promise.all(stores.map((store) => store.search(query))))
        .flat()
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return right.record.updatedAt.localeCompare(left.record.updatedAt);
        })
        .slice(0, limit);
      const lines = [
        `Spark learnings: ${results.length} result(s)`,
        ...results.map(formatLearningSearchLine),
      ];
      if (results.length === 0) lines.push("- No matching learnings.");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: results.length, results: results.map(compactLearningSearchResult) },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_list",
    label: "Spark Learning List",
    description: "List local Spark learnings with compact metadata.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.String({ description: "Single learning status." }),
          Type.Array(Type.String({ description: "Learning status." })),
        ]),
      ),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      includeCandidates: Type.Optional(Type.Boolean({ default: false })),
      includeInactive: Type.Optional(Type.Boolean({ default: false })),
      limit: Type.Optional(Type.Number({ description: "Maximum rows. Default: 20." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const stores = learningStoresForQuery(ctx.cwd, normalizeLearningLocation(params.location));
      const limit = normalizeArtifactLimit(params.limit, 20, "limit");
      const filter = {
        status: normalizeLearningStatusFilter(params.status),
        category: normalizeLearningCategory(params.category),
        tag: normalizeLearningString(params.tag, "tag"),
        includeCandidates: normalizeLearningBoolean(
          params.includeCandidates,
          false,
          "includeCandidates",
        ),
        includeInactive: normalizeLearningBoolean(params.includeInactive, false, "includeInactive"),
      };
      const artifacts = (
        await Promise.all(
          stores.map(async (store) =>
            (await store.list(filter)).map((artifact) => ({ artifact, location: store.location })),
          ),
        )
      )
        .flat()
        .sort((left, right) => right.artifact.updatedAt.localeCompare(left.artifact.updatedAt));
      const visible = artifacts.slice(0, limit);
      const lines = [
        `Spark learnings: ${artifacts.length}${visible.length < artifacts.length ? ` (showing ${visible.length})` : ""}`,
        ...visible.map(({ artifact, location }) => formatLearningLine(artifact, location)),
      ];
      if (visible.length === 0) lines.push("- No learnings.");
      if (visible.length < artifacts.length)
        lines.push(`- … ${artifacts.length - visible.length} more learning(s)`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: artifacts.length,
          shown: visible.length,
          learnings: visible.map(({ artifact, location }) =>
            compactLearningDetail(artifact, location),
          ),
        },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_read",
    label: "Spark Learning Read",
    description: "Read one Spark learning by artifact ref or stable id.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning artifact ref or stable id." }),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      maxChars: Type.Optional(
        Type.Number({ description: "Maximum JSON chars to show. Default: 4000." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctx.cwd, normalizeLearningLocation(params.location));
      const maxChars = normalizeArtifactLimit(params.maxChars, 4_000, "maxChars");
      const artifact = await store.get(normalizeLearningArtifactRef(params.ref));
      const body = JSON.stringify(artifact.body, null, 2);
      const renderedBody = truncateBlock(body, maxChars);
      const truncated = renderedBody.length < body.length;
      const lines = [
        `${artifact.ref} [${artifact.body.status}/${artifact.body.category}/${store.location}] ${artifact.body.title}`,
        `updated=${artifact.updatedAt} evidence=${artifact.body.evidenceRefs.length}`,
        "",
        renderedBody,
      ];
      if (truncated)
        lines.push(
          "",
          `… truncated ${body.length - renderedBody.length} char(s); increase maxChars for a larger bounded preview`,
        );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          learning: compactLearningDetail(artifact, store.location),
          bodyChars: body.length,
          shownChars: renderedBody.length,
          truncated,
        },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_mark_stale",
    label: "Spark Learning Mark Stale",
    description: "Mark one learning stale with an explicit reason.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning artifact ref or stable id." }),
      reason: Type.String({ description: "Why this learning is stale." }),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctx.cwd, normalizeLearningLocation(params.location));
      const artifact = await store.markStale(
        normalizeLearningArtifactRef(params.ref),
        normalizeLearningString(params.reason, "reason", { required: true }) ?? "",
      );
      return {
        content: [{ type: "text", text: `Marked stale ${artifact.ref}: ${artifact.body.title}` }],
        details: { learning: compactLearningDetail(artifact, store.location) },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_supersede",
    label: "Spark Learning Supersede",
    description: "Mark a learning superseded by one or more replacement learning refs.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning artifact ref or stable id to supersede." }),
      supersededBy: Type.Array(Type.String({ description: "Replacement learning ref." })),
      reason: Type.Optional(Type.String({ description: "Why it was superseded." })),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctx.cwd, normalizeLearningLocation(params.location));
      const artifact = await store.markSuperseded(
        normalizeLearningArtifactRef(params.ref),
        normalizeStringArray(params.supersededBy, "supersededBy") ?? [],
        normalizeLearningString(params.reason, "reason"),
      );
      return {
        content: [
          { type: "text", text: `Marked superseded ${artifact.ref}: ${artifact.body.title}` },
        ],
        details: { learning: compactLearningDetail(artifact, store.location) },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_reject",
    label: "Spark Learning Reject",
    description: "Reject one learning candidate while keeping a traceable rejected record.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning candidate artifact ref or stable id." }),
      reason: Type.String({ description: "Why this candidate is rejected." }),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctx.cwd, normalizeLearningLocation(params.location));
      const artifact = await store.rejectCandidate(
        normalizeLearningArtifactRef(params.ref),
        normalizeLearningString(params.reason, "reason", { required: true }) ?? "",
      );
      return {
        content: [
          {
            type: "text",
            text: `Rejected learning candidate ${artifact.ref}: ${artifact.body.title}`,
          },
        ],
        details: { learning: compactLearningDetail(artifact, store.location) },
      };
    },
  });

  registerSparkLearningImportExportTools(registerSparkTool);
}

function learningStoresForQuery(
  cwd: string,
  location: LearningLocation | undefined,
): LearningStore[] {
  if (location) return [defaultLearningStore(cwd, location)];
  const current = defaultLearningStore(cwd);
  if (current.location === "user") return [current];
  return [current, defaultLearningStore(cwd, "user")];
}
