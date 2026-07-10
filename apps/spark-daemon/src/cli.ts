import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  watchFile,
  unwatchFile,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createSparkProviderControl } from "@zendev-lab/spark-ai/control";
import { ensureSparkPathDirs, gitCommand, resolveSparkPaths } from "@zendev-lab/spark-system";
import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import {
  defaultSparkDaemonConfig,
  readSparkDaemonConfig,
  writeSparkDaemonConfig,
} from "./config.js";
import { sparkDaemonVersion, startSparkDaemon } from "./daemon.js";
import { createSparkDaemonModelControl } from "./model-control.ts";
import { createDaemonChannelIngressRuntime } from "./channels/ingress.ts";
import {
  SparkDaemonInvocationRegistry,
  SparkDaemonQueue,
  acquireSparkDaemonLock,
} from "./core/index.ts";
import {
  LocalRpcUnavailableError,
  createDaemonSessionRegistry,
  createSparkDaemonLocalEventBus,
  localRpcSocketPath,
  requestDaemonQueue,
  requestDaemonStop,
  requestDaemonStatus,
  requestTurnSubmit,
  requestWorkspaceAttach,
  requestWorkspaceList,
  requestWorkspaceRegister,
  requestWorkspaceStop,
  startLocalRpcServer,
} from "./local-rpc.js";
import {
  configuredServerUrl,
  hasRunnableSparkDaemonCredentialsForServer,
  RegistrationGrantRefusedError,
  validateRegistrationServerUrl,
} from "./registration.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import {
  isUserDetachedWorkspace,
  type RegisterWorkspaceOptions,
  type SparkDaemonWorkspace,
  type WorkspaceProfileRegistration,
  workspaceNameForPath,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import { readRunningPid, startSparkDaemonService, stopSparkDaemonService } from "./service.js";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdin?: NodeJS.ReadStream;
  startService?: typeof startSparkDaemonService;
  daemonStatusFromService?: typeof requestDaemonStatus;
  daemonStopFromService?: typeof requestDaemonStop;
  daemonQueueFromService?: typeof requestDaemonQueue;
  turnSubmitToService?: typeof requestTurnSubmit;
  listWorkspacesFromService?: typeof requestWorkspaceList;
  registerWorkspaceInService?: typeof requestWorkspaceRegister;
  attachWorkspaceInService?: typeof requestWorkspaceAttach;
  stopWorkspaceInService?: typeof requestWorkspaceStop;
}

const defaultIo: CliIo = { stdout: process.stdout, stderr: process.stderr };
const STRINGS = sparkDaemonCliStrings();

class SparkDaemonUnavailableError extends Error {
  constructor(cause: unknown, options: { running?: boolean } = {}) {
    const prefix =
      options.running === false
        ? "Spark daemon could not be started"
        : "Spark daemon is running but cannot be reached";
    super(
      `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}. Run spark daemon status.`,
    );
  }
}

class WorkspacePathValidationError extends Error {}

function prepareSparkDaemonState(paths: ReturnType<typeof resolveSparkPaths>): void {
  ensureSparkPathDirs(paths);
}

export async function main(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, subcommand, ...rest] = args;
  const paths = resolveSparkPaths({ app: "daemon" });

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      printHelp(io);
      return 0;
    }

    if (command?.startsWith("--")) {
      return await defaultWorkspace(paths, args, io);
    }

    switch (command) {
      case undefined:
        return await defaultWorkspace(paths, [], io);
      case "install":
        return install(paths, io);
      case "doctor":
        return await doctor(paths, io);
      case "status":
        return await status(paths, io);
      case "logs":
        io.stdout.write(`${paths.logFile}\n`);
        return 0;
      case "login":
        io.stdout.write(
          `Spark daemon credentials are stored under ${paths.dataDir}. Task execution uses the Spark runtime bridge; configure provider/auth state through Spark/Pi tooling before running tasks.\n`,
        );
        return 0;
      case "start":
        return await start(paths);
      case "stop":
        return await stop(paths, args.slice(1), io);
      case "restart":
        return await restart(paths, args.slice(1), io);
      case "queue":
        return await daemonQueue(paths, args.slice(1), io);
      case "submit":
        return await daemonSubmit(paths, args.slice(1), io);
      case "workspace":
      case "ws":
        return await workspace(paths, subcommand, rest, io);
      case "daemon":
        return await daemon(paths, subcommand, rest, io);
      default:
        io.stderr.write(`${STRINGS.unknownCommand(command)}\n`);
        printHelp(io);
        return 2;
    }
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (
      error instanceof WorkspacePathConflictError ||
      error instanceof WorkspacePathValidationError ||
      error instanceof RegistrationGrantRefusedError
    ) {
      return 3;
    }
    if (error instanceof SparkDaemonUnavailableError || error instanceof LocalRpcUnavailableError) {
      return 2;
    }
    return 1;
  }
}

function install(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo): number {
  prepareSparkDaemonState(paths);
  const config = existsSync(paths.configFile)
    ? readSparkDaemonConfig(paths)
    : defaultSparkDaemonConfig();
  writeSparkDaemonConfig(paths, config);
  io.stdout.write(`Installed Spark daemon at ${paths.dataDir}\n`);
  return 0;
}

