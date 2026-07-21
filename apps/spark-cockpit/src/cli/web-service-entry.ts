import { runCockpitWebCli } from "./web-cli.ts";

async function main(argv = process.argv.slice(2)): Promise<number> {
  return await runCockpitWebCli(argv);
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
