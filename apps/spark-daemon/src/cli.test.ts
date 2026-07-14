import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { gitCommand, resolveSparkPaths } from "@zendev-lab/spark-system";
import { main, type CliIo } from "./cli.js";
import { readSparkDaemonConfig, writeSparkDaemonConfig } from "./config.js";
import { LocalRpcUnavailableError } from "./local-rpc.js";
import { RegistrationGrantRefusedError } from "./registration.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import {
  attachWorkspace,
  listWorkspaces,
  registerWorkspace,
  stopWorkspace,
} from "./store/workspaces.js";

function createCliIo(
  options: {
    startService?: CliIo["startService"];
    stdin?: CliIo["stdin"];
    daemonStatusFromService?: CliIo["daemonStatusFromService"];
    daemonStopFromService?: CliIo["daemonStopFromService"];
    listWorkspacesFromService?: CliIo["listWorkspacesFromService"];
    registerWorkspaceInService?: CliIo["registerWorkspaceInService"];
    attachWorkspaceInService?: CliIo["attachWorkspaceInService"];
    stopWorkspaceInService?: CliIo["stopWorkspaceInService"];
    openExternal?: CliIo["openExternal"];
    deviceAuthorizationSleep?: CliIo["deviceAuthorizationSleep"];
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    },
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.openExternal ? { openExternal: options.openExternal } : {}),
    ...(options.deviceAuthorizationSleep
      ? { deviceAuthorizationSleep: options.deviceAuthorizationSleep }
      : {}),
    startService:
      options.startService ??
      (() => ({
        kind: "detached",
        alreadyRunning: false,
        detail: "Started test Spark daemon.",
      })),
    ...(options.daemonStatusFromService
      ? { daemonStatusFromService: options.daemonStatusFromService }
      : {}),
    ...(options.daemonStopFromService
      ? { daemonStopFromService: options.daemonStopFromService }
      : {}),
    listWorkspacesFromService: options.listWorkspacesFromService ?? workspaceListResultFromDb,
    registerWorkspaceInService:
      options.registerWorkspaceInService ??
      (async (paths, request) => {
        const db = openSparkDaemonDatabase(paths);
        try {
          const { registrationToken: _registrationToken, ...options } = request;
          return registerWorkspace(db, options);
        } finally {
          db.close();
        }
      }),
    attachWorkspaceInService:
      options.attachWorkspaceInService ??
      (async (paths, id) => {
        const db = openSparkDaemonDatabase(paths);
        try {
          return attachWorkspace(db, { id });
        } finally {
          db.close();
        }
      }),
    stopWorkspaceInService:
      options.stopWorkspaceInService ??
      (async (paths, id) => {
        const db = openSparkDaemonDatabase(paths);
        try {
          return stopWorkspace(db, { id });
        } finally {
          db.close();
        }
      }),
  };

  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function testSparkDaemonConfig(
  overrides: Partial<Parameters<typeof writeSparkDaemonConfig>[1]> = {},
): Parameters<typeof writeSparkDaemonConfig>[1] {
  return {
    installationId: "install-test",
    displayName: "Test daemon",
    serverUrl: "http://127.0.0.1:5173",
    runtimeId: "rt_11111111111141111111111111111111",
    runtimeToken: "spark_rt_test_token_00000000000000000000000000000000",
    refreshToken: "spark_rt_refresh_test_0000000000000000000000000000",
    ...overrides,
  };
}

async function workspaceListResultFromDb(paths: ReturnType<typeof resolveSparkPaths>) {
  const db = openSparkDaemonDatabase(paths);
  try {
    return {
      observedAt: "2026-05-26T00:00:00.000Z",
      workspaces: listWorkspaces(db),
    };
  } finally {
    db.close();
  }
}

const legacyProtocolVocabularyPattern = new RegExp(
  String.raw`\\b(${["run" + "ner", "enroll", "binding"].join("|")})\\b`,
  "i",
);