async function doctor(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo): Promise<number> {
  prepareSparkDaemonState(paths);
  const config = readSparkDaemonConfig(paths);
  const daemon = await buildDaemonStatus(paths, io);
  const workspace = await buildDoctorWorkspaceStatus(paths, io, daemon);
  const serverUrl = configuredServerUrl(config);
  const credentialsOk = serverUrl
    ? hasRunnableSparkDaemonCredentialsForServer(config, serverUrl)
    : false;
  const cockpit = buildDoctorCockpitStatus();
  io.stdout.write(
    JSON.stringify(
      {
        version: sparkDaemonVersion,
        checks: {
          daemon: {
            ok: daemon.running === true,
            running: daemon.running,
            socketPath: daemon.socketPath,
            ...(daemon.running ? { queue: daemon.queue } : {}),
            ...("unreachable" in daemon && daemon.unreachable
              ? { unreachable: true, error: daemon.error }
              : {}),
          },
          credentials: {
            ok: credentialsOk,
            enrolled: Boolean(config.runtimeId && config.runtimeToken),
            serverUrl: serverUrl ?? null,
            runtimeTokenExpiresAt: config.runtimeTokenExpiresAt,
            refreshTokenExpiresAt: config.refreshTokenExpiresAt,
          },
          workspace,
          cockpit,
        },
        paths,
        config: {
          installationId: config.installationId,
          displayName: config.displayName,
          serverUrl: config.serverUrl,
          runtimeId: config.runtimeId,
          runtimeTokenExpiresAt: config.runtimeTokenExpiresAt,
          refreshTokenExpiresAt: config.refreshTokenExpiresAt,
          enrolled: Boolean(config.runtimeId && config.runtimeToken),
        },
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

async function buildDoctorWorkspaceStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  daemon: DaemonStatus,
): Promise<Record<string, unknown>> {
  if (!daemon.running) {
    return {
      ok: false,
      reachable: false,
      workspaces: 0,
      detail: "Spark daemon is not running; workspace state was not queried.",
    };
  }
  try {
    const result = await (io.listWorkspacesFromService ?? requestWorkspaceList)(paths);
    return {
      ok: true,
      reachable: true,
      workspaces: result.workspaces.length,
      observedAt: result.observedAt,
    };
  } catch (error) {
    return { ok: false, reachable: false, workspaces: 0, error: errorMessage(error) };
  }
}

function errorCode(error: Error | undefined): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function buildDoctorCockpitStatus(): Record<string, unknown> {
  const packagePath = fileURLToPath(new URL("../../spark-cockpit/package.json", import.meta.url));
  const packageAvailable = existsSync(packagePath);
  const command = "spark-cockpit";
  const commandProbe = spawnSync(command, ["--help"], { stdio: "ignore", timeout: 1_000 });
  const commandErrorCode = errorCode(commandProbe.error);
  const commandAvailable = !commandProbe.error || commandErrorCode !== "ENOENT";
  return {
    ok: packageAvailable || commandAvailable,
    packageAvailable,
    command,
    commandAvailable,
    ...(commandProbe.error && commandErrorCode !== "ENOENT"
      ? { error: commandProbe.error.message }
      : {}),
  };
}

async function status(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo): Promise<number> {
  prepareSparkDaemonState(paths);
  const config = readSparkDaemonConfig(paths);
  const daemon = await buildDaemonStatus(paths, io);
  const workspaceCount = daemon.running
    ? daemon.servers.reduce((sum, server) => sum + server.workspaceCount, 0)
    : 0;
  io.stdout.write(
    JSON.stringify(
      {
        enrolled: Boolean(config.runtimeId && config.runtimeToken),
        runtimeId: config.runtimeId,
        serverUrl: config.serverUrl,
        runtimeTokenExpiresAt: config.runtimeTokenExpiresAt,
        refreshTokenExpiresAt: config.refreshTokenExpiresAt,
        workspaceCount,
        daemonRunning: daemon.running,
        queue: daemon.running ? daemon.queue : undefined,
        pidFile: paths.pidFile,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

async function start(paths: ReturnType<typeof resolveSparkPaths>): Promise<number> {
  prepareSparkDaemonState(paths);
  const lock = await acquireSparkDaemonLock({ runtimeDir: paths.runtimeDir, cwd: process.cwd() });
  const db = openSparkDaemonDatabase(paths);
  const shutdown = new AbortController();
  const onShutdownSignal = () => {
    shutdown.abort();
  };
  process.once("SIGINT", onShutdownSignal);
  process.once("SIGTERM", onShutdownSignal);
  const localEventBus = createSparkDaemonLocalEventBus();
  const invocationRegistry = new SparkDaemonInvocationRegistry();
  const queue = new SparkDaemonQueue({ paths });
  const sparkHome = process.env.SPARK_HOME?.trim() || join(homedir(), ".spark");
  const sessionRegistry = createDaemonSessionRegistry(sparkHome);
  const modelControl = createSparkDaemonModelControl({
    providerControl: createSparkProviderControl({ sparkHome }),
    sessionRegistry,
  });
  const channelIngress = createDaemonChannelIngressRuntime({
    sparkHome,
    sessionRegistry,
    hooks: {
      onAssignment: async (assignment) => {
        const model = await modelControl.effectiveModel(assignment.sessionId);
        await modelControl.prepareModel(model);
        await queue.enqueue({
          type: "session.run",
          sessionId: assignment.sessionId,
          prompt: assignment.goal,
          model: `${model.providerName}/${model.modelId}`,
          assignment: assignment.assignment,
          workspaceId: assignment.channelReply.workspaceId,
          channelReply: assignment.channelReply,
        });
      },
    },
  });
  const localRpc = await startLocalRpcServer({
    paths,
    sparkHome,
    db,
    onStop: () => shutdown.abort(),
    eventBus: localEventBus,
    invocationRegistry,
    channelIngress,
    sessionRegistry,
    modelControl,
  });
  try {
    await startSparkDaemon({
      paths,
      sparkHome,
      config: readSparkDaemonConfig(paths),
      db,
      signal: shutdown.signal,
      localEventSink: (event) => localEventBus.publish(event),
      invocationRegistry,
      queue,
      channelIngress,
      modelControl,
    });
    return 0;
  } finally {
    process.off("SIGINT", onShutdownSignal);
    process.off("SIGTERM", onShutdownSignal);
    await localRpc.close();
    db.close();
    await lock.release();
  }
}

async function stop(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (!(await confirmAction(io, parseFlags(args), "Stop Spark daemon?"))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const pid = readRunningPid(paths);
  if (!pid) {
    io.stdout.write("Spark daemon is not running.\n");
    return 0;
  }

  try {
    await (io.daemonStopFromService ?? requestDaemonStop)(paths);
    io.stdout.write(`Stopped Spark daemon process ${pid}.\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof LocalRpcUnavailableError)) {
      throw error;
    }
  }

  const service = stopSparkDaemonService(paths);
  if (service) {
    io.stdout.write(`${service.detail}\n`);
    return 0;
  }

  process.kill(pid, "SIGTERM");
  io.stdout.write(`Stopped Spark daemon process ${pid}.\n`);
  return 0;
}

async function daemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (helpRequested(args)) {
    printDaemonHelp(io);
    return 0;
  }

  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printDaemonHelp(io);
      return 0;
    case "status":
      return await daemonStatus(paths, args, io);
    case "start":
      return await start(paths);
    case "stop":
      return await stop(paths, args, io);
    case "restart":
      return await restart(paths, args, io);
    case "logs":
      return await logs(paths, args, io);
    case "queue":
      return await daemonQueue(paths, args, io);
    case "submit":
      return await daemonSubmit(paths, args, io);
    default:
      throw new Error("Usage: spark daemon <status|start|stop|restart|logs|queue|submit>");
  }
}

async function restart(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const previousPid = readRunningPid(paths);
  const stopped = await stop(paths, args, io);
  if (stopped !== 0) return stopped;

  const stoppedOrReplaced = await waitForDaemonStoppedOrReplaced(paths, previousPid);
  const currentPid = readRunningPid(paths);
  if (currentPid && currentPid !== previousPid) {
    io.stdout.write(`Spark daemon restarted as process ${currentPid}.\n`);
    return 0;
  }
  if (!stoppedOrReplaced) {
    io.stderr.write(
      previousPid
        ? `Spark daemon process ${previousPid} did not stop before restart timeout.\n`
        : "Spark daemon did not stop before restart timeout.\n",
    );
    return 1;
  }
  const service = startSparkDaemonProcess(paths, io);
  io.stdout.write(`${service.detail}\n`);
  return 0;
}

async function waitForDaemonStoppedOrReplaced(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentPid = readRunningPid(paths);
    const previousStillAlive = previousPid !== null && isProcessAlive(previousPid);
    if (!previousStillAlive && (currentPid === null || currentPid !== previousPid)) return true;
    await delay(50);
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function daemonStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const status = await buildDaemonStatus(paths, io);
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  if (!status.running) {
    if ("unreachable" in status) {
      io.stdout.write(
        "unreachable\n" +
          `  pid              ${status.pid}\n` +
          `  socket           ${status.socketPath} (not reachable)\n` +
          `  state db         ${status.stateDbPath}\n` +
          `  started          ${status.startedAt}\n` +
          `  error            ${status.error}\n` +
          "  restart          spark daemon restart\n",
      );
      return 0;
    }
    io.stdout.write(
      "not running\n" +
        `  socket           ${status.socketPath} (absent)\n` +
        "  start            spark daemon start\n" +
        "                   or run any 'spark daemon workspace' command to lazy-spawn\n",
    );
    return 0;
  }

  const workspaceCount = status.servers.reduce((sum, server) => sum + server.workspaceCount, 0);
  io.stdout.write(
    "running\n" +
      `  pid              ${status.pid}\n` +
      `  socket           ${status.socketPath}\n` +
      `  state db         ${status.stateDbPath}\n` +
      `  started          ${status.startedAt}\n` +
      `  registered       ${workspaceCount} workspaces across ${status.servers.length} servers\n` +
      `  queue            ${status.queue.inbox} inbox · ${status.queue.processed} processed · ${status.queue.failed} failed\n`,
  );
  for (const server of status.servers) {
    io.stdout.write(
      `    ${server.url}    ${server.workspaceCount} workspaces · ${daemonServerConnectionLabel(server)}\n`,
    );
  }
  return 0;
}

async function daemonQueue(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const state = readDaemonQueueState(flags.state ?? "inbox");
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const result = await (io.daemonQueueFromService ?? requestDaemonQueue)(paths, { state, limit });
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (result.state === "all") {
    for (const queueState of ["inbox", "processed", "failed"] as const) {
      io.stdout.write(`${queueState}:\n`);
      for (const entry of result.byState?.[queueState] ?? []) {
        io.stdout.write(`  ${entry.fileName} ${entry.payload.task.type}\n`);
      }
    }
    return 0;
  }
  for (const entry of result.entries ?? []) {
    io.stdout.write(`${entry.fileName} ${entry.payload.task.type}\n`);
  }
  return 0;
}

async function daemonSubmit(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const sessionId = flags.session?.trim();
  const prompt = (flags.prompt ?? positionalArgs(args).join(" ")).trim();
  if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
  if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
  const result = await (io.turnSubmitToService ?? requestTurnSubmit)(paths, { sessionId, prompt });
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`queued ${result.fileName}\n`);
  return 0;
}

function readDaemonQueueState(value: string): "inbox" | "processed" | "failed" | "all" {
  if (value === "inbox" || value === "processed" || value === "failed" || value === "all") {
    return value;
  }
  throw new Error(`invalid daemon queue state: ${value}`);
}

function daemonServerConnectionLabel(server: {
  wsConnected: boolean;
  lastHeartbeatAt?: string;
  lastDisconnectReason?: string;
}): string {
  if (server.wsConnected) {
    return server.lastHeartbeatAt
      ? `WS connected · last heartbeat ${server.lastHeartbeatAt}`
      : "WS connected";
  }
  return server.lastDisconnectReason
    ? `WS disconnected · ${server.lastDisconnectReason}`
    : "WS disconnected";
}

type DaemonStatus =
  | { running: false; socketPath: string }
  | {
      running: false;
      unreachable: true;
      pid: number;
      socketPath: string;
      stateDbPath: string;
      startedAt: string;
      error: string;
    }
  | {
      running: true;
      pid: number;
      socketPath: string;
      stateDbPath: string;
      startedAt: string;
      servers: Array<{
        url: string;
        workspaceCount: number;
        wsConnected: boolean;
        lastHeartbeatAt?: string;
        lastDisconnectReason?: string;
      }>;
      queue: { inbox: number; processed: number; failed: number };
    };

async function buildDaemonStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): Promise<DaemonStatus> {
  const socketPath = localRpcSocketPath(paths);
  const pid = readRunningPid(paths);
  if (!pid) {
    return { running: false, socketPath };
  }

  try {
    const status = await (io.daemonStatusFromService ?? requestDaemonStatus)(paths);
    return {
      running: true,
      pid,
      socketPath,
      stateDbPath: paths.databasePath,
      startedAt: statSync(paths.pidFile).mtime.toISOString(),
      servers: status.servers,
      queue: status.queue,
    };
  } catch (error) {
    return {
      running: false,
      unreachable: true,
      pid,
      socketPath,
      stateDbPath: paths.databasePath,
      startedAt: statSync(paths.pidFile).mtime.toISOString(),
      error: errorMessage(error),
    };
  }
}

async function workspace(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printWorkspaceHelp(io);
    return 0;
  }
  if (helpRequested(args)) {
    printWorkspaceHelp(io);
    return 0;
  }

  prepareSparkDaemonState(paths);
  if (subcommand === undefined || subcommand === "ls" || subcommand === "list") {
    return await listWorkspaceCommand(paths, args, io);
  }

  if (subcommand.startsWith("-")) {
    return await listWorkspaceCommand(paths, [subcommand, ...args], io);
  }

  if (subcommand === "stop") {
    const code = await stopWorkspaceCommand(paths, args, io);
    if (code === 0 && !workspaceSkipPostStopSync(parseFlags(args))) {
      syncSparkDaemonIfConfigured(paths, io);
    }
    return code;
  }

  if (subcommand === "show") {
    return await showWorkspaceCommand(paths, args, io);
  }

  if (subcommand === "register") {
    return await registerWorkspaceCommand(paths, args, io);
  }

  throw new Error("Usage: spark daemon workspace <register|ls|show|stop>");
}

async function registerWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const explicitPathArg = flags.path ?? positionalArgs(args)[0];
  const scripted = isScriptedWorkspaceRegistration(flags);
  const interactive = !scripted && explicitPathArg === undefined;
  const pathArg = explicitPathArg ?? (scripted ? "." : await promptWorkspacePath(io));
  const localPath = resolveWorkspacePath(pathArg);
  assertDirectory(localPath);

  const config = readSparkDaemonConfig(paths);
  const serverUrl = await resolveRegistrationServerUrl(flags, config, io, { interactive });
  const registrationToken = await resolveRegistrationToken(flags, io, { interactive });
  if (!registrationToken) {
    throw new Error(
      "Missing workspace registration token. Pass --token <token>, --token -, or set SPARK_WORKSPACE_REGISTRATION_TOKEN.",
    );
  }
  const displayName =
    flags.name ?? (interactive ? await promptWorkspaceName(localPath, io) : undefined);
  const profile = await resolveWorkspaceProfile(localPath, flags, io, {
    allowDetectedPrompt: interactive,
  });

  const workspaceOptions: WorkspaceRegistrationRequest = {
    serverUrl,
    localPath,
    ...(registrationToken ? { registrationToken } : {}),
    ...(flags.key || flags["local-key"]
      ? { localWorkspaceKey: flags.key ?? flags["local-key"] }
      : {}),
    ...(displayName ? { displayName } : {}),
    ...(profile ? { profile } : {}),
  };
  const added = await registerWorkspaceForCli(paths, workspaceOptions, io);
  io.stdout.write(
    `✓ workspace '${added.displayName}' registered\n` +
      `  path     ${formatPathForDisplay(added.localPath)}\n` +
      `  server   ${added.serverUrl}\n` +
      profileTextLine(added.profile) +
      `  status   ${workspaceStatusLabel(added)}\n` +
      `  note     v0.1 has no removal command; this registration is permanent.\n`,
  );

  if (readRunningPid(paths) !== null) {
    io.stdout.write("Spark daemon is running.\n");
  }
  return 0;
}

async function defaultWorkspace(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const workspaces = await loadWorkspaceList(paths, io);
  if (workspaces.length === 0) {
    io.stdout.write(
      "no workspaces registered.\n  spark daemon workspace register . --server-url <url> --token <tok> --name <ws>\n",
    );
    return 0;
  }

  const explicitWorkspace = flags.workspace;
  const cwd = resolveInvocationCwd();
  const workspace = explicitWorkspace
    ? resolveWorkspace(workspaces, explicitWorkspace)
    : resolveWorkspaceForCwd(workspaces, cwd);
  if (!workspace) {
    io.stdout.write(
      `${cwd} is not under a registered workspace.\n` +
        "  spark daemon workspace register . --server-url <url> --token <tok> --name <ws>\n" +
        "or cd into a registered workspace, or pass --workspace <name>.\n",
    );
    return 2;
  }

  assertDirectory(workspace.localPath);
  const config = readSparkDaemonConfig(paths);
  if (!hasRunnableSparkDaemonCredentialsForServer(config, workspace.serverUrl)) {
    throw new Error(
      `Workspace '${workspace.displayName}' is registered locally, but service credentials are missing. Run spark daemon workspace register ${shellQuote(workspace.localPath)} --server-url <url> --token <tok>.`,
    );
  }

  const wasDetached = isUserDetachedWorkspace(workspace);
  const ready = wasDetached ? await attachWorkspaceForCli(paths, workspace.id, io) : workspace;
  io.stdout.write(
    `${wasDetached ? "✓ re-attached" : "✓ workspace"} '${ready.displayName}' ready\n` +
      `  path     ${formatPathForDisplay(ready.localPath)}\n` +
      `  status   ${workspaceStatusLabel(ready)}\n`,
  );

  io.stdout.write("Spark daemon is running.\n");
  await startWorkspaceShell(paths, ready, io);
  return 0;
}

async function listWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const workspaces = await loadWorkspaceList(paths, io);
  const statusContext = workspaceStatusContext(paths);
  if (flags.json === "true") {
    io.stdout.write(
      `${JSON.stringify(
        workspaces.map((workspace) => workspaceListItem(workspace, statusContext)),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (workspaces.length === 0) {
    io.stdout.write(
      "no workspaces registered.\n  spark daemon workspace register . --server-url <url> --token <tok> --name <ws>\n",
    );
    return 0;
  }

  io.stdout.write(
    "NAME                 SERVER                         STATUS                   PATH                                  PROJECTS  INBOX  LAST SESSION\n",
  );
  for (const workspace of workspaces) {
    const listItem = workspaceListItem(workspace, statusContext);
    io.stdout.write(
      `${pad(truncate(workspace.displayName, 20), 20)} ` +
        `${pad(formatServerForList(workspace.serverUrl, flags.full === "true"), 30)} ` +
        `${pad(workspaceStatusLabel(workspace, statusContext), 24)} ` +
        `${pad(formatPathForList(workspace.localPath, flags.full === "true"), 38)} ` +
        `${pad(countColumn(listItem.counts.projects), 8)} ` +
        `${pad(countColumn(listItem.counts.unresolvedInbox), 5)} ` +
        `${lastSessionColumn(listItem.lastSessionAt)}\n`,
    );
  }
  return 0;
}

type WorkspaceRegistrationRequest = RegisterWorkspaceOptions & {
  registrationToken?: string;
};

async function requestWorkspaceService<T>(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  request: () => Promise<T>,
): Promise<T> {
  let startedService = false;
  if (readRunningPid(paths) === null) {
    try {
      startSparkDaemonProcess(paths, io);
      startedService = true;
    } catch (error) {
      throw new SparkDaemonUnavailableError(error, { running: false });
    }
  }

  let attempts = startedService ? 20 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (isWorkspaceDomainError(error)) {
        throw error;
      }
      lastError = error;
      if (!startedService && isMissingLocalRpcSocketError(paths, error)) {
        try {
          startSparkDaemonProcess(paths, io);
          startedService = true;
          attempts = 20;
        } catch (startError) {
          throw new SparkDaemonUnavailableError(startError, { running: false });
        }
      }
      if (attempt < attempts - 1) {
        await delay(100);
      }
    }
  }

  throw new SparkDaemonUnavailableError(lastError ?? "Spark daemon request failed");
}

function workspaceSkipPostStopSync(flags: Record<string, string>): boolean {
  return flags["no-service"] === "true" || flags["no-start"] === "true";
}

function isWorkspaceDomainError(error: unknown): boolean {
  return (
    error instanceof WorkspacePathConflictError || error instanceof RegistrationGrantRefusedError
  );
}

function isMissingLocalRpcSocketError(
  paths: ReturnType<typeof resolveSparkPaths>,
  error: unknown,
): boolean {
  const message = errorMessage(error);
  return message.includes("ENOENT") && message.includes(localRpcSocketPath(paths));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadWorkspaceList(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): Promise<SparkDaemonWorkspace[]> {
  return await requestWorkspaceService(paths, io, async () => {
    return (await (io.listWorkspacesFromService ?? requestWorkspaceList)(paths)).workspaces;
  });
}

async function registerWorkspaceForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  options: WorkspaceRegistrationRequest,
  io: CliIo,
): Promise<SparkDaemonWorkspace> {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.registerWorkspaceInService ?? requestWorkspaceRegister)(paths, options);
  });
}

async function attachWorkspaceForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  id: string,
  io: CliIo,
): Promise<SparkDaemonWorkspace> {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.attachWorkspaceInService ?? requestWorkspaceAttach)(paths, id);
  });
}

async function stopWorkspaceForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  id: string,
  io: CliIo,
): Promise<SparkDaemonWorkspace> {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.stopWorkspaceInService ?? requestWorkspaceStop)(paths, id);
  });
}

