import {
  runSparkCockpitCliCommand,
  parseSparkCockpitCliArgs,
  type SparkCockpitCliOptions,
} from "./cli/coordination.ts";

export async function runSparkCockpitCli(
  argv: string[] = process.argv.slice(2),
  options: SparkCockpitCliOptions = {},
): Promise<number> {
  const command = parseSparkCockpitCliArgs(argv);
  return await runSparkCockpitCliCommand(command, undefined, options);
}

export { parseSparkCockpitCliArgs, sparkCockpitHelpText } from "./cli/coordination.ts";
export type {
  SparkCockpitCliCommand,
  SparkCockpitCliOptions,
  SparkCockpitCliResult,
} from "./cli/coordination.ts";
