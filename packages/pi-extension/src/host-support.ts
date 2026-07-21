/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Keep host/runtime mechanisms in spark-host. These exports remain here because
 * they implement Spark extension policy and state owned by pi-extension.
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
export { createSparkRoleRegistry } from "./extension/spark-role-registry.ts";
export { SparkRolesReviewerRunner } from "./extension/reviewer-runner.ts";