async function showWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const identifier = flags.workspace ?? positionalArgs(args)[0];
  const workspaces = await loadWorkspaceList(paths, io);
  let workspace = resolveWorkspaceForShow(workspaces, identifier);
  if (isUserDetachedWorkspace(workspace)) {
    workspace = await attachWorkspaceForCli(paths, workspace.id, io);
  }
  const statusContext = workspaceStatusContext(paths);

  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(workspaceDetail(workspace, statusContext), null, 2)}\n`);
    return 0;
  }

  io.stdout.write(workspaceDetailText(workspace, statusContext));
  return 0;
}

async function startWorkspaceShell(
  paths: ReturnType<typeof resolveSparkPaths>,
  workspace: SparkDaemonWorkspace,
  io: CliIo,
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return;
  }

  let current = workspace;
  io.stdout.write(
    `\nSpark workspace ${current.displayName}\n` + "  commands show, status, stop, help, quit\n",
  );
  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await prompt.question(`spark daemon:${current.localWorkspaceKey}> `))
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "status") {
        io.stdout.write(
          `status   ${workspaceStatusLabel(current, workspaceStatusContext(paths))}\n`,
        );
        continue;
      }
      if (answer === "q" || answer === "quit" || answer === "exit") {
        return;
      }
      if (answer === "help" || answer === "?") {
        io.stdout.write("commands show, status, stop, help, quit\n");
        continue;
      }
      if (answer === "show") {
        io.stdout.write(workspaceDetailText(current, workspaceStatusContext(paths)));
        continue;
      }
      if (answer === "stop") {
        current = await stopWorkspaceForCli(paths, current.id, io);
        io.stdout.write(
          `✓ paused '${current.displayName}'\n` +
            `  status   ${workspaceStatusLabel(current, workspaceStatusContext(paths))}\n`,
        );
        continue;
      }
      io.stdout.write("unknown command. type help.\n");
    }
  } finally {
    prompt.close();
  }
}

function workspaceDetailText(
  workspace: SparkDaemonWorkspace,
  statusContext: WorkspaceStatusContext,
) {
  return (
    `${workspace.displayName}\n` +
    `  status         ${workspaceStatusLabel(workspace, statusContext)}\n` +
    `  server         ${workspace.serverUrl}\n` +
    `  path           ${formatPathForDisplay(workspace.localPath)}\n` +
    profileTextLine(workspace.profile, "  profile        ") +
    `  connection     ${workspace.id}\n` +
    offlineTextBlock(workspace, statusContext) +
    degradedTextBlock(workspace, statusContext) +
    recentSessionsTextBlock(workspace)
  );
}

function recentSessionsTextBlock(workspace: SparkDaemonWorkspace): string {
  const sessions = workspace.recentSessions ?? [];
  if (sessions.length === 0) {
    return "";
  }

  return (
    `\nrecent sessions (${sessions.length})\n` +
    sessions
      .map(
        (session) =>
          `  ${session.id}   ${session.project}   ${session.model}   ${relativeTime(session.lastActivityAt)}   ${session.state}\n`,
      )
      .join("")
  );
}

function resolveWorkspaceForShow(
  workspaces: SparkDaemonWorkspace[],
  identifier: string | undefined,
): SparkDaemonWorkspace {
  if (identifier) {
    return resolveWorkspace(workspaces, identifier);
  }

  if (workspaces.length === 0) {
    throw new Error(
      "No workspace found. Run spark daemon workspace register . --server-url <url> --token <tok>.",
    );
  }

  const cwd = resolveInvocationCwd();
  const workspace = resolveWorkspaceForCwd(workspaces, cwd);
  if (!workspace) {
    throw new Error(`${cwd} is not under a registered workspace. Pass a workspace name.`);
  }
  return workspace;
}

async function stopWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const identifier = flags.workspace ?? positionalArgs(args)[0];
  if (!identifier) {
    throw new Error("Pass a workspace name or --workspace <name>.");
  }
  const workspace = resolveWorkspace(await loadWorkspaceList(paths, io), identifier);
  if (!(await confirmAction(io, flags, `Pause workspace '${workspace.displayName}'?`))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const stopped = await stopWorkspaceForCli(paths, workspace.id, io);
  io.stdout.write(
    `✓ paused '${stopped.displayName}'\n` +
      `  server   ${stopped.serverUrl}\n` +
      `  path     ${formatPathForDisplay(stopped.localPath)}\n` +
      `  status   ${workspaceStatusLabel(stopped)}\n` +
      `  note     cd into ${formatPathForDisplay(stopped.localPath)} and run spark daemon to re-attach it.\n`,
  );
  return 0;
}

function resolveWorkspace(
  workspaces: SparkDaemonWorkspace[],
  identifier: string | undefined,
): SparkDaemonWorkspace {
  if (!identifier) {
    if (workspaces.length === 1) {
      return workspaces[0]!;
    }
    if (workspaces.length === 0) {
      throw new Error(
        "No workspace found. Run spark daemon workspace register . --server-url <url> --token <tok>.",
      );
    }
    throw new Error("Multiple workspaces are registered. Pass a workspace name.");
  }

  const parsed = parseWorkspaceIdentifier(identifier);
  let matches = workspaces.filter((workspace) => workspaceMatchesRef(workspace, parsed.name));
  if (parsed.serverRef !== undefined) {
    const matchingServers = new Set(
      workspaces
        .filter((workspace) => serverMatchesRef(workspace.serverUrl, parsed.serverRef!))
        .map((workspace) => workspace.serverUrl),
    );
    if (matchingServers.size > 1) {
      throw new Error(`Ambiguous workspace server: ${parsed.serverRef}`);
    }
    matches = matches.filter((workspace) =>
      serverMatchesRef(workspace.serverUrl, parsed.serverRef!),
    );
  }
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous workspace name: ${identifier}. Use ${matches.map(workspaceIdentifier).join(", ")}.`,
    );
  }
  throw new Error(`Unknown workspace: ${identifier}`);
}

