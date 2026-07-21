import {
  formatCockpitWebStatus,
  getCockpitWebStatus,
  readCockpitWebLogs,
  runCockpitWebService,
  startCockpitWebService,
  stopCockpitWebService,
} from "./web-service.ts";

/** Handle `spark cockpit web …` after the surface dispatcher peels off `web`. */
export async function runCockpitWebCli(argv: string[]): Promise<number> {
  const [command = "status"] = argv;
  const json = argv.includes("--json");
  switch (command) {
    case "run":
      await runCockpitWebService();
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    case "start": {
      const result = await startCockpitWebService();
      process.stdout.write(`${formatCockpitWebStatus(result.status, json)}\n`);
      return 0;
    }
    case "status":
      process.stdout.write(`${formatCockpitWebStatus(getCockpitWebStatus(), json)}\n`);
      return 0;
    case "stop": {
      const result = await stopCockpitWebService();
      process.stdout.write(`${formatCockpitWebStatus(result.status, json)}\n`);
      return 0;
    }
    case "logs": {
      const linesIndex = argv.findIndex((arg) => arg === "--lines" || arg === "-n");
      const lines = linesIndex < 0 ? 100 : Number(argv[linesIndex + 1]);
      const result = readCockpitWebLogs(process.env, lines);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.text) process.stdout.write(result.text);
      else process.stdout.write(`no logs yet: ${result.logFile}\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown spark cockpit web command: ${command}`);
  }
}
