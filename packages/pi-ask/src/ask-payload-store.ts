import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PiAskFlowRequest, PiAskFlowResult } from "./schema.ts";

export interface StoredAskPayload {
  request: PiAskFlowRequest;
  result: PiAskFlowResult;
  timestamp: number;
}

export class PiAskFlowPayloadStore {
  /** Save the latest ask payload for the given cwd. */
  async save(cwd: string, payload: StoredAskPayload): Promise<void> {
    const dir = join(cwd, ".pi", "asks");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "latest.json");
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }

  /** Load the latest ask payload for the given cwd. */
  async load(cwd: string): Promise<StoredAskPayload | null> {
    try {
      const path = join(cwd, ".pi", "asks", "latest.json");
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as StoredAskPayload;
    } catch {
      return null;
    }
  }
}
