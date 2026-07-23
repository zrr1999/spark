#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reportsDirectory = resolve(root, "reports");
const infrastructureFailures = [];

await mkdir(resolve(reportsDirectory, "jscpd"), { recursive: true });

const knip = runReport("knip", ["--no-progress", "--no-config-hints", "--reporter", "json"]);
const normalizedKnip = normalizeJsonReport(knip.stdout);
if (!normalizedKnip.available) {
  infrastructureFailures.push("knip did not produce a valid JSON report");
}
await writeFile(resolve(reportsDirectory, "knip-report.json"), normalizedKnip.json);
await writeFile(
  resolve(reportsDirectory, "knip-console.txt"),
  [normalizedKnip.diagnostics, knip.stderr].filter(Boolean).join("\n"),
);

const duplication = runReport("jscpd", ["--config", ".jscpd.json", "apps", "packages"]);
await writeFile(
  resolve(reportsDirectory, "jscpd", "console.txt"),
  [duplication.stdout, duplication.stderr].filter(Boolean).join("\n"),
);

const complexity = runReport("vp", [
  "lint",
  "-A",
  "all",
  "-W",
  "complexity",
  "-W",
  "max-lines",
  "--ignore-pattern",
  "**/*.test.ts",
  "--ignore-pattern",
  "packages/spark-cockpit-i18n/**",
  "--ignore-pattern",
  "packages/spark-i18n/**",
  "apps",
  "packages",
]);
await writeFile(
  resolve(reportsDirectory, "complexity.txt"),
  [complexity.stdout, complexity.stderr].filter(Boolean).join("\n"),
);

if (infrastructureFailures.length > 0) {
  console.error(
    `Hygiene reporting failed:\n${infrastructureFailures.map((failure) => `- ${failure}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "Hygiene reports written under reports/ (advisory only; findings do not fail the command).",
  );
}

function runReport(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  if (result.error) {
    infrastructureFailures.push(`${command} could not run: ${result.error.message}`);
  } else if (result.signal) {
    infrastructureFailures.push(`${command} was terminated by signal ${result.signal}`);
  } else if (result.status === null) {
    infrastructureFailures.push(`${command} ended without an exit status`);
  } else if (result.status !== 0) {
    console.warn(`[hygiene] ${command} reported findings (exit ${String(result.status)}).`);
  }
  return {
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

function normalizeJsonReport(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end >= start) {
    const candidate = output.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return {
        available: true,
        diagnostics: [output.slice(0, start), output.slice(end + 1)]
          .filter(Boolean)
          .join("\n")
          .trim(),
        json: `${candidate}\n`,
      };
    } catch {
      // Fall through to a stable report when a tool emits malformed JSON.
    }
  }
  return {
    available: false,
    diagnostics: output,
    json: `${JSON.stringify({ error: "knip report unavailable" }, null, 2)}\n`,
  };
}