interface WorkspaceStatusContext {
  daemonRunning: boolean;
}

function workspaceStatusContext(
  paths: ReturnType<typeof resolveSparkPaths>,
): WorkspaceStatusContext {
  return { daemonRunning: readRunningPid(paths) !== null };
}

function workspaceListItem(workspace: SparkDaemonWorkspace, context: WorkspaceStatusContext) {
  const renderedStatus = workspaceStatusJson(workspace, context);
  const offlineReason = workspaceOfflineReasonJson(workspace, context);
  const degradedReasons = workspaceDegradedReasons(workspace, context);
  return {
    slug: workspace.localWorkspaceKey,
    name: workspace.displayName,
    serverUrl: workspace.serverUrl,
    path: workspace.localPath,
    status: renderedStatus,
    ...(offlineReason ? { offlineReason } : {}),
    ...(degradedReasons.length > 0 ? { degradedReasons } : {}),
    ...(workspace.profile ? { profile: workspace.profile } : {}),
    counts: {
      projects: null,
      unresolvedInbox: null,
      sessions: workspace.sessionCount ?? null,
    },
    ...(workspace.lastSessionAt ? { lastSessionAt: workspace.lastSessionAt } : {}),
    lastStatusChangedAt: workspace.updatedAt,
  };
}

function workspaceDetail(workspace: SparkDaemonWorkspace, context: WorkspaceStatusContext) {
  return {
    ...workspaceListItem(workspace, context),
    connection: {
      ref: workspace.id,
      capabilities: bindingCapabilities(workspace),
    },
    projects: [],
    inbox: [],
    recentSessions: workspace.recentSessions ?? [],
  };
}

