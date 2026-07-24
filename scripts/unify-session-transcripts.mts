import { join } from "node:path";
import { resolveSparkPaths, resolveSparkUserPaths } from "@zendev-lab/spark-system";
import { createDaemonSessionRegistry } from "../apps/spark-daemon/src/session-registry.ts";
import { unifyDaemonSessionTranscripts } from "../apps/spark-daemon/src/session-transcript-unification.ts";

const paths = resolveSparkPaths({ app: "daemon" });
const userPaths = resolveSparkUserPaths();
const apply = process.argv.includes("--apply");
const backupRoot = join(
  paths.dataDir,
  "backups",
  "session-transcript-unification",
  new Date().toISOString().replaceAll(":", "-"),
);
const result = await unifyDaemonSessionTranscripts({
  registry: createDaemonSessionRegistry(userPaths.dataRoot),
  transcriptSparkHome: paths.piAgentDir ?? join(paths.dataDir, "pi-agent"),
  backupRoot,
  apply,
});

process.stdout.write(`${JSON.stringify({ apply, ...result }, null, 2)}\n`);