describe("Spark daemon CLI", () => {
  it("accepts pnpm run argument separators before commands", async () => {
    const capture = createCliIo();

    await expect(main(["--", "help"], capture.io)).resolves.toBe(0);

    expect(capture.stdout()).toContain("Usage: spark daemon <command>");
    expect(capture.stdout()).toContain("workspace register");
    expect(capture.stdout()).not.toMatch(legacyProtocolVocabularyPattern);
    expect(capture.stderr()).toBe("");
  });

  it("prints top-level help when pnpm forwards --help after an argument separator", async () => {
    const capture = createCliIo();

    await expect(main(["--", "--help"], capture.io)).resolves.toBe(0);

    expect(capture.stdout()).toContain("Usage: spark daemon <command>");
    expect(capture.stdout()).toContain("workspace register");
    expect(capture.stderr()).toBe("");
  });

  it("prints workspace help without protocol vocabulary", async () => {
    const capture = createCliIo();

    await expect(main(["ws", "--help"], capture.io)).resolves.toBe(0);

    expect(capture.stdout()).toContain("Usage: spark daemon workspace <command>");
    expect(capture.stdout()).toContain("Example:");
    expect(capture.stdout()).not.toMatch(legacyProtocolVocabularyPattern);
    expect(capture.stderr()).toBe("");
  });

  it("doctor reports daemon, credential, workspace, and cockpit checks", async () => {
    const capture = createCliIo();

    const code = await withTempSparkEnv(async () => await main(["doctor"], capture.io));

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdout()) as {
      checks: Record<string, Record<string, unknown>>;
    };
    expect(payload.checks.daemon).toHaveProperty("ok");
    expect(payload.checks.credentials).toHaveProperty("ok");
    expect(payload.checks.workspace).toHaveProperty("ok");
    expect(payload.checks.cockpit).toHaveProperty("ok");
    expect(capture.stderr()).toBe("");
  });

  it("requires an explicit server URL for scripted workspace registration", async () => {
    const capture = createCliIo();

    const code = await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"));
      process.env.INIT_CWD = root;
      return await main(["ws", "register", "checkout", "--token", "spark_wsreg_test"], capture.io);
    });

    expect(code).toBe(1);
    expect(capture.stderr()).toContain("Missing server URL");
  });

  it("accepts the workspace registration token environment variable", async () => {
    const registerWorkspaceInService = vi.fn(
      async (
        _paths: ReturnType<typeof resolveSparkPaths>,
        options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
      ) => ({
        id: "rtwb_env",
        serverUrl: options.serverUrl ?? "",
        localWorkspaceKey: "env-workspace",
        displayName: options.displayName ?? "Env Workspace",
        localPath: options.localPath,
        status: "available" as const,
        capabilities: {},
        diagnostics: {},
        updatedAt: "2026-05-26T00:00:00.000Z",
      }),
    );
    const capture = createCliIo({ registerWorkspaceInService });

    const code = await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"));
      process.env.INIT_CWD = root;
      process.env.SPARK_WORKSPACE_REGISTRATION_TOKEN = "spark_wsreg_test";
      return await main(
        [
          "ws",
          "register",
          "checkout",
          "--server-url",
          "http://127.0.0.1:5173",
          "--name",
          "Env Workspace",
        ],
        capture.io,
      );
    });

    expect(code).toBe(0);
    expect(registerWorkspaceInService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ registrationToken: "spark_wsreg_test" }),
    );
  });

  it("reads a workspace registration token from stdin when --token is dash", async () => {
    const capture = createCliIo({ stdin: stdinFrom("spark_wsreg_stdin\n") });
    const registerWorkspaceInService = vi.fn(
      async (
        _paths: ReturnType<typeof resolveSparkPaths>,
        options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
      ) => ({
        id: "rtwb_stdin",
        serverUrl: options.serverUrl ?? "",
        localWorkspaceKey: "stdin-workspace",
        displayName: options.displayName ?? "Stdin Workspace",
        localPath: options.localPath,
        status: "available" as const,
        capabilities: {},
        diagnostics: {},
        updatedAt: "2026-05-26T00:00:00.000Z",
      }),
    );

    const code = await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"));
      process.env.INIT_CWD = root;
      return await main(
        [
          "ws",
          "register",
          "checkout",
          "--server-url",
          "http://127.0.0.1:5173",
          "--name",
          "Stdin Workspace",
          "--token",
          "-",
        ],
        createCliIo({ stdin: capture.io.stdin, registerWorkspaceInService }).io,
      );
    });

    expect(code).toBe(0);
    expect(registerWorkspaceInService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ registrationToken: "spark_wsreg_stdin" }),
    );
  });

  it("rejects registration secrets embedded in the server URL", async () => {
    const capture = createCliIo();

    const code = await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"));
      process.env.INIT_CWD = root;
      return await main(
        [
          "ws",
          "register",
          "checkout",
          "--server-url",
          "http://127.0.0.1:5173/setup?registration=spark_wsreg_leaked",
          "--token",
          "spark_wsreg_test",
        ],
        capture.io,
      );
    });

    expect(code).toBe(1);
    expect(capture.stderr()).toContain("Registration secrets must not be embedded");
    expect(capture.stderr()).toContain("--token <token>");
  });

  it("returns conflict exit code when the server refuses the registration grant", async () => {
    const registerWorkspaceInService = vi.fn(async () => {
      throw new RegistrationGrantRefusedError(
        "Workspace registration failed: HTTP 401 workspace_registration_token_used",
      );
    });
    const capture = createCliIo({ registerWorkspaceInService });

    const code = await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"));
      process.env.INIT_CWD = root;
      return await main(
        [
          "ws",
          "register",
          "checkout",
          "--server-url",
          "http://127.0.0.1:5173",
          "--token",
          "spark_wsreg_used",
        ],
        capture.io,
      );
    });

    expect(code).toBe(3);
    expect(capture.stderr()).toContain("Workspace registration failed: HTTP 401");
    expect(capture.stderr()).toContain("workspace_registration_token_used");
    expect(registerWorkspaceInService).toHaveBeenCalledOnce();
  });

  it("installs Spark daemon config without initializing daemon-local SQLite", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });

      await expect(main(["install"], capture.io)).resolves.toBe(0);

      expect(capture.stdout()).toContain("Installed Spark daemon");
      expect(existsSync(paths.configFile)).toBe(true);
      expect(existsSync(paths.databasePath)).toBe(false);
    });
  });

  it("authorizes the daemon once with the device flow and stores machine credentials", async () => {
    const openExternal = vi.fn(() => true);
    const capture = createCliIo({
      openExternal,
      deviceAuthorizationSleep: async () => {},
    });
    let submittedInstallationId: string | undefined;
    const fetchFn = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/api/v1/runtime/device-authorizations") {
        submittedInstallationId = (parseRequestJson(init) as { installationId?: string })
          .installationId;
        return new Response(
          JSON.stringify({
            deviceCode: "spark_device_code_000000000000000000000000",
            userCode: "SPRK-1234",
            verificationUri: "http://127.0.0.1:5173/daemon/authorize",
            verificationUriComplete: "http://127.0.0.1:5173/daemon/authorize?user_code=SPRK-1234",
            expiresIn: 600,
            interval: 1,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_device_token_0000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-07-13T02:00:00.000Z",
          refreshToken: "spark_rt_device_refresh_00000000000000000000000000",
          refreshTokenExpiresAt: "2026-08-12T01:00:00.000Z",
          protocolVersion: runtimeProtocolVersion,
          webSocketUrl:
            "ws://127.0.0.1:5173/api/v1/runtime/runtimes/rt_11111111111141111111111111111111/ws",
          heartbeatIntervalMs: 15_000,
          staleAfterMs: 45_000,
          registeredAt: "2026-07-13T01:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchFn);

    try {
      await withTempSparkEnv(async () => {
        await expect(
          main(["login", "--server-url", "http://127.0.0.1:5173"], capture.io),
        ).resolves.toBe(0);

        expect(openExternal).toHaveBeenCalledWith(
          "http://127.0.0.1:5173/daemon/authorize?user_code=SPRK-1234",
        );
        expect(capture.stdout()).toContain("SPRK-1234");
        expect(capture.stdout()).toContain("Waiting for daemon authorization");
        expect(capture.stdout()).not.toContain("spark_device_code");
        expect(capture.stdout()).not.toContain("spark_rt_device_token");
        const config = readSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }));
        expect(config).toMatchObject({
          serverUrl: "http://127.0.0.1:5173/",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_device_token_0000000000000000000000000000",
          refreshToken: "spark_rt_device_refresh_00000000000000000000000000",
        });
        expect(config.installationId).toBe(submittedInstallationId);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("supports daemon device login without opening a browser", async () => {
    const openExternal = vi.fn(() => true);
    const capture = createCliIo({
      openExternal,
      deviceAuthorizationSleep: async () => {},
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              deviceCode: "spark_device_code_000000000000000000000000",
              userCode: "SPRK-1234",
              verificationUri: "http://192.168.1.8:5173/daemon/authorize",
              verificationUriComplete:
                "http://192.168.1.8:5173/daemon/authorize?user_code=SPRK-1234",
              expiresIn: 600,
              interval: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(deviceLoginRegistrationResponse()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    try {
      await withTempSparkEnv(async () => {
        await expect(
          main(
            [
              "login",
              "--server-url",
              "http://192.168.1.8:5173",
              "--allow-insecure-http",
              "--no-open",
            ],
            capture.io,
          ),
        ).resolves.toBe(0);
        expect(openExternal).not.toHaveBeenCalled();
        expect(capture.stdout()).toContain("http://192.168.1.8:5173/daemon/authorize");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses plaintext remote Cockpit login without explicit acknowledgement", async () => {
    const capture = createCliIo();
    await withTempSparkEnv(async () => {
      await expect(
        main(["login", "--server-url", "http://192.168.1.8:5173", "--no-open"], capture.io),
      ).resolves.toBe(1);
    });
    expect(capture.stderr()).toContain("plaintext HTTP");
    expect(capture.stderr()).toContain("--allow-insecure-http");
  });

  it("prints the workspace registration hint when no default workspace exists", async () => {
    const capture = createCliIo();

    const code = await withTempSparkEnv(() => main(["--no-service"], capture.io));

    expect(code).toBe(0);
    expect(capture.stdout()).toContain("no workspaces registered");
    expect(capture.stdout()).toContain("spark daemon workspace register");
    expect(capture.stderr()).toBe("");
  });

  it("supports the spark daemon workspace register and ls surface", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const invocationCwd = join(root, "caller");
      const workspacePath = join(invocationCwd, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      const realWorkspacePath = realpathSync(workspacePath);
      process.env.INIT_CWD = invocationCwd;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "workspace", "--token", "spark_wsreg_test", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);

      expect(capture.stdout()).toContain("✓ workspace 'workspace' registered");
      expect(capture.stdout()).toContain("server   http://127.0.0.1:5173/");
      expect(capture.stdout()).toContain("path     ~/caller/workspace");

      const listCapture = createCliIo();
      await expect(main(["ws", "ls", "--json", "--no-service"], listCapture.io)).resolves.toBe(0);
      const [workspace] = JSON.parse(listCapture.stdout()) as Array<{
        slug: string;
        name: string;
        serverUrl: string;
        path: string;
        status: string;
        offlineReason: string;
        lastStatusChangedAt: string;
      }>;
      expect(workspace).toMatchObject({
        slug: "workspace",
        name: "workspace",
        serverUrl: "http://127.0.0.1:5173/",
        path: realWorkspacePath,
        status: "offline:service-stopped",
        offlineReason: "service-stopped",
        lastStatusChangedAt: expect.any(String),
      });

      const textListCapture = createCliIo();
      await expect(main(["ws", "ls", "--no-service"], textListCapture.io)).resolves.toBe(0);
      expect(textListCapture.stdout()).toContain("PROJECTS");
      expect(textListCapture.stdout()).toContain("INBOX");
      expect(textListCapture.stdout()).toContain("LAST SESSION");
      expect(textListCapture.stdout()).toContain("~/caller/workspace");
      expect(textListCapture.stdout()).toContain("—");
      expect(textListCapture.stdout()).not.toContain(realWorkspacePath);

      const fullListCapture = createCliIo();
      await expect(main(["ws", "ls", "--full", "--no-service"], fullListCapture.io)).resolves.toBe(
        0,
      );
      expect(fullListCapture.stdout()).toContain(realWorkspacePath);

      const bareListCapture = createCliIo();
      await expect(main(["ws", "--json", "--no-service"], bareListCapture.io)).resolves.toBe(0);
      expect(JSON.parse(bareListCapture.stdout())).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "workspace" })]),
      );

      const stopCapture = createCliIo({
        startService: () => ({
          kind: "detached",
          alreadyRunning: true,
          detail: "Test Spark daemon already running.",
        }),
      });
      await expect(
        main(["ws", "stop", "workspace", "--yes", "--no-service"], stopCapture.io),
      ).resolves.toBe(0);
      expect(stopCapture.stdout()).toContain("✓ paused 'workspace'");
      expect(stopCapture.stdout()).toContain("status   offline · detached");
      expect(stopCapture.stdout()).not.toContain("sync");

      const stoppedListCapture = createCliIo();
      await expect(
        main(["ws", "ls", "--json", "--no-service"], stoppedListCapture.io),
      ).resolves.toBe(0);
      const [stoppedWorkspace] = JSON.parse(stoppedListCapture.stdout()) as Array<{
        name: string;
        serverUrl: string;
        path: string;
        status: string;
        offlineReason: string;
        lastStatusChangedAt: string;
      }>;
      expect(stoppedWorkspace).toMatchObject({
        name: "workspace",
        serverUrl: "http://127.0.0.1:5173/",
        path: realWorkspacePath,
        status: "offline:detached",
        offlineReason: "detached",
        lastStatusChangedAt: expect.any(String),
      });

      process.env.INIT_CWD = workspacePath;
      const readyCapture = createCliIo({
        startService: () => ({
          kind: "detached",
          alreadyRunning: false,
          detail: "Started test Spark daemon.",
        }),
      });
      await expect(main(["--no-service"], readyCapture.io)).resolves.toBe(0);
      expect(readyCapture.stdout()).toContain("✓ re-attached 'workspace' ready");
      expect(readyCapture.stdout()).toContain("status   online");
      expect(readyCapture.stdout()).not.toContain("Started test Spark daemon.");

      const reattachedListCapture = createCliIo();
      await expect(
        main(["ws", "ls", "--json", "--no-service"], reattachedListCapture.io),
      ).resolves.toBe(0);
      const [reattachedWorkspace] = JSON.parse(reattachedListCapture.stdout()) as Array<{
        name: string;
        serverUrl: string;
        path: string;
        status: string;
        offlineReason: string;
      }>;
      expect(reattachedWorkspace).toMatchObject({
        name: "workspace",
        serverUrl: "http://127.0.0.1:5173/",
        path: realWorkspacePath,
        status: "offline:service-stopped",
        offlineReason: "service-stopped",
      });
    });
  });

  it("starts an interactive workspace shell from the default spark daemon command on a TTY", async () => {
    await withTempSparkEnv(async (root) => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [
          {
            id: "rtwb_shell",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "shell-workspace",
            displayName: "Shell Workspace",
            localPath: root,
            status: "available" as const,
            capabilities: {},
            diagnostics: {},
            updatedAt: "2026-05-26T00:00:00.000Z",
          },
        ],
      }));
      const capture = createCliIo({
        stdin: interactiveStdin(["status", "quit"]),
        listWorkspacesFromService,
      });

      await expect(main([], capture.io)).resolves.toBe(0);

      expect(capture.stdout()).toContain("✓ workspace 'Shell Workspace' ready");
      expect(capture.stdout()).toContain("Spark workspace Shell Workspace");
      expect(capture.stdout()).toContain("commands show, status, stop, help, quit");
      expect(capture.stdout()).toContain("status   online");
    });
  });

  it("registers a workspace through the local daemon service when it is running", async () => {
    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      const realWorkspacePath = realpathSync(workspacePath);
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const registerWorkspaceInService = vi.fn(
        async (
          _paths: ReturnType<typeof resolveSparkPaths>,
          options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
        ) => {
          expect(options).toMatchObject({
            serverUrl: "http://127.0.0.1:5173/",
            localPath: realWorkspacePath,
            displayName: "Socket Workspace",
            registrationToken: "spark_wsreg_socket",
          });
          return {
            id: "rtwb_socket",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "socket-workspace",
            displayName: "Socket Workspace",
            localPath: realWorkspacePath,
            status: "available" as const,
            capabilities: {},
            diagnostics: {},
            updatedAt: "2026-05-26T00:00:00.000Z",
          };
        },
      );

      await expect(
        main(
          [
            "ws",
            "register",
            "checkout",
            "--name",
            "Socket Workspace",
            "--token",
            "spark_wsreg_socket",
          ],
          createCliIo({ registerWorkspaceInService }).io,
        ),
      ).resolves.toBe(0);

      expect(registerWorkspaceInService).toHaveBeenCalledOnce();
    });
  });

  it("lazy-starts the Spark daemon before workspace registration", async () => {
    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      const realWorkspacePath = realpathSync(workspacePath);
      const paths = resolveSparkPaths({ app: "daemon" });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const startService = vi.fn(() => ({
        kind: "detached" as const,
        alreadyRunning: false,
        detail: "Started test Spark daemon.",
      }));
      const registerWorkspaceInService = vi.fn(
        async (
          _paths: ReturnType<typeof resolveSparkPaths>,
          options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
        ) => {
          expect(options).toMatchObject({
            serverUrl: "http://127.0.0.1:5173/",
            localPath: realWorkspacePath,
            displayName: "Lazy Workspace",
            registrationToken: "spark_wsreg_lazy",
          });
          return {
            id: "rtwb_lazy",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "lazy-workspace",
            displayName: "Lazy Workspace",
            localPath: realWorkspacePath,
            status: "available" as const,
            capabilities: {},
            diagnostics: {},
            updatedAt: "2026-05-26T00:00:00.000Z",
          };
        },
      );

      const capture = createCliIo({ startService, registerWorkspaceInService });
      await expect(
        main(
          ["ws", "register", "checkout", "--name", "Lazy Workspace", "--token", "spark_wsreg_lazy"],
          capture.io,
        ),
      ).resolves.toBe(0);

      expect(startService).toHaveBeenCalledOnce();
      expect(registerWorkspaceInService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain("✓ workspace 'Lazy Workspace' registered");
      const db = openSparkDaemonDatabase(paths);
      try {
        expect(listWorkspaces(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  it("defaults scripted workspace registration to the invocation cwd", async () => {
    await withTempSparkEnv(async (root) => {
      const realWorkspacePath = realpathSync(root);
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const registerWorkspaceInService = vi.fn(
        async (
          _paths: ReturnType<typeof resolveSparkPaths>,
          options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
        ) => {
          expect(options).toMatchObject({
            serverUrl: "http://127.0.0.1:5173/",
            localPath: realWorkspacePath,
            displayName: "spore",
            registrationToken: "spark_wsreg_scripted",
          });
          return {
            id: "rtwb_spore",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "spore",
            displayName: "spore",
            localPath: realWorkspacePath,
            status: "available" as const,
            capabilities: {},
            diagnostics: {},
            updatedAt: "2026-05-26T00:00:00.000Z",
          };
        },
      );

      const capture = createCliIo({
        startService: () => ({
          kind: "detached",
          alreadyRunning: false,
          detail: "Started test Spark daemon.",
        }),
        registerWorkspaceInService,
      });
      await expect(
        main(
          [
            "ws",
            "register",
            "--server-url",
            "http://127.0.0.1:5173",
            "--token",
            "spark_wsreg_scripted",
            "--name",
            "spore",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      expect(registerWorkspaceInService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain("✓ workspace 'spore' registered");
    });
  });

  it("lazy-starts the Spark daemon before workspace reads", async () => {
    await withTempSparkEnv(async () => {
      const startService = vi.fn(() => ({
        kind: "detached" as const,
        alreadyRunning: false,
        detail: "Started test Spark daemon.",
      }));
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [],
      }));

      const capture = createCliIo({ startService, listWorkspacesFromService });
      await expect(main([], capture.io)).resolves.toBe(0);

      expect(startService).toHaveBeenCalledOnce();
      expect(listWorkspacesFromService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain("no workspaces registered");
    });
  });

  it("prompts for the full workspace registration form interactively", async () => {
    await withTempSparkEnv(async (root) => {
      process.env.INIT_CWD = root;
      const capture = createCliIo({
        stdin: interactiveStdin(["", "http://127.0.0.1:5173", "spark_wsreg_interactive", "Spore"]),
      });

      await expect(main(["ws", "register"], capture.io)).resolves.toBe(0);

      expect(capture.stdout()).toContain("✓ workspace 'Spore' registered");
      expect(capture.stdout()).toContain("server   http://127.0.0.1:5173/");

      const listCapture = createCliIo();
      await expect(main(["ws", "ls", "--json"], listCapture.io)).resolves.toBe(0);
      const [workspace] = JSON.parse(listCapture.stdout()) as Array<{
        name: string;
        slug: string;
        path: string;
      }>;
      expect(workspace).toMatchObject({
        name: "Spore",
        slug: "spore",
        path: realpathSync(root),
      });
    });
  });

  it("does not fall back to direct workspace reads when the running service is unreachable", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      await expect(
        main(
          ["ws", "register", "checkout", "--token", "spark_wsreg_test", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);

      const listCapture = createCliIo({
        listWorkspacesFromService: vi.fn(async () => {
          throw new LocalRpcUnavailableError("socket refused");
        }),
      });
      await expect(main(["ws", "ls", "--json"], listCapture.io)).resolves.toBe(2);
      expect(listCapture.stderr()).toContain("Spark daemon is running but cannot be reached");
      expect(listCapture.stderr()).toContain("socket refused");
      expect(listCapture.stdout()).toBe("");
    });
  });

  it("does not fall back to direct workspace registration when the running service is unreachable", async () => {
    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());

      const capture = createCliIo({
        registerWorkspaceInService: vi.fn(async () => {
          throw new LocalRpcUnavailableError("socket refused");
        }),
      });
      await expect(
        main(["ws", "register", "checkout", "--token", "spark_wsreg_unreachable"], capture.io),
      ).resolves.toBe(2);
      expect(capture.stderr()).toContain("Spark daemon is running but cannot be reached");

      const db = openSparkDaemonDatabase(paths);
      try {
        expect(listWorkspaces(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  it("restarts and retries workspace registration when the local RPC socket is missing", async () => {
    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());

      const startService = vi.fn(() => ({
        kind: "detached" as const,
        alreadyRunning: false,
        detail: "Restarted test Spark daemon.",
      }));
      let registerAttempts = 0;
      const registerWorkspaceInService = vi.fn(
        async (
          requestPaths: ReturnType<typeof resolveSparkPaths>,
          options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
        ) => {
          registerAttempts += 1;
          if (registerAttempts === 1) {
            throw new LocalRpcUnavailableError(
              `connect ENOENT ${join(paths.runtimeDir, "daemon.sock")}`,
            );
          }
          const db = openSparkDaemonDatabase(requestPaths);
          try {
            const { registrationToken: _registrationToken, ...registrationOptions } = options;
            return registerWorkspace(db, registrationOptions);
          } finally {
            db.close();
          }
        },
      );
      const capture = createCliIo({ startService, registerWorkspaceInService });

      await expect(
        main(["ws", "register", "checkout", "--token", "spark_wsreg_retry"], capture.io),
      ).resolves.toBe(0);

      expect(startService).toHaveBeenCalledOnce();
      expect(registerWorkspaceInService).toHaveBeenCalledTimes(2);
      expect(capture.stdout()).toContain("✓ workspace 'checkout' registered");
    });
  });

  it("reads workspace ls from the local daemon service when it is running", async () => {
    await withTempSparkEnv(async (root) => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      const listWorkspacesFromService = vi.fn(async () => {
        return {
          observedAt: "2026-05-26T00:00:00.000Z",
          workspaces: [
            {
              id: "rtwb_socket",
              serverUrl: "http://127.0.0.1:5173/",
              localWorkspaceKey: "socket-workspace",
              displayName: "Socket Workspace",
              localPath: root,
              status: "available" as const,
              capabilities: {},
              diagnostics: {},
              updatedAt: "2026-05-26T00:00:00.000Z",
            },
          ],
        };
      });

      const capture = createCliIo({ listWorkspacesFromService });
      await expect(main(["ws", "ls", "--json"], capture.io)).resolves.toBe(0);
      expect(listWorkspacesFromService).toHaveBeenCalledOnce();
      expect(JSON.parse(capture.stdout())).toEqual([
        expect.objectContaining({
          slug: "socket-workspace",
          name: "Socket Workspace",
          status: "online",
        }),
      ]);
    });
  });

  it("reads workspace show from the local daemon service when it is running", async () => {
    await withTempSparkEnv(async (root) => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [
          {
            id: "rtwb_socket",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "socket-workspace",
            displayName: "Socket Workspace",
            localPath: root,
            status: "available" as const,
            capabilities: { git: "available" },
            diagnostics: {},
            sessionCount: 2,
            lastSessionAt: "2026-05-26T00:03:00.000Z",
            recentSessions: [
              {
                id: "inv_new",
                project: "workspace",
                model: "pi",
                lastActivityAt: "2026-05-26T00:03:00.000Z",
                state: "succeeded",
              },
            ],
            updatedAt: "2026-05-26T00:00:00.000Z",
          },
        ],
      }));

      const capture = createCliIo({ listWorkspacesFromService });
      await expect(main(["ws", "show", "socket-workspace", "--json"], capture.io)).resolves.toBe(0);

      expect(listWorkspacesFromService).toHaveBeenCalledOnce();
      expect(JSON.parse(capture.stdout())).toMatchObject({
        slug: "socket-workspace",
        name: "Socket Workspace",
        status: "online",
        connection: {
          ref: "rtwb_socket",
          capabilities: [
            {
              id: "git",
              status: "online",
              lastCheckedAt: "2026-05-26T00:00:00.000Z",
            },
          ],
        },
        counts: {
          sessions: 2,
        },
        lastSessionAt: "2026-05-26T00:03:00.000Z",
        recentSessions: [
          {
            id: "inv_new",
            project: "workspace",
            model: "pi",
            lastActivityAt: "2026-05-26T00:03:00.000Z",
            state: "succeeded",
          },
        ],
      });
    });
  });

  it("reattaches a detached workspace through the local daemon service when it is running", async () => {
    await withTempSparkEnv(async (root) => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const detachedWorkspace = {
        id: "rtwb_socket",
        serverUrl: "http://127.0.0.1:5173/",
        localWorkspaceKey: "socket-workspace",
        displayName: "Socket Workspace",
        localPath: root,
        status: "unavailable" as const,
        capabilities: {},
        diagnostics: { userDetached: true },
        updatedAt: "2026-05-26T00:00:00.000Z",
      };
      const attachedWorkspace = {
        ...detachedWorkspace,
        status: "available" as const,
        diagnostics: {},
      };
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [detachedWorkspace],
      }));
      const attachWorkspaceInService = vi.fn(
        async (_paths: ReturnType<typeof resolveSparkPaths>, id: string) => {
          expect(id).toBe("rtwb_socket");
          return attachedWorkspace;
        },
      );
      const capture = createCliIo({
        listWorkspacesFromService,
        attachWorkspaceInService,
        startService: () => ({
          kind: "detached",
          alreadyRunning: true,
          detail: "Test Spark daemon already running.",
        }),
      });

      await expect(main(["--workspace", "socket-workspace"], capture.io)).resolves.toBe(0);

      expect(listWorkspacesFromService).toHaveBeenCalledOnce();
      expect(attachWorkspaceInService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain("✓ re-attached 'Socket Workspace' ready");
      expect(capture.stdout()).toContain("status   online");
    });
  });

  it("reattaches a detached workspace before showing a targeted workspace", async () => {
    await withTempSparkEnv(async (root) => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const detachedWorkspace = {
        id: "rtwb_socket",
        serverUrl: "http://127.0.0.1:5173/",
        localWorkspaceKey: "socket-workspace",
        displayName: "Socket Workspace",
        localPath: root,
        status: "unavailable" as const,
        capabilities: {},
        diagnostics: { userDetached: true },
        updatedAt: "2026-05-26T00:00:00.000Z",
      };
      const attachedWorkspace = {
        ...detachedWorkspace,
        status: "available" as const,
        diagnostics: {},
        updatedAt: "2026-05-26T00:01:00.000Z",
      };
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [detachedWorkspace],
      }));
      const attachWorkspaceInService = vi.fn(async () => attachedWorkspace);
      const capture = createCliIo({ listWorkspacesFromService, attachWorkspaceInService });

      await expect(main(["ws", "show", "socket-workspace", "--json"], capture.io)).resolves.toBe(0);

      expect(attachWorkspaceInService).toHaveBeenCalledWith(expect.anything(), "rtwb_socket");
      const detail = JSON.parse(capture.stdout()) as Record<string, unknown>;
      expect(detail).toMatchObject({
        slug: "socket-workspace",
        status: "online",
      });
      expect(detail).not.toHaveProperty("offlineReason");
    });
  });

  it("pauses a workspace through the local daemon service when it is running", async () => {
    await withTempSparkEnv(async (root) => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const workspace = {
        id: "rtwb_socket",
        serverUrl: "http://127.0.0.1:5173/",
        localWorkspaceKey: "socket-workspace",
        displayName: "Socket Workspace",
        localPath: root,
        status: "available" as const,
        capabilities: {},
        diagnostics: {},
        updatedAt: "2026-05-26T00:00:00.000Z",
      };
      const stoppedWorkspace = {
        ...workspace,
        status: "unavailable" as const,
        diagnostics: { userDetached: true },
      };
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [workspace],
      }));
      const stopWorkspaceInService = vi.fn(
        async (_paths: ReturnType<typeof resolveSparkPaths>, id: string) => {
          expect(id).toBe("rtwb_socket");
          return stoppedWorkspace;
        },
      );
      const capture = createCliIo({
        listWorkspacesFromService,
        stopWorkspaceInService,
        startService: () => ({
          kind: "detached",
          alreadyRunning: true,
          detail: "Test Spark daemon already running.",
        }),
      });

      await expect(main(["ws", "stop", "socket-workspace", "--yes"], capture.io)).resolves.toBe(0);

      expect(listWorkspacesFromService).toHaveBeenCalledOnce();
      expect(stopWorkspaceInService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain("✓ paused 'Socket Workspace'");
      expect(capture.stdout()).toContain("status   offline · detached");
    });
  });

  it("derives the workspace slug from --name", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      const realWorkspacePath = realpathSync(workspacePath);
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "checkout",
            "--name",
            "Spark Dev",
            "--token",
            "spark_wsreg_test",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);
      expect(capture.stdout()).toContain("✓ workspace 'Spark Dev' registered");

      const listCapture = createCliIo();
      await expect(main(["ws", "ls", "--json", "--no-service"], listCapture.io)).resolves.toBe(0);
      const [workspace] = JSON.parse(listCapture.stdout()) as Array<{
        slug: string;
        name: string;
        serverUrl: string;
        path: string;
      }>;
      expect(workspace).toMatchObject({
        slug: "spark-dev",
        name: "Spark Dev",
        serverUrl: "http://127.0.0.1:5173/",
        path: realWorkspacePath,
      });

      const showCapture = createCliIo();
      await expect(
        main(["ws", "show", "spark-dev", "--json", "--no-service"], showCapture.io),
      ).resolves.toBe(0);
      const detail = JSON.parse(showCapture.stdout()) as {
        slug: string;
        name: string;
        serverUrl: string;
      };
      expect(detail).toMatchObject({
        slug: "spark-dev",
        name: "Spark Dev",
        serverUrl: "http://127.0.0.1:5173/",
      });
    });
  });

  it("emits connection capability timestamps in workspace show json", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "checkout",
            "--name",
            "Spark Dev",
            "--token",
            "spark_wsreg_test",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      const db = openSparkDaemonDatabase(paths);
      try {
        db.prepare(
          `UPDATE workspaces
           SET capabilities_json = ?
           WHERE local_workspace_key = ?`,
        ).run(
          JSON.stringify({
            git: "available",
            profile: {
              status: "offline",
              lastCheckedAt: "2026-05-26T01:02:03.000Z",
              message: "profile files are missing",
            },
          }),
          "spark-dev",
        );
      } finally {
        db.close();
      }

      const showCapture = createCliIo();
      await expect(
        main(["ws", "show", "spark-dev", "--json", "--no-service"], showCapture.io),
      ).resolves.toBe(0);
      const detail = JSON.parse(showCapture.stdout()) as {
        connection: {
          capabilities: Array<{
            id: string;
            status: string;
            lastCheckedAt: string;
            message?: string;
          }>;
        };
        lastStatusChangedAt: string;
      };
      expect(detail.connection.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "git",
            status: "online",
            lastCheckedAt: detail.lastStatusChangedAt,
          }),
          expect.objectContaining({
            id: "profile",
            status: "offline",
            lastCheckedAt: "2026-05-26T01:02:03.000Z",
            message: "profile files are missing",
          }),
        ]),
      );
    });
  });

  it("records explicit workspace profile metadata", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      const profile = createGitProfile(workspacePath);
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "checkout",
            "--name",
            "Spark Dev",
            "--profile",
            profile.ref,
            "--token",
            "spark_wsreg_profile",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);
      expect(capture.stdout()).toContain(`profile  ${profile.ref} @ ${profile.commit.slice(0, 7)}`);

      const showCapture = createCliIo();
      await expect(
        main(["ws", "show", "spark-dev", "--json", "--no-service"], showCapture.io),
      ).resolves.toBe(0);
      const detail = JSON.parse(showCapture.stdout()) as {
        profile?: {
          sourceKind: string;
          ref: string;
          commit: string;
          importedAt: string;
        };
      };
      expect(detail.profile).toMatchObject({
        sourceKind: "git",
        ref: profile.ref,
        commit: profile.commit,
        importedAt: expect.any(String),
      });
    });
  });

  it("asks before importing a detected workspace profile in interactive registration", async () => {
    const capture = createCliIo({
      stdin: interactiveStdin(["checkout", "", "", "y"]),
    });

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      const profile = createGitProfile(workspacePath);
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(main(["ws", "register", "--no-service"], capture.io)).resolves.toBe(0);

      const showCapture = createCliIo();
      await expect(
        main(["ws", "show", "checkout", "--json", "--no-service"], showCapture.io),
      ).resolves.toBe(0);
      const detail = JSON.parse(showCapture.stdout()) as {
        profile?: {
          ref: string;
          commit: string;
        };
      };
      expect(detail.profile).toMatchObject({
        ref: "./spark-profile",
        commit: profile.commit,
      });
    });
  });

  it("does not import a detected profile during scripted registration", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      createGitProfile(workspacePath);
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "checkout",
            "--name",
            "Spark Dev",
            "--token",
            "spark_wsreg_test",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      const showCapture = createCliIo();
      await expect(
        main(["ws", "show", "spark-dev", "--json", "--no-service"], showCapture.io),
      ).resolves.toBe(0);
      const detail = JSON.parse(showCapture.stdout()) as { profile?: unknown };
      expect(detail.profile).toBeUndefined();
    });
  });

  it("resolves duplicate workspace names with a server suffix", async () => {
    const capture = createCliIo();
    const fetchFn = stubRuntimeRegistrationFetch();

    try {
      await withTempSparkEnv(async (root) => {
        const workspacePath = join(root, "checkout");
        mkdirSync(workspacePath, { recursive: true });
        const realWorkspacePath = realpathSync(workspacePath);
        process.env.INIT_CWD = root;
        writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

        await expect(
          main(
            [
              "ws",
              "register",
              "checkout",
              "--name",
              "Spark Dev",
              "--token",
              "spark_wsreg_first",
              "--no-service",
            ],
            capture.io,
          ),
        ).resolves.toBe(0);
        await expect(
          main(
            [
              "ws",
              "register",
              "checkout",
              "--server-url",
              "http://127.0.0.1:5174",
              "--token",
              "spark_wsreg_second",
              "--name",
              "Spark Dev",
              "--no-service",
            ],
            capture.io,
          ),
        ).resolves.toBe(0);
        expect(fetchFn).not.toHaveBeenCalled();

        const listCapture = createCliIo();
        await expect(main(["ws", "ls", "--json", "--no-service"], listCapture.io)).resolves.toBe(0);
        const workspaces = JSON.parse(listCapture.stdout()) as Array<{
          slug: string;
          name: string;
          serverUrl: string;
          path: string;
        }>;
        expect(workspaces).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              slug: "spark-dev",
              name: "Spark Dev",
              serverUrl: "http://127.0.0.1:5173/",
              path: realWorkspacePath,
            }),
            expect.objectContaining({
              slug: "spark-dev",
              name: "Spark Dev",
              serverUrl: "http://127.0.0.1:5174/",
              path: realWorkspacePath,
            }),
          ]),
        );

        const ambiguousCapture = createCliIo();
        await expect(
          main(["ws", "show", "Spark Dev", "--no-service"], ambiguousCapture.io),
        ).resolves.toBe(1);
        expect(ambiguousCapture.stderr()).toContain("Ambiguous workspace name");
        expect(ambiguousCapture.stderr()).toContain("Spark Dev@http://127.0.0.1:5173/");
        expect(ambiguousCapture.stderr()).toContain("Spark Dev@http://127.0.0.1:5174/");

        const showCapture = createCliIo();
        await expect(
          main(
            ["ws", "show", "Spark Dev@http://127.0.0.1:5174", "--json", "--no-service"],
            showCapture.io,
          ),
        ).resolves.toBe(0);
        const detail = JSON.parse(showCapture.stdout()) as {
          slug: string;
          name: string;
          serverUrl: string;
        };
        expect(detail).toMatchObject({
          slug: "spark-dev",
          name: "Spark Dev",
          serverUrl: "http://127.0.0.1:5174/",
        });
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("directs an unauthenticated daemon to login before tokenless workspace registration", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), {
        installationId: "install-test",
        displayName: "Test daemon",
        serverUrl: "http://127.0.0.1:5173",
      });

      await expect(
        main(["ws", "register", "checkout", "--name", "Spark Dev", "--no-service"], capture.io),
      ).resolves.toBe(1);
      expect(capture.stderr()).toContain("spark daemon login --server-url http://127.0.0.1:5173/");

      const listCapture = createCliIo();
      await expect(main(["ws", "ls", "--json", "--no-service"], listCapture.io)).resolves.toBe(0);
      expect(JSON.parse(listCapture.stdout())).toEqual([]);
    });
  });

  it("reuses machine credentials for another workspace and preserves server workspace identity", async () => {
    const registerWorkspaceInService = vi.fn(
      async (
        _paths: ReturnType<typeof resolveSparkPaths>,
        options: Parameters<NonNullable<CliIo["registerWorkspaceInService"]>>[1],
      ) => ({
        id: "rtwb_tokenless",
        serverUrl: options.serverUrl ?? "",
        localWorkspaceKey: options.localWorkspaceKey ?? "local-checkout",
        displayName: options.displayName ?? "Local checkout",
        localPath: options.localPath,
        status: "available" as const,
        capabilities: {},
        diagnostics: {},
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
    );
    const capture = createCliIo({ registerWorkspaceInService });

    await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"), { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "checkout",
            "--name",
            "Local checkout",
            "--workspace-name",
            "Profile workspace",
            "--workspace-slug",
            "profile-workspace",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      expect(registerWorkspaceInService).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          displayName: "Local checkout",
          workspaceName: "Profile workspace",
          workspaceSlug: "profile-workspace",
        }),
      );
      expect(registerWorkspaceInService.mock.calls[0]?.[1]).not.toHaveProperty("registrationToken");
    });
  });

  it("does not misclassify a daemon-reported Cockpit fetch error as local RPC downtime", async () => {
    await withTempSparkEnv(async (root) => {
      mkdirSync(join(root, "checkout"), { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());
      const capture = createCliIo({
        registerWorkspaceInService: vi.fn(async () => {
          throw new Error(
            "Request to http://127.0.0.1:5173/api/v1/runtime failed (Cockpit origin: http://127.0.0.1:5173): fetch failed",
          );
        }),
      });

      await expect(
        main(["ws", "register", "checkout", "--name", "Checkout"], capture.io),
      ).resolves.toBe(1);
      expect(capture.stderr()).toContain("Cockpit origin: http://127.0.0.1:5173");
      expect(capture.stderr()).not.toContain("Spark daemon is running but cannot be reached");
    });
  });

  it("returns conflict exit code when the workspace path does not exist", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "missing", "--token", "spark_wsreg_missing", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(3);
      expect(capture.stderr()).toContain("Workspace directory does not exist");
    });
  });

  it("resolves workspace show from the invocation cwd when no name is passed", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "first",
            "--name",
            "First",
            "--token",
            "spark_wsreg_first",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);
      await expect(
        main(
          [
            "ws",
            "register",
            "second",
            "--name",
            "Second",
            "--token",
            "spark_wsreg_second",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      process.env.INIT_CWD = second;
      const showCapture = createCliIo();
      await expect(main(["ws", "show", "--json", "--no-service"], showCapture.io)).resolves.toBe(0);
      const detail = JSON.parse(showCapture.stdout()) as { slug: string; name: string };
      expect(detail).toMatchObject({
        slug: "second",
        name: "Second",
      });

      process.env.INIT_CWD = root;
      const explicitShowCapture = createCliIo();
      await expect(
        main(
          ["ws", "show", "--workspace", "First", "--json", "--no-service"],
          explicitShowCapture.io,
        ),
      ).resolves.toBe(0);
      const explicitDetail = JSON.parse(explicitShowCapture.stdout()) as {
        slug: string;
        name: string;
      };
      expect(explicitDetail).toMatchObject({
        slug: "first",
        name: "First",
      });

      const readyCapture = createCliIo({
        startService: () => ({
          kind: "detached",
          alreadyRunning: false,
          detail: "Started test Spark daemon.",
        }),
      });
      await expect(main(["--workspace", "Second", "--no-service"], readyCapture.io)).resolves.toBe(
        0,
      );
      expect(readyCapture.stdout()).toContain("✓ workspace 'Second' ready");
      expect(readyCapture.stdout()).not.toContain("Started test Spark daemon.");
    });
  });

  it("requires cwd to be under a workspace for unnamed workspace show", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "workspace",
            "--name",
            "Workspace",
            "--token",
            "spark_wsreg_test",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      const showCapture = createCliIo();
      await expect(main(["ws", "show", "--json", "--no-service"], showCapture.io)).resolves.toBe(1);
      expect(showCapture.stderr()).toContain("is not under a registered workspace");
    });
  });

  it("requires --yes for workspace stop in non-interactive use", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "workspace", "--token", "spark_wsreg_test", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);

      const stopCapture = createCliIo();
      await expect(main(["ws", "stop", "workspace", "--no-service"], stopCapture.io)).resolves.toBe(
        4,
      );
      expect(stopCapture.stderr()).toContain("Pass --yes to confirm");

      const listCapture = createCliIo();
      await expect(main(["ws", "ls", "--json", "--no-service"], listCapture.io)).resolves.toBe(0);
      const [workspace] = JSON.parse(listCapture.stdout()) as Array<{ status: string }>;
      expect(workspace?.status).toBe("offline:service-stopped");
    });
  });

  it("requires an explicit workspace target for workspace stop", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "workspace", "--token", "spark_wsreg_test", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);

      const stopCapture = createCliIo();
      await expect(main(["ws", "stop", "--yes"], stopCapture.io)).resolves.toBe(1);
      expect(stopCapture.stderr()).toContain("Pass a workspace name or --workspace <name>");

      const explicitStopCapture = createCliIo({
        startService: () => ({
          kind: "detached",
          alreadyRunning: true,
          detail: "Test Spark daemon already running.",
        }),
      });
      await expect(
        main(
          ["ws", "stop", "--workspace", "workspace", "--yes", "--no-service"],
          explicitStopCapture.io,
        ),
      ).resolves.toBe(0);
      expect(explicitStopCapture.stdout()).toContain("✓ paused 'workspace'");
    });
  });

  it("returns conflict exit code for nested workspace registration", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const parent = join(root, "parent");
      const child = join(parent, "child");
      mkdirSync(child, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "parent", "--token", "spark_wsreg_parent", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);

      const conflictCapture = createCliIo();
      await expect(
        main(
          [
            "ws",
            "register",
            "parent/child",
            "--name",
            "child",
            "--token",
            "spark_wsreg_child",
            "--no-service",
          ],
          conflictCapture.io,
        ),
      ).resolves.toBe(3);
      expect(conflictCapture.stderr()).toContain("cannot be nested with registered workspace");
    });
  });

  it("returns conflict exit code when an existing workspace key points at another path", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      process.env.INIT_CWD = root;
      writeSparkDaemonConfig(resolveSparkPaths({ app: "daemon" }), testSparkDaemonConfig());

      await expect(
        main(
          [
            "ws",
            "register",
            "first",
            "--key",
            "stable",
            "--token",
            "spark_wsreg_first",
            "--no-service",
          ],
          capture.io,
        ),
      ).resolves.toBe(0);

      const conflictCapture = createCliIo();
      await expect(
        main(
          [
            "ws",
            "register",
            "second",
            "--key",
            "stable",
            "--token",
            "spark_wsreg_second",
            "--no-service",
          ],
          conflictCapture.io,
        ),
      ).resolves.toBe(3);
      expect(conflictCapture.stderr()).toContain("Workspace key stable is already registered");
    });
  });

  it("renders degraded workspace reasons and remediation", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "workspace", "--token", "spark_wsreg_test", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);
      writeFileSync(paths.pidFile, `${process.pid}\n`);

      const db = openSparkDaemonDatabase(paths);
      try {
        db.prepare(
          `UPDATE workspaces
           SET status = 'degraded', diagnostics_json = ?
           WHERE local_workspace_key = ?`,
        ).run(
          JSON.stringify({
            degradedReasons: ["filesystem.unreachable", "profile.invalid", "unknown.reason"],
          }),
          "workspace",
        );
      } finally {
        db.close();
      }

      const listCapture = createCliIo({
        listWorkspacesFromService: () => workspaceListResultFromDb(paths),
      });
      await expect(main(["ws", "ls", "--json"], listCapture.io)).resolves.toBe(0);
      const [workspace] = JSON.parse(listCapture.stdout()) as Array<{
        status: string;
        degradedReasons?: string[];
      }>;
      expect(workspace).toMatchObject({
        status: "degraded",
        degradedReasons: ["filesystem.unreachable", "profile.invalid"],
      });

      const showCapture = createCliIo({
        listWorkspacesFromService: () => workspaceListResultFromDb(paths),
      });
      await expect(main(["ws", "show", "workspace"], showCapture.io)).resolves.toBe(0);
      expect(showCapture.stdout()).toContain("status         degraded");
      expect(showCapture.stdout()).toContain(
        "workspace path not reachable (filesystem.unreachable)",
      );
      expect(showCapture.stdout()).toContain("imported profile is invalid (profile.invalid)");
      expect(showCapture.stdout()).toContain("remediation");
      expect(showCapture.stdout()).toContain("spark daemon workspace stop workspace");
    });
  });

  it("renders disconnected offline state when the Spark daemon is running", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      writeSparkDaemonConfig(paths, testSparkDaemonConfig());

      await expect(
        main(
          ["ws", "register", "workspace", "--token", "spark_wsreg_test", "--no-service"],
          capture.io,
        ),
      ).resolves.toBe(0);
      writeFileSync(paths.pidFile, `${process.pid}\n`);

      const db = openSparkDaemonDatabase(paths);
      try {
        db.prepare(
          `UPDATE workspaces
           SET status = 'unavailable', diagnostics_json = ?
           WHERE local_workspace_key = ?`,
        ).run(JSON.stringify({ reason: "server.unreachable" }), "workspace");
      } finally {
        db.close();
      }

      const listCapture = createCliIo({
        listWorkspacesFromService: () => workspaceListResultFromDb(paths),
      });
      await expect(main(["ws", "ls"], listCapture.io)).resolves.toBe(0);
      expect(listCapture.stdout()).toContain("offline · disconnected");

      const jsonCapture = createCliIo({
        listWorkspacesFromService: () => workspaceListResultFromDb(paths),
      });
      await expect(main(["ws", "ls", "--json"], jsonCapture.io)).resolves.toBe(0);
      const [workspace] = JSON.parse(jsonCapture.stdout()) as Array<{
        status: string;
        offlineReason: string;
      }>;
      expect(workspace).toMatchObject({
        status: "offline:disconnected",
        offlineReason: "disconnected",
      });

      const showCapture = createCliIo({
        listWorkspacesFromService: () => workspaceListResultFromDb(paths),
      });
      await expect(main(["ws", "show", "workspace"], showCapture.io)).resolves.toBe(0);
      expect(showCapture.stdout()).toContain("offline reason disconnected");
      expect(showCapture.stdout()).toContain("server connection is unavailable");
    });
  });

  it("renders service-stopped offline reason in workspace show", async () => {
    await withTempSparkEnv(async (root) => {
      const listWorkspacesFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        workspaces: [
          {
            id: "rtwb_stopped",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "workspace",
            displayName: "workspace",
            localPath: root,
            status: "available" as const,
            capabilities: {},
            diagnostics: {},
            updatedAt: "2026-05-26T00:00:00.000Z",
          },
        ],
      }));
      const capture = createCliIo({ listWorkspacesFromService });

      await expect(main(["ws", "show", "workspace"], capture.io)).resolves.toBe(0);

      expect(capture.stdout()).toContain("status         offline · service stopped");
      expect(capture.stdout()).toContain("offline reason service-stopped");
      expect(capture.stdout()).toContain("Spark daemon is not running");
    });
  });

  it("prints daemon status without starting the Spark daemon", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async () => {
      await expect(main(["daemon", "status"], capture.io)).resolves.toBe(0);
      expect(capture.stdout()).toContain("not running");
      expect(capture.stdout()).toContain("spark daemon start");
      expect(capture.stderr()).toBe("");

      const jsonCapture = createCliIo();
      await expect(main(["daemon", "status", "--json"], jsonCapture.io)).resolves.toBe(0);
      const status = JSON.parse(jsonCapture.stdout()) as {
        running: boolean;
        socketPath: string;
      };
      expect(status).toMatchObject({
        running: false,
        socketPath: expect.stringContaining("daemon.sock"),
      });
    });
  });

  it("emits running daemon status from the local daemon service", async () => {
    await withTempSparkEnv(async (root) => {
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      process.env.INIT_CWD = root;
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      const daemonStatusFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        servers: [
          {
            url: "http://127.0.0.1:5173/",
            workspaceCount: 1,
            wsConnected: false,
          },
        ],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }));

      const jsonCapture = createCliIo({ daemonStatusFromService });
      await expect(main(["daemon", "status", "--json"], jsonCapture.io)).resolves.toBe(0);
      const status = JSON.parse(jsonCapture.stdout()) as {
        running: boolean;
        pid: number;
        stateDbPath: string;
        servers: Array<{ url: string; workspaceCount: number; wsConnected: boolean }>;
      };
      expect(status).toMatchObject({
        running: true,
        pid: process.pid,
        stateDbPath: paths.databasePath,
        servers: [
          {
            url: "http://127.0.0.1:5173/",
            workspaceCount: 1,
            wsConnected: false,
          },
        ],
      });

      const textCapture = createCliIo({ daemonStatusFromService });
      await expect(main(["daemon", "status"], textCapture.io)).resolves.toBe(0);
      expect(textCapture.stdout()).toContain("running");
      expect(textCapture.stdout()).toContain("registered       1 workspaces across 1 servers");
    });
  });

  it("reports unreachable daemon status when the Spark daemon cannot be reached", async () => {
    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      const daemonStatusFromService = vi.fn(async () => {
        throw new Error("socket refused");
      });

      const capture = createCliIo({ daemonStatusFromService });
      await expect(main(["daemon", "status"], capture.io)).resolves.toBe(0);

      expect(daemonStatusFromService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain("unreachable");
      expect(capture.stdout()).toContain("socket refused");
      expect(capture.stdout()).toContain("spark daemon restart");
      expect(capture.stderr()).toBe("");
    });
  });

  it("reads running daemon status summaries from the local daemon service", async () => {
    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      const daemonStatusFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        servers: [
          {
            url: "https://spark.example.com/",
            workspaceCount: 3,
            wsConnected: true,
          },
        ],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }));

      const capture = createCliIo({ daemonStatusFromService });
      await expect(main(["daemon", "status", "--json"], capture.io)).resolves.toBe(0);

      expect(daemonStatusFromService).toHaveBeenCalledOnce();
      expect(JSON.parse(capture.stdout())).toMatchObject({
        running: true,
        pid: process.pid,
        stateDbPath: paths.databasePath,
        servers: [
          {
            url: "https://spark.example.com/",
            workspaceCount: 3,
            wsConnected: true,
          },
        ],
      });
    });
  });

  it("builds legacy status from daemon status instead of direct workspace reads", async () => {
    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      writeSparkDaemonConfig(
        paths,
        testSparkDaemonConfig({ serverUrl: "https://spark.example.com" }),
      );
      const daemonStatusFromService = vi.fn(async () => ({
        observedAt: "2026-05-26T00:00:00.000Z",
        servers: [
          { url: "https://spark.example.com/", workspaceCount: 2, wsConnected: true },
          { url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: false },
        ],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }));

      const capture = createCliIo({ daemonStatusFromService });
      await expect(main(["status"], capture.io)).resolves.toBe(0);

      expect(daemonStatusFromService).toHaveBeenCalledOnce();
      expect(JSON.parse(capture.stdout())).toMatchObject({
        enrolled: true,
        daemonRunning: true,
        workspaceCount: 3,
      });
    });
  });

  it("does not expose the legacy workspace reconcile command", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async () => {
      await expect(main(["ws", "reconcile"], capture.io)).resolves.toBe(1);
      expect(capture.stderr()).toContain("Usage: spark daemon workspace <register|ls|show|stop>");
    });
  });

  it("tails daemon logs with the requested line count", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.logDir, { recursive: true });
      writeFileSync(paths.logFile, "one\ntwo\nthree\nfour\n");

      await expect(main(["daemon", "logs", "--lines", "2"], capture.io)).resolves.toBe(0);
      expect(capture.stdout()).toBe("three\nfour\n");
      expect(capture.stderr()).toBe("");
    });
  });

  it("prints a clear daemon logs message before the log file exists", async () => {
    const capture = createCliIo();

    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });

      await expect(main(["daemon", "logs"], capture.io)).resolves.toBe(0);
      expect(capture.stdout()).toContain(`no logs yet: ${paths.logFile}`);
      expect(capture.stderr()).toBe("");
    });
  });

  it("requires --yes for Spark daemon stop in non-interactive use", async () => {
    const capture = createCliIo();

    const code = await withTempSparkEnv(() => main(["daemon", "stop"], capture.io));

    expect(code).toBe(4);
    expect(capture.stderr()).toContain("Pass --yes to confirm");
    expect(capture.stderr()).toContain("Stop Spark daemon");
  });

  it("requests the local daemon to stop before falling back to process termination", async () => {
    await withTempSparkEnv(async () => {
      const paths = resolveSparkPaths({ app: "daemon" });
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(paths.pidFile, `${process.pid}\n`);
      const daemonStopFromService = vi.fn(async () => ({
        stopping: true as const,
        observedAt: "2026-05-26T00:00:00.000Z",
      }));
      const capture = createCliIo({ daemonStopFromService });

      await expect(main(["daemon", "stop", "--yes"], capture.io)).resolves.toBe(0);

      expect(daemonStopFromService).toHaveBeenCalledOnce();
      expect(capture.stdout()).toContain(`Stopped Spark daemon process ${process.pid}.`);
      expect(capture.stderr()).toBe("");
    });
  });
});