function bindingCapabilities(workspace: SparkDaemonWorkspace): Array<{
  id: string;
  status: "online" | "offline";
  lastCheckedAt: string;
  message?: string;
}> {
  return Object.entries(workspace.capabilities).map(([id, value]) => {
    const capability = {
      id,
      status: capabilityStatus(value),
      lastCheckedAt: capabilityLastCheckedAt(value, workspace.updatedAt),
    };
    const message = capabilityMessage(value);
    return message ? { ...capability, message } : capability;
  });
}

function capabilityStatus(value: unknown): "online" | "offline" {
  if (value === "unavailable" || value === "offline") {
    return "offline";
  }
  if (isRecord(value) && (value.status === "unavailable" || value.status === "offline")) {
    return "offline";
  }
  return "online";
}

function capabilityLastCheckedAt(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.lastCheckedAt === "string"
    ? value.lastCheckedAt
    : fallback;
}

function capabilityMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function workspaceStatusLabel(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): string {
  if (isUserDetached(workspace)) {
    return "offline · detached";
  }

  if (!context.daemonRunning) {
    return "offline · service stopped";
  }

  switch (workspace.status) {
    case "available":
      return "online";
    case "indexing":
      return "starting";
    case "degraded":
      return "degraded";
    default:
      return "offline · disconnected";
  }
}

