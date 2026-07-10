import { asciiSlug } from "@zendev-lab/spark-system/strings";

export function slugifyWorkspaceIdentifier(value: string) {
  return asciiSlug(value, { maxLength: 48 });
}
