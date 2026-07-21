/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Role registry / reviewer runner are owned by spark-roles. Remaining host-support
 * entries still re-export from the Pi-compatible package while domains migrate.
 */

export { SparkRolesReviewerRunner, createSparkRoleRegistry } from "@zendev-lab/spark-roles";
export {
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