function workspaceStatusJson(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): string {
  if (isUserDetached(workspace)) {
    return "offline:detached";
  }

  if (!context.daemonRunning) {
    return "offline:service-stopped";
  }

  switch (workspace.status) {
    case "available":
      return "online";
    case "indexing":
      return "starting";
    case "degraded":
      return "degraded";
    default:
      return "offline:disconnected";
  }
}

function workspaceOfflineReasonJson(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): "detached" | "disconnected" | "service-stopped" | undefined {
  if (isUserDetached(workspace)) {
    return "detached";
  }

  if (!context.daemonRunning) {
    return "service-stopped";
  }

  if (
    workspace.status === "available" ||
    workspace.status === "indexing" ||
    workspace.status === "degraded"
  ) {
    return undefined;
  }
  return "disconnected";
}

function workspaceDegradedReasons(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): DegradedReasonCode[] {
  if (!context.daemonRunning || workspace.status !== "degraded") {
    return [];
  }

  const values = [
    ...arrayStrings(workspace.diagnostics?.degradedReasons),
    ...arrayStrings(workspace.diagnostics?.reasons),
    ...singleString(workspace.diagnostics?.degradedReason),
    ...singleString(workspace.diagnostics?.reason),
  ];

  return [...new Set(values.filter(isDegradedReasonCode))];
}

function degradedTextBlock(
  workspace: SparkDaemonWorkspace,
  context: WorkspaceStatusContext,
): string {
  const reasons = workspaceDegradedReasons(workspace, context);
  if (reasons.length === 0) {
    return "";
  }

  const whyLines = reasons
    .map((reason, index) => {
      const prefix = index === 0 ? "  why            " : "                 ";
      return `${prefix}${degradedReasonText[reason].why} (${reason})\n`;
    })
    .join("");
  const remediationLines = reasons
    .map((reason, index) => {
      const prefix = index === 0 ? "  remediation    " : "                 ";
      return `${prefix}${remediationFor(reason, workspace)}\n`;
    })
    .join("");
  return whyLines + remediationLines;
}

