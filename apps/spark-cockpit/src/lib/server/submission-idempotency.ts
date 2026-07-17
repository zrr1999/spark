import { createHash, randomUUID } from "node:crypto";

export type CockpitSubmissionPhase = "session.create" | "turn.submit";

/** One browser/form submission identity, preserved across ambiguous retries. */
export function createCockpitSubmissionId(): string {
  return randomUUID();
}

/**
 * Keep the user-facing submission identity out of the protocol while deriving
 * independent keys for the create-session and submit-turn phases.
 */
export function cockpitSubmissionIdempotencyKey(
  submissionId: string,
  phase: CockpitSubmissionPhase,
): string {
  const normalized = submissionId.trim();
  if (!normalized) throw new Error("Cockpit submission id is required.");
  const digest = createHash("sha256")
    .update(`spark.cockpit.submission.v1\0${phase}\0${normalized}`)
    .digest("hex")
    .slice(0, 32);
  return `idem_${digest}`;
}
