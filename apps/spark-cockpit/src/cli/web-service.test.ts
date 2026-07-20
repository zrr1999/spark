import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCockpitWebStatus,
  readCockpitWebLogs,
  runCockpitWebService,
  startCockpitWebService,
  stopCockpitWebService,
  type CockpitWebProcessRecord,
  type CockpitWebServiceDependencies,
} from "./web-service.ts";

const roots: string[] = [];

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "5173",
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
}

function paths(root: string) {
  const runtimeDir = join(root, "runtime", "spark", "cockpit");
  return {
    runtimeDir,
    pidFile: join(runtimeDir, "cockpit.pid"),
    lockFile: join(runtimeDir, "cockpit-web.lock"),
    logFile: join(root, "state", "spark", "cockpit", "logs", "cockpit.jsonl"),
  };
}

function record(root: string, pid = 4242): CockpitWebProcessRecord {
  return {
    pid,
    processStartToken: `token-${pid}`,
    startedAt: new Date(0).toISOString(),
    host: "127.0.0.1",
    port: 5173,
    logFile: paths(root).logFile,
  };
}

function writeRecord(root: string, value: CockpitWebProcessRecord): void {
  const resolved = paths(root);
  mkdirSync(resolved.runtimeDir, { recursive: true });
  writeFileSync(resolved.pidFile, `${JSON.stringify(value)}\n`);
  writeFileSync(resolved.lockFile, `${JSON.stringify(value)}\n`);
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    unref: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = vi.fn();
  child.kill = vi.fn();
  return child;
}

function deps(
  root: string,
  overrides: Partial<CockpitWebServiceDependencies> = {},
): Partial<CockpitWebServiceDependencies> {
  const processTokens = new Map<number, string>();
  return {
    processStartToken: (pid) => {
      try {
        const stored = JSON.parse(
          readFileSync(paths(root).pidFile, "utf8"),
        ) as CockpitWebProcessRecord;
        processTokens.set(stored.pid, stored.processStartToken);
      } catch {
        // Status may clean the file after first observing the process identity.
      }
      return processTokens.get(pid) ?? (pid === process.pid ? `token-${pid}` : null);
    },
    sleep: async () => undefined,
    now: Date.now,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Cockpit Web background service", () => {
  it("starts once and reports the existing instance without binding a listener", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-"));
    roots.push(root);
    const env = isolatedEnv(root);
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      writeRecord(root, record(root));
      return child as never;
    });
    let ready = false;
    const injected = deps(root, {
      spawnProcess,
      canConnect: async () => {
        if (!ready) {
          writeRecord(root, record(root));
          ready = true;
        }
        return true;
      },
    });

    const started = await startCockpitWebService(env, injected);
    expect(started).toMatchObject({
      alreadyRunning: false,
      status: { running: true, pid: 4242, url: "http://127.0.0.1:5173" },
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();

    const duplicate = await startCockpitWebService(env, injected);
    expect(duplicate).toMatchObject({ alreadyRunning: true, status: { pid: 4242 } });
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("removes stale PID and lock metadata without signaling an unrelated process", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-stale-"));
    roots.push(root);
    const env = isolatedEnv(root);
    writeRecord(root, { ...record(root, process.pid), processStartToken: "reused-pid" });
    const killProcess = vi.fn();

    expect(
      getCockpitWebStatus(
        env,
        deps(root, { processStartToken: () => "actual-process", killProcess }),
      ).running,
    ).toBe(false);
    expect(() => readFileSync(paths(root).pidFile)).toThrow();
    expect(() => readFileSync(paths(root).lockFile)).toThrow();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("keeps a live lock authoritative when the PID file is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-mixed-"));
    roots.push(root);
    const env = isolatedEnv(root);
    const resolved = paths(root);
    mkdirSync(resolved.runtimeDir, { recursive: true });
    writeFileSync(
      resolved.pidFile,
      `${JSON.stringify({ ...record(root, 1111), processStartToken: "stale" })}\n`,
    );
    writeFileSync(resolved.lockFile, `${JSON.stringify(record(root, 4242))}\n`);

    const status = getCockpitWebStatus(
      env,
      deps(root, {
        processStartToken: (pid) => (pid === 4242 ? "token-4242" : null),
      }),
    );

    expect(status).toMatchObject({ running: true, pid: 4242 });
    expect(() => readFileSync(resolved.pidFile)).toThrow();
    expect(JSON.parse(readFileSync(resolved.lockFile, "utf8"))).toMatchObject({ pid: 4242 });
  });

  it("tails logs and validates the requested line count", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-logs-"));
    roots.push(root);
    const env = isolatedEnv(root);
    mkdirSync(join(root, "state", "spark", "cockpit", "logs"), { recursive: true });
    writeFileSync(paths(root).logFile, "one\ntwo\nthree\n");

    expect(readCockpitWebLogs(env, 2)).toEqual({
      logFile: paths(root).logFile,
      text: "two\nthree\n",
    });
    expect(() => readCockpitWebLogs(env, -1)).toThrow(/non-negative integer/u);
  });

  it("stops the detached process group and escalates when graceful shutdown times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-stop-"));
    roots.push(root);
    const env = isolatedEnv(root);
    writeRecord(root, record(root));
    const killProcess = vi.fn();
    let clock = 0;
    const injected = deps(root, {
      killProcess,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    const stopped = await stopCockpitWebService(env, injected);
    expect(stopped.alreadyStopped).toBe(false);
    expect(killProcess.mock.calls).toEqual([
      [process.platform === "win32" ? 4242 : -4242, "SIGTERM"],
      [process.platform === "win32" ? 4242 : -4242, "SIGKILL"],
    ]);
  });

  it("cleans the runner lock when spawning the web child fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-spawn-failure-"));
    roots.push(root);
    const env = isolatedEnv(root);

    await expect(
      runCockpitWebService(
        env,
        deps(root, {
          processStartToken: (pid) => `token-${pid}`,
          spawnProcess: () => {
            throw new Error("spawn failed");
          },
        }),
      ),
    ).rejects.toThrow("spawn failed");

    expect(() => readFileSync(paths(root).pidFile)).toThrow();
    expect(() => readFileSync(paths(root).lockFile)).toThrow();
  });

  it("atomically rejects a second runner lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-web-runner-"));
    roots.push(root);
    const env = isolatedEnv(root);
    writeRecord(root, record(root, 9999));
    const neverSpawn = vi.fn();

    await expect(
      runCockpitWebService(
        env,
        deps(root, {
          processStartToken: (pid) => `token-${pid}`,
          spawnProcess: neverSpawn,
        }),
      ),
    ).rejects.toThrow(/already running/u);
    expect(neverSpawn).not.toHaveBeenCalled();
  });
});
