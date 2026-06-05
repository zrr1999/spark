import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonFileAtomic } from "spark-core";

export type RecallScope = "user" | "workspace" | "repo";
export type RecallCandidateStatus = "candidate" | "rejected";

export interface RecallCandidate {
  id: string;
  scope: RecallScope;
  text: string;
  reason: string;
  evidenceRefs: string[];
  status: RecallCandidateStatus;
  createdAt: string;
  updatedAt: string;
  rejectedReason?: string;
}

export interface RecallStoreSnapshot {
  version: 1;
  candidates: RecallCandidate[];
}

export class RecallStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid recall store: ${filePath}: ${message}`);
    this.name = "RecallStoreFormatError";
    this.filePath = filePath;
  }
}

export class RecallStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(): Promise<RecallCandidate[]> {
    const snapshot = await this.loadSnapshot();
    return snapshot.candidates;
  }

  async record(input: {
    scope: RecallScope;
    text: string;
    reason: string;
    evidenceRefs?: string[];
  }): Promise<RecallCandidate> {
    const now = new Date().toISOString();
    const snapshot = await this.loadSnapshot();
    const candidate: RecallCandidate = {
      id: `recall:${randomUUID()}`,
      scope: input.scope,
      text: requiredText(input.text, "text"),
      reason: requiredText(input.reason, "reason"),
      evidenceRefs: input.evidenceRefs ?? [],
      status: "candidate",
      createdAt: now,
      updatedAt: now,
    };
    snapshot.candidates.push(candidate);
    await this.saveSnapshot(snapshot);
    return candidate;
  }

  async reject(id: string, reason: string): Promise<RecallCandidate> {
    const snapshot = await this.loadSnapshot();
    const index = snapshot.candidates.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`recall candidate not found: ${id}`);
    const now = new Date().toISOString();
    const candidate = {
      ...snapshot.candidates[index],
      status: "rejected" as const,
      rejectedReason: requiredText(reason, "reason"),
      updatedAt: now,
    };
    snapshot.candidates[index] = candidate;
    await this.saveSnapshot(snapshot);
    return candidate;
  }

  async search(query: string): Promise<RecallCandidate[]> {
    const needle = requiredText(query, "query").toLowerCase();
    return (await this.list()).filter(
      (candidate) =>
        candidate.status === "candidate" &&
        (candidate.text.toLowerCase().includes(needle) ||
          candidate.reason.toLowerCase().includes(needle)),
    );
  }

  private async loadSnapshot(): Promise<RecallStoreSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { version: 1, candidates: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RecallStoreFormatError(this.filePath, `invalid JSON: ${(error as Error).message}`);
    }
    assertSnapshot(parsed, this.filePath);
    return parsed;
  }

  private async saveSnapshot(snapshot: RecallStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export function defaultRecallStore(cwd: string, scope: RecallScope): RecallStore {
  const filePath =
    scope === "user"
      ? join(process.env.PI_CODING_AGENT_DIR ?? join(cwd, ".spark"), "recall-candidates.json")
      : join(cwd, ".spark", "recall-candidates.json");
  return new RecallStore(filePath);
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`recall ${label} is required`);
  return value;
}

function assertSnapshot(value: unknown, filePath: string): asserts value is RecallStoreSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecallStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as { version?: unknown; candidates?: unknown };
  if (snapshot.version !== 1) throw new RecallStoreFormatError(filePath, "version must be 1");
  if (!Array.isArray(snapshot.candidates)) {
    throw new RecallStoreFormatError(filePath, "candidates must be an array");
  }
  for (const [index, candidate] of snapshot.candidates.entries()) {
    assertCandidate(candidate, filePath, index);
  }
}

function assertCandidate(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is RecallCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}] must be an object`);
  }
  const candidate = value as Partial<RecallCandidate>;
  if (typeof candidate.id !== "string" || !candidate.id.startsWith("recall:")) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].id must be a recall ref`);
  }
  if (candidate.scope !== "user" && candidate.scope !== "workspace" && candidate.scope !== "repo") {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].scope must be user, workspace, or repo`,
    );
  }
  if (typeof candidate.text !== "string" || !candidate.text.trim()) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].text must be a string`);
  }
  if (typeof candidate.reason !== "string" || !candidate.reason.trim()) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].reason must be a string`);
  }
  if (
    !Array.isArray(candidate.evidenceRefs) ||
    !candidate.evidenceRefs.every((ref) => typeof ref === "string")
  ) {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].evidenceRefs must be a string array`,
    );
  }
  if (candidate.status !== "candidate" && candidate.status !== "rejected") {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].status must be candidate or rejected`,
    );
  }
  if (typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") {
    throw new RecallStoreFormatError(filePath, `candidates[${index}] timestamps must be strings`);
  }
}
