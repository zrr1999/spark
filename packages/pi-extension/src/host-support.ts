/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Keep host/runtime mechanisms in spark-host. These exports remain here because
 * they implement Spark extension policy and state owned by pi-extension, except
 * role registry / reviewer runner which now live in spark-roles.
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
} from "./extension/spark-builtin-skills.ts";
export { loadSparkMode } from "./extension/session-state.ts";
export type { SparkSessionContext } from "@zendev-lab/spark-loop";
export { SparkRolesReviewerRunner, createSparkRoleRegistry } from "@zendev-lab/spark-roles";
