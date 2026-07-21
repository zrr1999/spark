/** Product-facing artifact kinds only. Internal evidence uses document|record|trace|knowledge. */
export type ProductArtifactKind = "issue" | "pr" | "preview";

export const PRODUCT_ARTIFACT_KINDS = [
  "issue",
  "pr",
  "preview",
] as const satisfies readonly ProductArtifactKind[];

export type ProductArtifactRef = `artifact:${string}` & { readonly __product?: "artifact" };

export type ForgeHost = "github" | "gitlab";

export type ProductArtifactFormat = "json" | "markdown" | "mdx" | "html" | "text";

export const PRODUCT_ARTIFACT_FORMATS = [
  "json",
  "markdown",
  "mdx",
  "html",
  "text",
] as const satisfies readonly ProductArtifactFormat[];

export type PreviewContentFormat = "md" | "mdx" | "html";

export interface PreviewProgress {
  label?: string;
  percent?: number;
  stage?: string;
}

export interface IssueArtifactBody {
  schemaVersion: 1;
  kind: "issue";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
}

export type WorktreeStatus = "attached" | "failed" | "missing" | "removed";

export interface PrArtifactBody {
  schemaVersion: 1;
  kind: "pr";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
  headRef: string;
  baseRef: string;
  draft?: boolean;
  checksSummary?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStatus?: WorktreeStatus;
  worktreeError?: string;
  diffSummary?: string;
}

export interface PreviewArtifactBody {
  schemaVersion: 1;
  kind: "preview";
  format: PreviewContentFormat;
  content: string;
  version: number;
  progress?: PreviewProgress;
}

export type ProductArtifactBody = IssueArtifactBody | PrArtifactBody | PreviewArtifactBody;

export interface ProductArtifact<T extends ProductArtifactBody = ProductArtifactBody> {
  ref: ProductArtifactRef;
  kind: ProductArtifactKind;
  title: string;
  format: ProductArtifactFormat;
  body: T;
  hash?: string;
  blobPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PutProductArtifactInput<T extends ProductArtifactBody = ProductArtifactBody> {
  kind: ProductArtifactKind;
  title: string;
  format?: ProductArtifactFormat;
  body: T;
  ref?: ProductArtifactRef;
}

export interface ProductArtifactQuery {
  kind?: ProductArtifactKind;
}

export interface ProductArtifactStoreOptions {
  rootDir: string;
}

export function isProductArtifactKind(value: unknown): value is ProductArtifactKind {
  return PRODUCT_ARTIFACT_KINDS.includes(value as ProductArtifactKind);
}

export function isProductArtifactFormat(value: unknown): value is ProductArtifactFormat {
  return PRODUCT_ARTIFACT_FORMATS.includes(value as ProductArtifactFormat);
}

export function isProductArtifactBody(value: unknown): value is ProductArtifactBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return false;
  if (record.kind === "issue" || record.kind === "pr") {
    return (
      (record.forge === "github" || record.forge === "gitlab") &&
      typeof record.repo === "string" &&
      typeof record.number === "number" &&
      typeof record.url === "string" &&
      typeof record.state === "string" &&
      typeof record.title === "string" &&
      (record.kind === "issue" ||
        (typeof record.headRef === "string" && typeof record.baseRef === "string"))
    );
  }
  if (record.kind === "preview") {
    return (
      (record.format === "md" || record.format === "mdx" || record.format === "html") &&
      typeof record.content === "string" &&
      typeof record.version === "number"
    );
  }
  return false;
}

export function asJsonValue(body: ProductArtifactBody): Record<string, unknown> {
  return body as unknown as Record<string, unknown>;
}
