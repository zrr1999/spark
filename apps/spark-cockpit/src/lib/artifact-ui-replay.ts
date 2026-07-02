import {
  parseSparkUiSource,
  type SparkUiDocumentV1,
  type SparkUiJsonObject,
} from "@zendev-lab/spark-generative-ui";

export const sparkUiSourceArtifactKind = "spark.ui.source";
export const sparkUiAstArtifactKind = "spark.ui.v1";

export type ArtifactSparkUiReplay = {
  mode: "source" | "ast";
  source: string;
  document: SparkUiDocumentV1;
};

export interface ArtifactSparkUiReplayInput {
  kind: string;
  format: string;
  contentRef: Record<string, unknown>;
  previewText?: string | null;
}

export function buildArtifactSparkUiReplay(
  input: ArtifactSparkUiReplayInput,
): ArtifactSparkUiReplay | null {
  const kind = input.kind.trim().toLowerCase();
  if (isSparkUiSourceKind(kind)) {
    const source = textFromContentRef(input.contentRef) ?? input.previewText?.trim();
    if (!source) return null;
    return { mode: "source", source, document: parseSparkUiSource(source) };
  }

  if (isSparkUiAstKind(kind)) {
    const document =
      documentFromContentRef(input.contentRef) ?? documentFromPreview(input.previewText);
    if (!document) return null;
    return {
      mode: "ast",
      source: JSON.stringify(document, null, 2),
      document,
    };
  }

  return null;
}

export function generatedUiArtifactLinks(sourceArtifactId: string, _astArtifactId: string) {
  return {
    sourceLinks: [],
    astLinks: [{ targetKind: "artifact", targetId: sourceArtifactId, relation: "derived-from" }],
  };
}

function isSparkUiSourceKind(kind: string) {
  return kind === sparkUiSourceArtifactKind || kind === "spark-ui-source";
}

function isSparkUiAstKind(kind: string) {
  return kind === sparkUiAstArtifactKind || kind === "spark.ui.ast" || kind === "spark-ui-ast";
}

function textFromContentRef(contentRef: Record<string, unknown>) {
  for (const key of ["inlineMarkdown", "markdown", "inlineText", "text", "content"]) {
    const value = contentRef[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function documentFromContentRef(contentRef: Record<string, unknown>) {
  for (const key of ["inlineJson", "json", "document", "sparkUi"] as const) {
    const value = contentRef[key];
    const document = normalizeSparkUiDocument(value);
    if (document) return document;
  }
  return null;
}

function documentFromPreview(previewText: string | null | undefined) {
  if (!previewText?.trim()) return null;
  try {
    return normalizeSparkUiDocument(JSON.parse(previewText) as unknown);
  } catch {
    return null;
  }
}

function normalizeSparkUiDocument(value: unknown): SparkUiDocumentV1 | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!Array.isArray(value.blocks)) return null;
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
  return {
    schemaVersion: 1,
    sourceFormat: value.sourceFormat === "mdx-lite" ? "mdx-lite" : "mdx-lite",
    blocks: value.blocks as unknown as SparkUiDocumentV1["blocks"],
    diagnostics: diagnostics as unknown as SparkUiDocumentV1["diagnostics"],
  };
}

function isRecord(value: unknown): value is SparkUiJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
