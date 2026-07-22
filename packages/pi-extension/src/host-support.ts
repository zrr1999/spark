/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Keep host/runtime mechanisms in spark-host. Role registry / reviewer runner
 * live in spark-roles; builtin skills live in spark-host. Remaining exports
 * still come from pi-extension-owned policy modules.
 */

export { renderSparkActiveSystemPrompt } from "./extension/spark-active-injection.ts";
export {
  defaultBuiltinSkillsDir,
  defaultSparkCueSkillsDir,
  parseSkillFrontmatter,
  renderBaseSystemPromptsCatalogPrompt,
  renderBaseSystemPromptsPrompt,
  renderBuiltinSkillsCatalogForPrompt,
  type SparkSkillFrontmatter,
} from "@zendev-lab/spark-host/builtin-skills";
export { loadSparkMode } from "./extension/session-state.ts";
export type { SparkSessionContext } from "@zendev-lab/spark-loop";
export { SparkRolesReviewerRunner, createSparkRoleRegistry } from "@zendev-lab/spark-roles";