function offlineTextBlock(
  workspace: SparkDaemonWorkspace,
  context: WorkspaceStatusContext,
): string {
  const reason = workspaceOfflineReasonJson(workspace, context);
  if (!reason) {
    return "";
  }

  const text = offlineReasonText[reason];
  return (
    `  offline reason ${reason}\n` +
    `  why            ${text.why}\n` +
    `  remediation    ${text.fix}\n`
  );
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function singleString(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

function isUserDetached(workspace: {
  status: string;
  diagnostics?: Record<string, unknown>;
}): boolean {
  return workspace.status === "unavailable" && workspace.diagnostics?.userDetached === true;
}

const offlineReasonText = {
  detached: {
    why: "workspace was paused by the user",
    fix: "run spark daemon from the workspace directory to re-attach it",
  },
  disconnected: {
    why: "Spark daemon is running but the server connection is unavailable",
    fix: "check server reachability and workspace registration token validity",
  },
  "service-stopped": {
    why: "Spark daemon is not running",
    fix: "run spark daemon start or retry the workspace command",
  },
};

const degradedReasonText = {
  "filesystem.unreachable": {
    why: "workspace path not reachable",
    fix: "reconnect the volume",
  },
  "filesystem.permission": {
    why: "workspace path permission check failed",
    fix: "check directory permissions",
  },
  "git.corrupt": {
    why: "git worktree is corrupt or missing HEAD",
    fix: "repair the git worktree",
  },
  "profile.invalid": {
    why: "imported profile is invalid",
    fix: "fix the workspace profile files",
  },
  "profile.missing-agents": {
    why: "imported profile references missing agents",
    fix: "restore the referenced agent definitions",
  },
  "runtime.subprocess-unhealthy": {
    why: "Spark runtime bridge subprocess is unhealthy",
    fix: "restart the Spark daemon",
  },
  "lease.stale": {
    why: "stale workspace lease found",
    fix: "retry after the Spark daemon cleans stale leases",
  },
  "storage.full": {
    why: "local storage is full",
    fix: "free space in the Spark daemon data/cache/state directories",
  },
  "storage.io-error": {
    why: "local storage I/O failed",
    fix: "check the Spark daemon data/cache/state directories",
  },
} as const;

type DegradedReasonCode = keyof typeof degradedReasonText;

function isDegradedReasonCode(value: string): value is DegradedReasonCode {
  return value in degradedReasonText;
}

function remediationFor(reason: DegradedReasonCode, workspace: SparkDaemonWorkspace): string {
  if (reason === "filesystem.unreachable") {
    return `${degradedReasonText[reason].fix}, or run 'spark daemon workspace stop ${shellQuote(workspace.localWorkspaceKey)}'`;
  }
  return degradedReasonText[reason].fix;
}

function resolveWorkspaceForCwd(
  workspaces: SparkDaemonWorkspace[],
  cwd: string,
): SparkDaemonWorkspace | null {
  const current = resolve(cwd);
  const matches = workspaces
    .filter((workspace) => pathContains(workspace.localPath, current))
    .sort((left, right) => right.localPath.length - left.localPath.length);
  const bestLength = matches[0]?.localPath.length;
  const bestMatches =
    bestLength === undefined
      ? []
      : matches.filter((workspace) => workspace.localPath.length === bestLength);
  if (bestMatches.length > 1) {
    throw new Error(
      `Multiple workspaces match ${current}. Use ${bestMatches.map(workspaceIdentifier).join(", ")}.`,
    );
  }
  return matches[0] ?? null;
}

function parseWorkspaceIdentifier(identifier: string): { name: string; serverRef?: string } {
  const separator = identifier.lastIndexOf("@");
  if (separator <= 0) {
    return { name: identifier };
  }

  const serverRef = identifier.slice(separator + 1);
  if (!serverRef) {
    return { name: identifier };
  }

  return { name: identifier.slice(0, separator), serverRef };
}

function workspaceMatchesRef(workspace: SparkDaemonWorkspace, name: string): boolean {
  return (
    workspace.displayName === name || workspace.localWorkspaceKey === name || workspace.id === name
  );
}

function serverMatchesRef(serverUrl: string, serverRef: string): boolean {
  return serverUrl === serverRef || serverUrl.startsWith(serverRef);
}

function workspaceIdentifier(workspace: SparkDaemonWorkspace): string {
  return `${workspace.displayName}@${workspace.serverUrl || "local"}`;
}

function pathContains(parentPath: string, childPath: string): boolean {
  const fromParent = relative(normalizeLocalPath(parentPath), normalizeLocalPath(childPath));
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function normalizeLocalPath(localPath: string): string {
  const absolutePath = resolve(localPath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function startSparkDaemonProcess(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): ReturnType<typeof startSparkDaemonService> {
  return (io.startService ?? startSparkDaemonService)(paths);
}

function syncSparkDaemonIfConfigured(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo): void {
  const config = readSparkDaemonConfig(paths);
  if (!config.serverUrl || !hasRunnableSparkDaemonCredentialsForServer(config, config.serverUrl)) {
    io.stdout.write(
      "  sync     local only; run spark daemon workspace register with a registration token to sync with Spark Cockpit.\n",
    );
    return;
  }

  if (readRunningPid(paths) !== null) {
    io.stdout.write("  sync     Spark daemon is running.\n");
    return;
  }

  const service = startSparkDaemonProcess(paths, io);
  io.stdout.write(`  sync     ${service.detail}\n`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function formatServerForList(serverUrl: string, full: boolean): string {
  return full ? serverUrl : truncate(serverUrl, 30);
}

function formatPathForList(localPath: string, full: boolean): string {
  if (full) {
    return localPath;
  }

  return truncate(abbreviateHome(localPath), 38);
}

function formatPathForDisplay(localPath: string): string {
  return abbreviateHome(localPath);
}

function abbreviateHome(localPath: string): string {
  const home = process.env.HOME;
  if (!home) {
    return localPath;
  }

  const normalizedHome = realpathOrResolved(home);
  if (localPath === normalizedHome) {
    return "~";
  }
  return localPath.startsWith(`${normalizedHome}/`)
    ? `~/${localPath.slice(normalizedHome.length + 1)}`
    : localPath;
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function countColumn(value: number | null): string {
  return value === null ? "—" : String(value);
}

function lastSessionColumn(value: string | undefined): string {
  return value ? relativeTime(value) : "—";
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours} h ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} d ago`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon <command>

Commands:
  spark daemon
  spark daemon --workspace <name>
  workspace register [path] --server-url <url> --token <workspace-registration-token|-> --name <name> [--profile <path-or-git-url>]
  workspace ls [--json] [--all] [--full]
  workspace show [name] [--workspace <name>] [--json]
  workspace stop <name> [--workspace <name>] [--yes]
  ws
  status
  start
  stop
  restart
  logs

Example:
  spark daemon workspace register . --server-url http://127.0.0.1:5173 --token <tok> --name <ws>
`);
}

function printWorkspaceHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon workspace <command>

Commands:
  register [path] --server-url <url> --token <workspace-registration-token|-> --name <name> [--profile <path-or-git-url>]
  ls [--json] [--all] [--full]
  show [name] [--workspace <name>] [--json]
  stop <name> [--workspace <name>] [--yes]

Example:
  spark daemon workspace ls --json
`);
}

function printDaemonHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon <command>

Commands:
  status [--json]
  start
  stop
  restart
  logs [--follow] [--lines <n>]
  queue [--state inbox|processed|failed|all] [--limit <n>] [--json]
  submit --session <id> --prompt <text> [--json]

Example:
  spark daemon status --json
`);
}

async function resolveRegistrationServerUrl(
  flags: Record<string, string>,
  current: ReturnType<typeof readSparkDaemonConfig>,
  io: CliIo,
  options: { interactive?: boolean } = {},
): Promise<string> {
  const serverUrl = flags["server-url"] ?? flags.server;
  if (serverUrl) {
    return validateRegistrationServerUrl(serverUrl);
  }

  const configured = configuredServerUrl(current);
  if (options.interactive) {
    return validateRegistrationServerUrl(await promptWithDefault(io, "server URL", configured));
  }

  if (configured) {
    return configured;
  }

  throw new Error("Missing server URL. Pass --server-url <url> with the registration command.");
}

function registrationToken(flags: Record<string, string>): string | undefined {
  return flags.token ?? process.env.SPARK_WORKSPACE_REGISTRATION_TOKEN;
}

function isScriptedWorkspaceRegistration(flags: Record<string, string>): boolean {
  return Boolean(
    flags.path ||
    flags["server-url"] ||
    flags.server ||
    flags.key ||
    flags["local-key"] ||
    flags.name ||
    flags.profile ||
    flags.token,
  );
}

async function resolveRegistrationToken(
  flags: Record<string, string>,
  io: CliIo,
  options: { interactive?: boolean } = {},
): Promise<string | undefined> {
  const token = registrationToken(flags);
  if (token !== "-") {
    return (
      token ??
      (options.interactive ? await promptSecret(io, "workspace registration token") : undefined)
    );
  }

  return readStdinLine(io, "workspace registration token");
}

async function logs(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const lineCount = parseLineCount(flags.lines ?? flags.n);
  writeLogTail(paths.logFile, lineCount, io);
  if (flags.follow !== "true" && flags.f !== "true") {
    return 0;
  }

  await followLogFile(paths.logFile, io);
  return 0;
}

function parseLineCount(value: string | undefined): number {
  if (value === undefined) {
    return 100;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid --lines value. Pass a non-negative integer.");
  }
  return parsed;
}

function writeLogTail(logFile: string, lineCount: number, io: CliIo): void {
  if (!existsSync(logFile)) {
    io.stdout.write(`no logs yet: ${logFile}\n`);
    return;
  }

  const content = readFileSync(logFile, "utf8");
  if (!content) {
    return;
  }

  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const selected = lineCount === 0 ? [] : lines.slice(-lineCount);
  if (selected.length > 0) {
    io.stdout.write(`${selected.join("\n")}\n`);
  }
}

async function followLogFile(logFile: string, io: CliIo): Promise<void> {
  let offset = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
  await new Promise<void>((resolvePromise) => {
    const listener = () => {
      if (!existsSync(logFile)) {
        return;
      }

      const content = readFileSync(logFile, "utf8");
      if (content.length < offset) {
        offset = 0;
      }
      if (content.length > offset) {
        io.stdout.write(content.slice(offset));
        offset = content.length;
      }
    };
    watchFile(logFile, { interval: 500 }, listener);
    process.once("SIGINT", () => {
      unwatchFile(logFile, listener);
      resolvePromise();
    });
  });
}

async function resolveWorkspaceProfile(
  localPath: string,
  flags: Record<string, string>,
  io: CliIo,
  options: { allowDetectedPrompt: boolean },
): Promise<WorkspaceProfileRegistration | undefined> {
  const profileRef = flags.profile;
  if (profileRef !== undefined) {
    if (profileRef === "true" || !profileRef.trim()) {
      throw new Error("Missing workspace profile. Pass --profile <path-or-git-url>.");
    }

    return profileRegistrationFromRef(localPath, profileRef);
  }

  if (!options.allowDetectedPrompt) {
    return undefined;
  }

  const detected = detectWorkspaceProfile(localPath);
  if (!detected || !(await confirmDetectedProfileImport(io, detected.promptLabel))) {
    return undefined;
  }

  return profileRegistrationFromRef(localPath, detected.ref);
}

function profileRegistrationFromRef(
  localPath: string,
  profileRef: string,
): WorkspaceProfileRegistration {
  const localProfilePath = resolveLocalProfilePath(localPath, profileRef);
  return {
    sourceKind: "git",
    ref: profileRef,
    ...gitCommitForProfile(localProfilePath),
    importedAt: new Date().toISOString(),
  };
}

function detectWorkspaceProfile(localPath: string): { ref: string; promptLabel: string } | null {
  const directoryProfileSettings = resolve(localPath, "spark-profile", "settings.toml");
  if (existsSync(directoryProfileSettings)) {
    return { ref: "./spark-profile", promptLabel: "./spark-profile" };
  }

  const inlineProfile = resolve(localPath, ".spark", "profile.toml");
  if (existsSync(inlineProfile)) {
    return { ref: "./.spark/profile.toml", promptLabel: "./.spark/profile.toml" };
  }

  return null;
}

async function confirmDetectedProfileImport(io: CliIo, profileLabel: string): Promise<boolean> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return false;
  }

  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Use profile from ${profileLabel}? [Y/n]: `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    prompt.close();
  }
}

function resolveLocalProfilePath(localPath: string, profileRef: string): string | null {
  if (isUrlLike(profileRef)) {
    return null;
  }

  const resolvedPath = resolve(localPath, profileRef);
  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch {
    throw new Error(`Workspace profile was not found: ${resolvedPath}`);
  }

  if (stat.isDirectory()) {
    const settingsPath = resolve(resolvedPath, "settings.toml");
    if (!existsSync(settingsPath)) {
      throw new Error(`Workspace profile settings.toml was not found: ${settingsPath}`);
    }
    return resolvedPath;
  }

  if (stat.isFile()) {
    return dirname(resolvedPath);
  }

  throw new Error(`Workspace profile is not a file or directory: ${resolvedPath}`);
}

function gitCommitForProfile(profilePath: string | null): { commit?: string } {
  if (!profilePath) {
    return {};
  }

  const result = spawnSync(gitCommand(), ["-C", profilePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(commit) ? { commit } : {};
}

function isUrlLike(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "git:"
    );
  } catch {
    return false;
  }
}

function profileTextLine(
  profile: WorkspaceProfileRegistration | undefined,
  prefix = "  profile  ",
): string {
  if (!profile) {
    return "";
  }
  return `${prefix}${profile.ref}${profile.commit ? ` @ ${profile.commit.slice(0, 7)}` : ""}\n`;
}

function resolveWorkspacePath(pathArg: string): string {
  return resolve(resolveInvocationCwd(), pathArg);
}

function resolveInvocationCwd(): string {
  return process.env.SPARK_DAEMON_CWD ?? process.env.INIT_CWD ?? process.cwd();
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

function helpRequested(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }
    values.push(arg);
  }
  return values;
}

async function promptWorkspacePath(io: CliIo): Promise<string> {
  return promptWithDefault(io, "path", ".");
}

async function promptWorkspaceName(localPath: string, io: CliIo): Promise<string> {
  return promptWithDefault(io, "workspace name", workspaceNameForPath(localPath));
}

async function promptWithDefault(
  io: CliIo,
  label: string,
  defaultValue: string | undefined,
): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    throw new Error(`Missing ${label}.`);
  }

  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await prompt.question(`${label}${suffix}: `);
    const value = answer.trim() || defaultValue;
    if (!value) {
      throw new Error(`${capitalize(label)} is required.`);
    }
    return value;
  } finally {
    prompt.close();
  }
}

async function promptRequired(io: CliIo, label: string): Promise<string> {
  return promptWithDefault(io, label, undefined);
}

async function promptSecret(io: CliIo, label: string): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    throw new Error(`Missing ${label}.`);
  }

  const setRawMode = (stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void })
    .setRawMode;
  if (typeof setRawMode !== "function") {
    return promptRequired(io, label);
  }

  process.stdout.write(`${label}: `);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      setRawMode.call(stdin, false);
      process.stdout.write("\n");
    };
    const finish = () => {
      cleanup();
      if (!value.trim()) {
        reject(new Error(`${capitalize(label)} is required.`));
        return;
      }
      resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error(`${capitalize(label)} entry cancelled.`));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += char;
        process.stdout.write("*");
      }
    };

    setRawMode.call(stdin, true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

async function readStdinLine(io: CliIo, name: string): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  const prompt = createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    const { value: line, done } = await prompt[Symbol.asyncIterator]().next();
    if (done) {
      throw new Error(`Missing ${name} on stdin.`);
    }
    const value = line.trim();
    if (!value) {
      throw new Error(`Empty ${name} from stdin.`);
    }
    return value;
  } finally {
    prompt.close();
  }
}

async function confirmAction(
  io: CliIo,
  flags: Record<string, string>,
  question: string,
): Promise<boolean> {
  if (flags.yes === "true" || flags.y === "true") {
    return true;
  }

  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    io.stderr.write(`${question} Pass --yes to confirm in non-interactive environments.\n`);
    return false;
  }

  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} Type 'yes' to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

function assertDirectory(localPath: string): void {
  let stat;
  try {
    stat = statSync(localPath);
  } catch {
    throw new WorkspacePathValidationError(`Workspace directory does not exist: ${localPath}`);
  }

  if (!stat.isDirectory()) {
    throw new WorkspacePathValidationError(`Workspace path is not a directory: ${localPath}`);
  }

  try {
    accessSync(localPath, constants.R_OK);
  } catch {
    throw new WorkspacePathValidationError(`Workspace directory is not readable: ${localPath}`);
  }
}

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
