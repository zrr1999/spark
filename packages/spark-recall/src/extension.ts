/**
 * Compatibility facade: the `recall` tool is registered by spark-memory.
 * Prefer `@zendev-lab/spark-memory/extension` (registers recall alongside memory).
 */
export {
  registerPiRecallTool,
  type PiRecallAction,
  type PiRecallExtensionApi,
  type PiRecallToolOptions,
} from "@zendev-lab/spark-memory/recall/extension";
export { default } from "@zendev-lab/spark-memory/recall/extension";
