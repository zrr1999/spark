import { runSparkCockpitCli } from "./cli.ts";

runSparkCockpitCli()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
