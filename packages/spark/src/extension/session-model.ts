import type { SparkSessionModelRef } from "./spark-tool-registration.ts";

export function sessionModelName(model: SparkSessionModelRef | undefined): string | undefined {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  return provider && id ? `${provider}/${id}` : undefined;
}
