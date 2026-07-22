/**
 * Spark-native product extension entry.
 *
 * Implementation currently lives in the Pi-compatible facade package while
 * domains migrate into capability packages. Spark hosts import this specifier
 * only — never `@zendev-lab/pi-extension` directly.
 */
export { default } from "@zendev-lab/pi-extension/extension";
