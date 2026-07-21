import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { writeJsonFileAtomic, writeTextFileAtomic } from "@zendev-lab/spark-core";
import {
  asJsonValue,
  isProductArtifactBody,
  isProductArtifactFormat,
  isProductArtifactKind,
  type ProductArtifact,
  type ProductArtifactBody,
  type ProductArtifactFormat,
  type ProductArtifactKind,
  type ProductArtifactQuery,
  type ProductArtifactRef,
  type ProductArtifactStoreOptions,
  type PutProductArtifactInput,
} from "./types.ts";

export class ProductArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductArtifactValidationError";
  }
}

export class ProductArtifactStore {
  readonly rootDir: string;
  readonly blobDir: string;

  constructor(options: ProductArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.blobDir = join(options.rootDir, "blobs");
  }

  async put<T extends ProductArtifactBody>(
    input: PutProductArtifactInput<T>,
  ): Promise<ProductArtifact<T>> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.blobDir, { recursive: true });
    if (!isProductArtifactKind(input.kind)) {
      throw new ProductArtifactValidationError(
        `invalid product artifact kind: ${String(input.kind)}`,
      );
    }
    if (input.body.kind !== input.kind) {
      throw new ProductArtifactValidationError(
        `body.kind (${input.body.kind}) must match artifact kind (${input.kind})`,
      );
    }
    if (!isProductArtifactBody(input.body)) {
      throw new ProductArtifactValidationError("invalid product artifact body");
    }
    const format = input.format ?? defaultFormatForKind(input.kind);
    if (!isProductArtifactFormat(format)) {
      throw new ProductArtifactValidationError(`invalid format: ${String(format)}`);
    }
    const now = new Date().toISOString();
    const ref = input.ref ?? newProductArtifactRef();
    const existing = input.ref ? await this.tryGet<T>(input.ref) : null;
    const serialized = serializeBody(format, input.body);
    const hash = createHash("sha256").update(serialized).digest("hex");
    const blobPath = join("blobs", `${hash}.${extensionForFormat(format)}`);
    const artifact: ProductArtifact<T> = {
      ref,
      kind: input.kind,
      title: input.title.trim(),
      format,
      body: input.body,
      hash,
      blobPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!artifact.title) throw new ProductArtifactValidationError("title is required");
    await writeTextFileAtomic(join(this.rootDir, blobPath), serialized);
    await writeJsonFileAtomic(this.pathFor(ref), {
      ...artifact,
      body: asJsonValue(input.body),
    });
    return artifact;
  }

  async update<T extends ProductArtifactBody>(
    ref: ProductArtifactRef,
    patch: Partial<Omit<PutProductArtifactInput<T>, "ref">>,
  ): Promise<ProductArtifact<T>> {
    const existing = await this.get<T>(ref);
    return this.put<T>({
      ref,
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      format: patch.format ?? existing.format,
      body: patch.body ?? existing.body,
    });
  }

  async get<T extends ProductArtifactBody = ProductArtifactBody>(
    ref: ProductArtifactRef,
  ): Promise<ProductArtifact<T>> {
    const raw = await readJson(this.pathFor(ref));
    const artifact = normalizeProductArtifact<T>(raw);
    if (artifact.blobPath) {
      const blobPath = resolveBlobPath(this.rootDir, artifact.blobPath);
      if (!blobPath) {
        throw new ProductArtifactValidationError(`blob path escapes store: ${ref}`);
      }
      const serialized = await readFile(blobPath, "utf8");
      artifact.body = parseBody(artifact.format, serialized) as T;
    }
    return artifact;
  }

  async tryGet<T extends ProductArtifactBody = ProductArtifactBody>(
    ref: ProductArtifactRef,
  ): Promise<ProductArtifact<T> | null> {
    try {
      return await this.get<T>(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: ProductArtifactQuery = {}): Promise<ProductArtifact[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const artifacts: ProductArtifact[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let artifact: ProductArtifact;
      try {
        artifact = normalizeProductArtifact(await readJson(join(this.rootDir, entry.name)));
      } catch {
        continue;
      }
      if (!isProductArtifactKind(artifact.kind)) continue;
      if (filter.kind && artifact.kind !== filter.kind) continue;
      artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pathFor(ref: ProductArtifactRef): string {
    return join(this.rootDir, `${refId(ref)}.json`);
  }
}

export function newProductArtifactRef(id: string = randomUUID()): ProductArtifactRef {
  if (!id || id.includes(":")) {
    throw new ProductArtifactValidationError(`invalid artifact id: ${id}`);
  }
  return `artifact:${id}` as ProductArtifactRef;
}

export function defaultProductArtifactStore(cwd: string): ProductArtifactStore {
  return new ProductArtifactStore({ rootDir: join(cwd, ".spark", "artifacts") });
}

function defaultFormatForKind(kind: ProductArtifactKind): ProductArtifactFormat {
  switch (kind) {
    case "preview":
      return "mdx";
    case "issue":
    case "pr":
      return "json";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function extensionForFormat(format: ProductArtifactFormat): string {
  switch (format) {
    case "markdown":
    case "mdx":
      return "md";
    case "html":
      return "html";
    case "json":
      return "json";
    case "text":
      return "txt";
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

function serializeBody(_format: ProductArtifactFormat, body: ProductArtifactBody): string {
  return JSON.stringify(body, null, 2);
}

function parseBody(_format: ProductArtifactFormat, serialized: string): ProductArtifactBody {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isProductArtifactBody(parsed)) {
    throw new ProductArtifactValidationError("blob is not a valid product artifact body");
  }
  return parsed;
}

function normalizeProductArtifact<T extends ProductArtifactBody>(raw: unknown): ProductArtifact<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProductArtifactValidationError("product artifact metadata must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.ref !== "string" || !record.ref.startsWith("artifact:")) {
    throw new ProductArtifactValidationError("product artifact ref must be artifact:…");
  }
  if (!isProductArtifactKind(record.kind)) {
    throw new ProductArtifactValidationError("kind must be issue, pr, or preview");
  }
  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new ProductArtifactValidationError("title is required");
  }
  if (!isProductArtifactFormat(record.format)) {
    throw new ProductArtifactValidationError("invalid format");
  }
  if (!isProductArtifactBody(record.body)) {
    throw new ProductArtifactValidationError("invalid body");
  }
  if (record.body.kind !== record.kind) {
    throw new ProductArtifactValidationError("body.kind must match kind");
  }
  return {
    ref: record.ref as ProductArtifactRef,
    kind: record.kind,
    title: record.title,
    format: record.format,
    body: record.body as T,
    hash: typeof record.hash === "string" ? record.hash : undefined,
    blobPath: typeof record.blobPath === "string" ? record.blobPath : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

function refId(ref: string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new ProductArtifactValidationError(`invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

function resolveBlobPath(rootDir: string, blobPath: string): string | undefined {
  if (!blobPath.trim() || blobPath.includes("\0") || isAbsolute(blobPath)) return undefined;
  const root = resolve(rootDir);
  const blobRoot = resolve(root, "blobs");
  const resolved = resolve(root, blobPath);
  const scoped = relative(blobRoot, resolved);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) return undefined;
  return resolved;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