async function withTempSparkEnv<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spark-daemon-cli-")));
  const previousEnv = {
    HOME: process.env.HOME,
    INIT_CWD: process.env.INIT_CWD,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    SPARK_DAEMON_DATA_DIR: process.env.SPARK_DAEMON_DATA_DIR,
    SPARK_DAEMON_CACHE_DIR: process.env.SPARK_DAEMON_CACHE_DIR,
    SPARK_DAEMON_STATE_DIR: process.env.SPARK_DAEMON_STATE_DIR,
    SPARK_DAEMON_CWD: process.env.SPARK_DAEMON_CWD,
    SPARK_WORKSPACE_REGISTRATION_TOKEN: process.env.SPARK_WORKSPACE_REGISTRATION_TOKEN,
  };

  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_RUNTIME_DIR = join(root, "run");
  delete process.env.SPARK_DAEMON_DATA_DIR;
  delete process.env.SPARK_DAEMON_CACHE_DIR;
  delete process.env.SPARK_DAEMON_STATE_DIR;
  delete process.env.SPARK_DAEMON_CWD;
  delete process.env.SPARK_WORKSPACE_REGISTRATION_TOKEN;

  try {
    return await callback(root);
  } finally {
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function deviceLoginRegistrationResponse() {
  return {
    runtimeId: "rt_11111111111141111111111111111111",
    runtimeToken: "spark_rt_device_token_0000000000000000000000000000",
    runtimeTokenExpiresAt: "2026-07-13T02:00:00.000Z",
    refreshToken: "spark_rt_device_refresh_00000000000000000000000000",
    refreshTokenExpiresAt: "2026-08-12T01:00:00.000Z",
    protocolVersion: runtimeProtocolVersion,
    webSocketUrl: "/api/v1/runtime/runtimes/rt_11111111111141111111111111111111/ws",
    heartbeatIntervalMs: 15_000,
    staleAfterMs: 45_000,
    registeredAt: "2026-07-13T01:00:00.000Z",
  };
}

function parseRequestJson(init?: RequestInit): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new TypeError("Expected a JSON string request body");
  return JSON.parse(body) as unknown;
}

