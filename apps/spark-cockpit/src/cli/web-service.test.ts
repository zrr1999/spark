import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCockpitWebStatus,
  readCockpitWebLogs,
  startCockpitWebService,
  stopCockpitWebService,
} from "./web-service.ts";

const cleanups: Array<{ root: string; env: NodeJS.ProcessEnv }> = [];
const childEntry = fileURLToPath(
  new URL("../../../../test/support/spark-cockpit-web-child.ts", import.meta.url),
);

function isolatedEnv(root: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    SPARK_COCKPIT_WEB_TEST_SERVER_ENTRY: childEntry,
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await stopCockpitWebService(cleanup.env).catch(() => undefined);
    rmSync(cleanup.root, { recursive: true, force: true });
  }
});

describe("Cockpit Web background service", () => {
  it("starts once, reports status and logs, then stops cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-"));
    const env = isolatedEnv(root, await availablePort());
    cleanups.push({ root, env });

    const started = await startCockpitWebService(env);
    expect(started.alreadyRunning).toBe(false);
    expect(started.status).toMatchObject({ running: true, url: `http://127.0.0.1:${env.PORT}` });

    const duplicate = await startCockpitWebService(env);
    expect(duplicate.alreadyRunning).toBe(true);
    expect(duplicate.status.pid).toBe(started.status.pid);

    const log = readCockpitWebLogs(env, 100);
    expect(log.logFile).toContain(join("spark", "cockpit", "logs", "cockpit.jsonl"));

    const stopped = await stopCockpitWebService(env);
    expect(stopped.alreadyStopped).toBe(false);
    expect(stopped.status.running).toBe(false);
    expect(getCockpitWebStatus(env).running).toBe(false);
  }, 20_000);

  it("removes stale PID and lock metadata without signaling an unrelated process", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-stale-"));
    const env = isolatedEnv(root, await availablePort());
    cleanups.push({ root, env });
    const runtimeDir = join(root, "runtime", "spark", "cockpit");
    const pidFile = join(runtimeDir, "cockpit.pid");
    const lockFile = join(runtimeDir, "cockpit-web.lock");
    const stale = {
      pid: process.pid,
      processStartToken: "not-the-current-process",
      startedAt: new Date(0).toISOString(),
      host: "127.0.0.1",
      port: Number(env.PORT),
      logFile: join(root, "state", "spark", "cockpit", "logs", "cockpit.jsonl"),
    };
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(pidFile, `${JSON.stringify(stale)}\n`);
    writeFileSync(lockFile, `${JSON.stringify(stale)}\n`);

    expect(getCockpitWebStatus(env).running).toBe(false);
    expect(() => readFileSync(pidFile)).toThrow();
    expect(() => readFileSync(lockFile)).toThrow();
  });

  it("tails the requested number of log lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-logs-"));
    const env = isolatedEnv(root, await availablePort());
    cleanups.push({ root, env });
    const logFile = join(root, "state", "spark", "cockpit", "logs", "cockpit.jsonl");
    mkdirSync(join(root, "state", "spark", "cockpit", "logs"), { recursive: true });
    writeFileSync(logFile, "one\ntwo\nthree\n");

    expect(readCockpitWebLogs(env, 2)).toEqual({ logFile, text: "two\nthree\n" });
    expect(() => readCockpitWebLogs(env, -1)).toThrow(/non-negative integer/u);
  });
});
