/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Roles and builtin skills are owned by capability / host packages. Remaining
 * entries still re-export from the Pi-compatible package while domains migrate.
 */

export { SparkRolesReviewerRunner, createSparkRoleRegistry } from "@zendev-lab/spark-roles";
export {
  defaultBuiltinSkillsDir,
  defaultSparkCueSkillsDir,
  parseSkillFrontmatter,
  renderBaseSystemPromptsCatalogPrompt,
  renderBaseSystemPromptsPrompt,
  renderBuiltinSkillsCatalogForPrompt,
  type SparkSkillFrontmatter,
} from "@zendev-lab/spark-host/builtin-skills";
export {
  loadSparkMode,
  renderSparkActiveSystemPrompt,
  type SparkSessionContext,
} from "@zendev-lab/pi-extension/host-support";
