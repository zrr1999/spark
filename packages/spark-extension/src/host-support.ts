/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Re-exported through this package so apps/spark-tui does not depend on
 * `@zendev-lab/pi-extension`. Implementations migrate into spark-* packages
 * incrementally; keep this file as the stable import path for hosts.
 */

export {
  SparkRolesReviewerRunner,
  createSparkRoleRegistry,
  defaultBuiltinSkillsDir,
  defaultSparkCueSkillsDir,
  loadSparkMode,
  parseSkillFrontmatter,
  renderBaseSystemPromptsCatalogPrompt,
  renderBaseSystemPromptsPrompt,
  renderBuiltinSkillsCatalogForPrompt,
  renderSparkActiveSystemPrompt,
  type SparkSessionContext,
  type SparkSkillFrontmatter,
} from "@zendev-lab/pi-extension/host-support";
