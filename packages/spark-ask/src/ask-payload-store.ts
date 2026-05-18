import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SparkAskRequest, SparkAskResult } from "./schema.ts";

export interface StoredAskPayload {
  request: SparkAskRequest;
  result: SparkAskResult;
  timestamp: number;
}

export class SparkAskPayloadStore {
  /** Save the latest ask payload for the given cwd. */
  async save(cwd: string, payload: StoredAskPayload): Promise<void> {
    const dir = join(cwd, ".spark", "asks");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "latest.json");
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }

  /** Load the latest ask payload for the given cwd. */
  async load(cwd: string): Promise<StoredAskPayload | null> {
    try {
      const path = join(cwd, ".spark", "asks", "latest.json");
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as StoredAskPayload;
    } catch {
      return null;
    }
  }
}
