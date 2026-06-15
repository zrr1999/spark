import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Type } from "typebox";
import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import {
  defaultLearningStore,
  renderLearningExportMarkdown,
  type LearningRecord,
} from "@zendev-lab/pi-learnings";
import type { Artifact } from "@zendev-lab/pi-artifacts";
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
    name: "spark_learning_export_markdown",
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
    name: "spark_learning_import_markdown",
    label: "Spark Learning Import Markdown",
    description:
      'Import Markdown produced by learning({ action: "export_markdown" }), or legacy compound-learnings Markdown/.learnings directories. Dry-run by default; set apply=true to persist.',
    parameters: Type.Object({
      inputPath: Type.String({
        description:
          "Path to a Spark learnings export, legacy learning Markdown file, or .learnings directory.",
      }),
      apply: Type.Optional(Type.Boolean({ default: false })),
      deleteLegacyAfterVerifiedExport: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "When importing legacy compound-learnings with apply=true, write a verification export then delete the legacy source path.",
        }),
      ),
      verificationExportPath: Type.Optional(
        Type.String({ description: "Optional path for the verification export before deletion." }),
      ),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const inputPath = resolve(
        cwd,
        normalizeLearningString(params.inputPath, "inputPath", { required: true }) ?? "",
      );
      const apply = normalizeLearningBoolean(params.apply, false, "apply");
      const deleteLegacyAfterVerifiedExport = normalizeLearningBoolean(
        params.deleteLegacyAfterVerifiedExport,
        false,
        "deleteLegacyAfterVerifiedExport",
      );
      if (deleteLegacyAfterVerifiedExport && !apply)
        throw new Error("deleteLegacyAfterVerifiedExport requires apply=true");
      const verificationExportPathValue = normalizeLearningString(
        params.verificationExportPath,
        "verificationExportPath",
      );
      const parsed = await parseLearningImportPath(cwd, inputPath);
      const count = parsed.records.length + parsed.inputs.length;
      const store = defaultLearningStore(cwd, normalizeLearningLocation(params.location));
      const imported: Artifact<LearningRecord>[] = [];
      if (apply) {
        for (const record of parsed.records) imported.push(await store.restore(record));
        for (const input of parsed.inputs) imported.push(await store.record(input));
      }
      if (deleteLegacyAfterVerifiedExport && parsed.source !== "legacy-compound-learnings")
        throw new Error(
          "deleteLegacyAfterVerifiedExport only applies to legacy compound-learnings imports",
        );
      if (deleteLegacyAfterVerifiedExport && imported.length !== count)
        throw new Error(
          "refusing to delete legacy learnings because import count did not match parsed count",
        );
      let verificationExportArtifact: Artifact | undefined;
      let verificationExportPath: string | undefined;
      if (deleteLegacyAfterVerifiedExport) {
        const markdown = renderLearningExportMarkdown(imported.map((artifact) => artifact.body));
        verificationExportArtifact = await defaultArtifactStore(cwd).put({
          kind: "document",
          title: "Legacy compound-learnings import verification export",
          format: "markdown",
          body: markdown,
          provenance: {
            producer: "task",
            note: "pi-learning legacy import verification export",
          },
          links: imported.map((artifact) => ({
            to: artifact.ref,
            relation: "derived-from" as const,
          })),
        });
        verificationExportPath = verificationExportPathValue?.trim()
          ? resolve(cwd, verificationExportPathValue)
          : undefined;
        if (verificationExportPath) {
          await mkdir(dirname(verificationExportPath), { recursive: true });
          await writeFile(verificationExportPath, markdown, "utf8");
        }
        if (learningStoreRoot(store) === resolve(inputPath)) {
          await removeLegacyCompoundLearningContents(inputPath);
        } else {
          await rm(inputPath, { recursive: true, force: false });
        }
      }
      const action = apply ? "Imported" : "Dry-run parsed";
      const deletionSuffix = deleteLegacyAfterVerifiedExport
        ? `; verification export ${verificationExportArtifact?.ref}; deleted legacy source`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${count} learning(s) from ${inputPath} (${parsed.source})${deletionSuffix}`,
          },
        ],
        details: {
          inputPath,
          source: parsed.source,
          apply,
          count,
          imported: imported.map((artifact) => compactLearningDetail(artifact, store.location)),
          deletedLegacySource: deleteLegacyAfterVerifiedExport,
          verificationExportArtifact: verificationExportArtifact
            ? compactArtifactDetail(verificationExportArtifact)
            : undefined,
          verificationExportPath,
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

function learningStoreRoot(store: ReturnType<typeof defaultLearningStore>): string | undefined {
  const { artifactStore } = store;
  if ("rootDir" in artifactStore && typeof artifactStore.rootDir === "string")
    return resolve(artifactStore.rootDir);
  return undefined;
}

async function removeLegacyCompoundLearningContents(rootDir: string): Promise<void> {
  for (const entry of ["patterns", "gotchas", "decisions", "README.md"])
    await rm(join(rootDir, entry), { recursive: true, force: true });
}
