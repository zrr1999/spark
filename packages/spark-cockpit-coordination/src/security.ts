import { createHash } from "node:crypto";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
