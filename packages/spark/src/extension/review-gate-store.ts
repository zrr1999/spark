import { join } from "node:path";

import type { ReviewGate } from "spark-core";
import { writeJsonFileAtomic } from "./json-store.ts";

export class ReviewGateStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(gate: ReviewGate): Promise<void> {
    await writeJsonFileAtomic(this.filePath, gate);
  }
}

export function defaultReviewGateStore(cwd: string): ReviewGateStore {
  return new ReviewGateStore(join(cwd, ".spark", "review-gate.json"));
}
