import { Type } from "typebox";
import { defaultArtifactStore } from "spark-artifacts";
import {
  compactArtifactDetail,
  normalizeArtifactBoolean,
  normalizeArtifactKind,
  normalizeArtifactLimit,
  normalizeArtifactProducer,
  normalizeArtifactProjectRef,
  normalizeArtifactRef,
  normalizeArtifactRoleRef,
  normalizeArtifactTaskRef,
  truncateBlock,
} from "./artifact-tools.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

export function registerSparkArtifactTools(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "spark_list_artifacts",
    label: "Spark List Artifacts",
    description: "List Spark artifacts with a compact, bounded default view.",
    parameters: Type.Object({
      kind: Type.Optional(Type.String({ description: "Artifact kind filter, e.g. ask-answer." })),
      producer: Type.Optional(Type.String({ description: "Artifact provenance producer filter." })),
      projectRef: Type.Optional(Type.String({ description: "Filter by provenance project ref." })),
      taskRef: Type.Optional(Type.String({ description: "Filter by provenance task ref." })),
      roleRef: Type.Optional(Type.String({ description: "Filter by provenance role ref." })),
      limit: Type.Optional(Type.Number({ description: "Maximum artifacts to show. Default: 20." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultArtifactStore(ctx.cwd);
      const limit = normalizeArtifactLimit(params.limit, 20, "limit");
      const artifacts = await store.list({
        kind: normalizeArtifactKind(params.kind),
        producer: normalizeArtifactProducer(params.producer),
        projectRef: normalizeArtifactProjectRef(params.projectRef),
        taskRef: normalizeArtifactTaskRef(params.taskRef),
        roleRef: normalizeArtifactRoleRef(params.roleRef),
      });
      const newest = artifacts.slice().reverse();
      const visible = newest.slice(0, limit);
      const lines = [
        `Spark artifacts: ${artifacts.length}${visible.length < artifacts.length ? ` (showing ${visible.length})` : ""}`,
      ];
      for (const artifact of visible)
        lines.push(`- [${artifact.kind}] ${artifact.ref}: ${artifact.title}`);
      if (visible.length < artifacts.length)
        lines.push(`- … ${artifacts.length - visible.length} more artifact(s)`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: artifacts.length,
          shown: visible.length,
          artifacts: visible.map(compactArtifactDetail),
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_get_artifact",
    label: "Spark Get Artifact",
    description:
      "Read one Spark artifact. Defaults to metadata plus a truncated body; set full=true for the complete body.",
    parameters: Type.Object({
      artifactRef: Type.String({ description: "Artifact ref, e.g. artifact:<uuid>." }),
      full: Type.Optional(Type.Boolean({ default: false })),
      maxChars: Type.Optional(
        Type.Number({ description: "Maximum body chars when full=false. Default: 4000." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultArtifactStore(ctx.cwd);
      const full = normalizeArtifactBoolean(params.full, false, "full");
      const maxChars = normalizeArtifactLimit(params.maxChars, 4_000, "maxChars");
      const artifactRef = normalizeArtifactRef(params.artifactRef);
      const artifact = await store.get(artifactRef);
      const body = await store.getBody(artifactRef);
      const renderedBody = full ? body : truncateBlock(body, maxChars);
      const truncated = !full && renderedBody.length < body.length;
      const lines = [
        `${artifact.ref} [${artifact.kind}] ${artifact.title}`,
        `format=${artifact.format} producer=${artifact.provenance.producer} updated=${artifact.updatedAt}`,
        "",
        renderedBody,
      ];
      if (truncated)
        lines.push(
          "",
          `… truncated ${body.length - renderedBody.length} char(s); call full=true for the complete artifact body`,
        );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          artifact: compactArtifactDetail(artifact),
          bodyChars: body.length,
          shownChars: renderedBody.length,
          truncated,
        },
      };
    },
  });
}
