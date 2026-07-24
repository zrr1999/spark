#!/usr/bin/env node

/**
 * Assemble the one public npm artifact. Source workspaces deliberately stay
 * private: this directory is the only registry boundary and contains no
 * TypeScript runtime entrypoints or workspace protocol dependencies.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDirectory = resolve(root, "dist/npm-package");
const productDist = resolve(productDirectory, "dist");
let rootManifest;

const dependencies = {
  "@core-workspace/infoflow-sdk-nodejs": "2026.6.12-beta.1",
  "@cursor/sdk": "1.0.23",
  "@earendil-works/pi-ai": "0.80.6",
  "@earendil-works/pi-tui": "0.80.6",
  "@sveltejs/kit": "2.65.1",
  "web-push": "3.6.7",
  ws: "^8.18.3",
};
const externalPackages = Object.keys(dependencies);

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, {
      cause: error,
    });
  }
}

async function bundle(entry, output) {
  await run("pnpm", [
    "exec",
    "esbuild",
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node26",
    `--outfile=${output}`,
    ...externalPackages.map((name) => `--external:${name}`),
  ]);
}

async function writeProductManifest() {
  const manifest = {
    name: "@zendev-lab/spark",
    version: rootManifest.version,
    description: rootManifest.description,
    license: rootManifest.license,
    author: rootManifest.author,
    ...(rootManifest.keywords ? { keywords: rootManifest.keywords } : {}),
    ...(rootManifest.repository ? { repository: rootManifest.repository } : {}),
    ...(rootManifest.homepage ? { homepage: rootManifest.homepage } : {}),
    ...(rootManifest.bugs ? { bugs: rootManifest.bugs } : {}),
    type: "module",
    bin: { spark: "./bin/spark" },
    files: ["bin", "dist", "build", "README.md", "LICENSE"],
    engines: { node: rootManifest.engines.node },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    dependencies,
  };
  await writeFile(
    resolve(productDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeBuildInfo() {
  const migrationNames = (await readdir(resolve(productDist, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationHead = migrationNames.at(-1) ?? "none";
  const gitSha =
    process.env.SPARK_BUILD_GIT_SHA?.trim() ||
    (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const protocolSource = await readFile(
    resolve(root, "packages/spark-protocol/src/version.ts"),
    "utf8",
  );
  const protocolVersion = Number(/SPARK_PROTOCOL_VERSION\s*=\s*(\d+)/u.exec(protocolSource)?.[1]);
  if (!Number.isSafeInteger(protocolVersion)) {
    throw new Error("Unable to resolve SPARK_PROTOCOL_VERSION for build-info.json");
  }
  const fingerprint = `sha256:${createHash("sha256")
    .update([rootManifest.version, gitSha, String(protocolVersion), migrationHead].join("\n"))
    .digest("hex")}`;
  const buildInfo = {
    schemaVersion: 1,
    packageName: "@zendev-lab/spark",
    version: rootManifest.version,
    gitSha,
    protocolVersion,
    minimumNodeVersion: rootManifest.engines.node,
    migrationHead,
    migrationMode: rootManifest.sparkRelease.migrationMode,
    fingerprint,
  };
  await writeFile(
    resolve(productDist, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );
}

async function writeLauncher() {
  const launcher = `#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDist = resolve(packageDirectory, "dist");
process.env.SPARK_PRODUCT_DIST = productDist;
process.env.SPARK_BUILD_INFO_PATH = resolve(productDist, "build-info.json");
process.env.SPARK_DAEMON_ENTRYPOINT = resolve(productDist, "spark-daemon.js");
process.env.SPARK_COCKPIT_SERVER_ENTRYPOINT = resolve(productDist, "spark-cockpit-server.js");
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = resolve(
  productDist,
  "spark-headless-role-executor.js",
);

const { runSparkDispatcher } = await import(
  pathToFileURL(resolve(productDist, "spark-cli.js")).href
);
process.exitCode = await runSparkDispatcher(process.argv.slice(2));
`;
  const destination = resolve(productDirectory, "bin/spark");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, launcher);
  await chmod(destination, 0o755);
}

async function removeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await removeSourceMaps(path);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      await rm(path);
    }
  }
}

await rm(productDirectory, { recursive: true, force: true });
await mkdir(productDist, { recursive: true });
rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

await run("pnpm", ["--filter", "@zendev-lab/spark-daemon", "run", "build"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-cockpit", "run", "build"]);

await Promise.all([
  bundle("apps/spark-cli/src/cli.ts", resolve(productDist, "spark-cli.js")),
  bundle("apps/spark-tui/src/cli.ts", resolve(productDist, "spark-tui.js")),
  bundle(
    "apps/spark-tui/src/headless-role-executor.ts",
    resolve(productDist, "spark-headless-role-executor.js"),
  ),
  bundle("apps/spark-cockpit/src/cli-entry.ts", resolve(productDist, "spark-cockpit.js")),
  bundle("apps/spark-cockpit/server/index.ts", resolve(productDist, "spark-cockpit-server.js")),
]);

await Promise.all([
  cp(resolve(root, "apps/spark-daemon/dist/cli.js"), resolve(productDist, "spark-daemon.js")),
  cp(resolve(root, "apps/spark-daemon/dist/migrations"), resolve(productDist, "migrations"), {
    recursive: true,
  }),
  cp(resolve(root, "apps/spark-cockpit/build"), resolve(productDirectory, "build"), {
    recursive: true,
  }),
  cp(resolve(root, "README.md"), resolve(productDirectory, "README.md")),
  cp(resolve(root, "LICENSE"), resolve(productDirectory, "LICENSE")),
]);
await removeSourceMaps(resolve(productDirectory, "build"));
await Promise.all([writeProductManifest(), writeBuildInfo(), writeLauncher()]);

console.log(`Built npm product artifact: ${productDirectory}`);
