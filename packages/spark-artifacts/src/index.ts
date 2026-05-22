import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Artifact,
  type ArtifactKind,
  type ArtifactLink,
  type ArtifactRef,
  type JsonValue,
  type Provenance,
  contentHash,
  newRef,
  nowIso,
  refId,
  validateArtifact,
} from "spark-core";

export interface PutArtifactInput<T extends JsonValue | string = JsonValue | string> {
  kind: ArtifactKind;
  title: string;
  format: Artifact["format"];
  body: T;
  provenance: Provenance;
  links?: Omit<ArtifactLink, "from">[];
  ref?: ArtifactRef;
}

export interface ArtifactStoreOptions {
  rootDir: string;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
  threadRef?: string;
  taskRef?: string;
  roleRef?: string;
  producer?: Provenance["producer"];
  linkedTo?: string;
}

export class ArtifactStore {
  readonly rootDir: string;
  readonly blobDir: string;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.blobDir = join(options.rootDir, "blobs");
  }

  async put<T extends JsonValue | string>(input: PutArtifactInput<T>): Promise<Artifact<T>> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.blobDir, { recursive: true });
    const now = nowIso();
    const ref = input.ref ?? newRef("artifact");
    const existing = input.ref ? await this.tryGet<T>(input.ref) : null;
    const serializedBody =
      typeof input.body === "string" ? input.body : JSON.stringify(input.body, null, 2);
    const hash = contentHash(serializedBody);
    const blobPath = join("blobs", `${hash}.${extensionForFormat(input.format)}`);
    await writeFile(join(this.rootDir, blobPath), serializedBody, "utf8");
    const parentLinks: ArtifactLink[] = (input.provenance.parentArtifactRefs ?? []).map(
      (parent) => ({
        from: ref,
        to: parent,
        relation: "parent",
      }),
    );
    const artifact: Artifact<T> = {
      ref,
      kind: input.kind,
      title: input.title,
      format: input.format,
      body: input.body,
      hash,
      blobPath,
      links: [...parentLinks, ...(input.links ?? []).map((link) => ({ ...link, from: ref }))],
      provenance: input.provenance,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    validateArtifact(artifact);
    await writeFile(this.pathFor(ref), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return artifact;
  }

  async update<T extends JsonValue | string>(
    ref: ArtifactRef,
    patch: Partial<Omit<PutArtifactInput<T>, "ref">>,
  ): Promise<Artifact<T>> {
    const existing = await this.get<T>(ref);
    return this.put<T>({
      ref,
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      format: patch.format ?? existing.format,
      body: patch.body ?? existing.body,
      provenance: patch.provenance ?? existing.provenance,
      links: patch.links ?? existing.links.map(({ from: _from, ...link }) => link),
    });
  }

  async get<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef,
  ): Promise<Artifact<T>> {
    const raw = await readFile(this.pathFor(ref), "utf8");
    return JSON.parse(raw) as Artifact<T>;
  }

  async getBody(ref: ArtifactRef): Promise<string> {
    const artifact = await this.get(ref);
    if (artifact.blobPath) return readFile(join(this.rootDir, artifact.blobPath), "utf8");
    return typeof artifact.body === "string"
      ? artifact.body
      : JSON.stringify(artifact.body, null, 2);
  }

  async tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef,
  ): Promise<Artifact<T> | null> {
    try {
      return await this.get<T>(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: ArtifactQuery = {}): Promise<Artifact[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const artifacts: Artifact[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const artifact = JSON.parse(
        await readFile(join(this.rootDir, entry.name), "utf8"),
      ) as Artifact;
      if (!matchesQuery(artifact, filter)) continue;
      artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async linksTo(targetRef: string): Promise<ArtifactLink[]> {
    const artifacts = await this.list({ linkedTo: targetRef });
    return artifacts.flatMap((artifact) => artifact.links.filter((link) => link.to === targetRef));
  }

  async diff(
    left: ArtifactRef,
    right: ArtifactRef,
  ): Promise<{ same: boolean; leftHash?: string; rightHash?: string }> {
    const leftArtifact = await this.get(left);
    const rightArtifact = await this.get(right);
    return {
      same: leftArtifact.hash === rightArtifact.hash,
      leftHash: leftArtifact.hash,
      rightHash: rightArtifact.hash,
    };
  }

  pathFor(ref: ArtifactRef): string {
    return join(this.rootDir, `${refId(ref)}.json`);
  }
}

export function defaultArtifactStore(cwd: string): ArtifactStore {
  return new ArtifactStore({ rootDir: join(cwd, ".spark", "artifacts") });
}

function matchesQuery(artifact: Artifact, query: ArtifactQuery): boolean {
  if (query.kind && artifact.kind !== query.kind) return false;
  if (query.producer && artifact.provenance.producer !== query.producer) return false;
  if (query.threadRef && artifact.provenance.threadRef !== query.threadRef) return false;
  if (query.taskRef && artifact.provenance.taskRef !== query.taskRef) return false;
  if (query.roleRef && artifact.provenance.roleRef !== query.roleRef) return false;
  if (query.linkedTo && !artifact.links.some((link) => link.to === query.linkedTo)) return false;
  return true;
}

function extensionForFormat(format: Artifact["format"]): string {
  if (format === "markdown") return "md";
  if (format === "json") return "json";
  return "txt";
}
