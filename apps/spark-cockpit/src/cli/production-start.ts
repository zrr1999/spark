import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Foreground production Cockpit host (`spark cockpit` / `spark cockpit start`).
 * Mirrors package script `start:custom` without going through pnpm.
 */
export async function startCockpitProductionHost(args: string[] = []): Promise<number> {
  const handlerPath = join(appDir, "build", "handler.js");
  if (!existsSync(handlerPath)) {
    process.stderr.write(
      "Spark Cockpit production build not found. Build the app through its package script before starting it.\n",
    );
    return 1;
  }

  const tsx = join(appDir, "node_modules", ".bin", "tsx");
  const serverEntry = join(appDir, "server", "index.ts");
  const child = spawn(tsx, [serverEntry, ...args], {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  });

  return await new Promise<number>((resolveExit) => {
    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}