function stdinFrom(value: string, isTTY = false): NodeJS.ReadStream {
  const stdin = Readable.from([value]) as NodeJS.ReadStream;
  Object.defineProperty(stdin, "isTTY", { value: isTTY });
  return stdin;
}

function interactiveStdin(lines: string[]): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stdin, "isTTY", { value: true });
  lines.forEach((line, index) => {
    setTimeout(() => stdin.write(`${line}\n`), index * 25);
  });
  setTimeout(() => stdin.end(), lines.length * 25 + 25);
  return stdin;
}

function createGitProfile(workspacePath: string): { ref: string; commit: string } {
  const ref = "spark-profile";
  const profilePath = join(workspacePath, ref);
  mkdirSync(profilePath, { recursive: true });
  writeFileSync(
    join(profilePath, "settings.toml"),
    `schemaVersion = "spark.profile/v1"

[profile]
id = "spark-dev"
name = "Spark Dev"
`,
  );
  const git = gitCommand();
  execFileSync(git, ["init"], { cwd: profilePath, stdio: "ignore" });
  execFileSync(git, ["add", "settings.toml"], { cwd: profilePath, stdio: "ignore" });
  execFileSync(
    git,
    [
      "-c",
      "user.email=spark@example.test",
      "-c",
      "user.name=Spark Test",
      "commit",
      "-m",
      "Initial profile",
    ],
    { cwd: profilePath, stdio: "ignore" },
  );
  const commit = execFileSync(git, ["rev-parse", "HEAD"], {
    cwd: profilePath,
    encoding: "utf8",
  }).trim();
  return { ref, commit };
}

function stubRuntimeRegistrationFetch() {
  const runtimeId = "rt_11111111111141111111111111111111";
  const fetchFn = vi.fn(async (url: URL | string) => {
    const registrationUrl = new URL(String(url));
    const serverUrl = new URL(registrationUrl);
    serverUrl.pathname = "/";
    serverUrl.search = "";
    serverUrl.hash = "";
    const webSocketUrl = new URL(`/api/v1/runtime/runtimes/${runtimeId}/ws`, serverUrl);
    webSocketUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";

    return new Response(
      JSON.stringify({
        runtimeId,
        runtimeToken: "spark_rt_token_00000000000000000000000000000000",
        runtimeTokenExpiresAt: "2026-05-26T01:00:00.000Z",
        refreshToken: "spark_rt_refresh_000000000000000000000000000000",
        refreshTokenExpiresAt: "2026-06-25T00:00:00.000Z",
        protocolVersion: runtimeProtocolVersion,
        webSocketUrl: webSocketUrl.toString(),
        heartbeatIntervalMs: 15_000,
        staleAfterMs: 45_000,
        registeredAt: "2026-05-26T00:00:00.000Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}
