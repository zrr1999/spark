import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Type } from "typebox";
import { defaultArtifactStore, type Artifact } from "@zendev-lab/spark-artifacts";
import {
  defaultLearningStore,
  renderLearningExportMarkdown,
  type LearningRecord,
} from "@zendev-lab/spark-learnings";
import { compactArtifactDetail } from "./artifact-tools.ts";
import {
  compactLearningDetail,
  normalizeLearningBoolean,
  normalizeLearningLocation,
  normalizeLearningString,
  normalizeLearningStatusFilter,
  parseLearningImportPath,
} from "./learning-tools.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

export function registerSparkLearningImportExportTools(
  registerSparkTool: SparkToolRegistrar,
): void {
  registerSparkTool({
    name: "impl_learning_export_markdown",
    label: "Spark Learning Export Markdown",
    description:
      "Export selected local Spark learnings to an explicit Markdown artifact/file for sharing or review.",
    parameters: Type.Object({
      outputPath: Type.Optional(
        Type.String({ description: "Optional path to write the Markdown export." }),
      ),
      status: Type.Optional(
        Type.Union([
          Type.String({ description: "Single learning status." }),
          Type.Array(Type.String({ description: "Learning status." })),
        ]),
      ),
      includeCandidates: Type.Optional(Type.Boolean({ default: false })),
      includeInactive: Type.Optional(Type.Boolean({ default: false })),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const store = defaultLearningStore(cwd, normalizeLearningLocation(params.location));
      const artifacts = await store.list({
        status: normalizeLearningStatusFilter(params.status),
        includeCandidates: normalizeLearningBoolean(
          params.includeCandidates,
          false,
          "includeCandidates",
        ),
        includeInactive: normalizeLearningBoolean(params.includeInactive, false, "includeInactive"),
      });
      const markdown = renderLearningExportMarkdown(artifacts.map((artifact) => artifact.body));
      const exportArtifact = await defaultArtifactStore(cwd).put({
        kind: "document",
        title: "Spark learnings export",
        format: "markdown",
        body: markdown,
        provenance: { producer: "task", note: "pi-learning explicit export" },
        links: artifacts.map((artifact) => ({
          to: artifact.ref,
          relation: "derived-from" as const,
        })),
      });
      const outputPathValue = normalizeLearningString(params.outputPath, "outputPath");
      const outputPath = outputPathValue?.trim() ? resolve(cwd, outputPathValue) : undefined;
      if (outputPath) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, markdown, "utf8");
      }
      const suffix = outputPath ? ` and wrote ${outputPath}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Exported ${artifacts.length} learning(s) to ${exportArtifact.ref}${suffix}`,
          },
        ],
        details: {
          artifact: compactArtifactDetail(exportArtifact),
          outputPath,
          count: artifacts.length,
        },
      };
    },
  });

  registerSparkTool({
    name: "impl_learning_import_markdown",
    label: "Spark Learning Import Markdown",
    description:
      'Import Markdown produced by learning({ action: "export_markdown" }). Dry-run by default; set apply=true to persist.',
    parameters: Type.Object({
      inputPath: Type.String({
        description: "Path to a Spark learnings export Markdown file.",
      }),
      apply: Type.Optional(Type.Boolean({ default: false })),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const inputPath = resolve(
        cwd,
        normalizeLearningString(params.inputPath, "inputPath", { required: true }) ?? "",
      );
      const apply = normalizeLearningBoolean(params.apply, false, "apply");
      const parsed = await parseLearningImportPath(cwd, inputPath);
      const count = parsed.records.length + parsed.inputs.length;
      const store = defaultLearningStore(cwd, normalizeLearningLocation(params.location));
      const imported: Artifact<LearningRecord>[] = [];
      if (apply) {
        for (const record of parsed.records) imported.push(await store.restore(record));
        for (const input of parsed.inputs) imported.push(await store.record(input));
      }
      const action = apply ? "Imported" : "Dry-run parsed";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${count} learning(s) from ${inputPath} (${parsed.source})`,
          },
        ],
        details: {
          inputPath,
          source: parsed.source,
          apply,
          count,
          imported: imported.map((artifact) => compactLearningDetail(artifact, store.location)),
          records: [
            ...parsed.records.map((record) => ({
              id: record.id,
              title: record.title,
              status: record.status,
            })),
            ...parsed.inputs.map((input) => ({
              id: input.id,
              title: input.title,
              status: input.status ?? "active",
            })),
          ],
        },
      };
    },
  });
}
