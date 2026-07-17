import {
  formatCockpitWebStatus,
  getCockpitWebStatus,
  runCockpitWebService,
  startCockpitWebService,
  stopCockpitWebService,
} from "./web-service.ts";

async function main(argv = process.argv.slice(2)): Promise<number> {
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
    default:
      throw new Error(`Unknown Spark Cockpit service command: ${command}`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
