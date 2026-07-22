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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gitCommand, resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  defaultSparkDaemonConfig,
  readSparkDaemonConfig,
  writeSparkDaemonConfig,
} from "./config.js";
import { sparkDaemonVersion } from "./daemon.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  sparkDaemonConfigForServerProfile,
  type SparkDaemonServerProfile,
} from "./server-profiles.js";

import {
  LocalRpcUnavailableError,
  localRpcSocketPath,
  requestWorkspaceAttach,
  requestWorkspaceList,
  requestWorkspaceRegister,
  requestWorkspaceRelocate,
  requestUplinkPark,
  requestUplinkUnpark,
  requestUplinkPrefer,
  requestUplinkStatus,
  requestWorkspaceStop,
} from "./local-rpc.js";
import {
  completeSparkDaemonDeviceAuthorization,
  configuredServerUrl,
  DeviceAuthorizationError,
  hasRunnableSparkDaemonCredentialsForServer,
  RegistrationGrantRefusedError,
  startSparkDaemonDeviceAuthorization,
  validateRegistrationServerUrl,
} from "./registration.js";

import {
  isUserDetachedWorkspace,
  type RegisterWorkspaceOptions,
  type SparkDaemonWorkspace,
  type WorkspaceProfileRegistration,
  workspaceNameForPath,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import { readRunningPid } from "./service.js";
import {
  type CliIo,
  defaultIo,
  STRINGS,
  SparkDaemonUnavailableError,
  WorkspacePathValidationError,
  prepareSparkDaemonState,
  parseFlags,
  helpRequested,
  positionalArgs,
  confirmAction,
  printHelp,
  printWorkspaceHelp,
  printLoginHelp,
  printUplinkHelp,
  startSparkDaemonProcess,
  syncSparkDaemonIfConfigured,
  errorMessage,
  readStdinLine,
  promptSecret,
  promptWithDefault,
  resolveInvocationCwd,
} from "./cli-shared.ts";
import {
  bindCliDaemonLogs,
  buildDaemonStatus,
  daemon,
  daemonSubmit,
  type DaemonStatus,
  restart,
  restartSuccessor,
  start,
  stop,
} from "./cli-daemon-lifecycle.ts";

export type { CliIo } from "./cli-shared.ts";
export { sparkDaemonServiceExitCode } from "./cli-daemon-lifecycle.ts";

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
        return await logs(paths, args.slice(1), io);
      case "login":
        return await login(paths, args.slice(1), io);
      case "start": {
        const managed = process.env.XPC_SERVICE_NAME === "dev.spark.daemon";
        return await start(paths, {
          // Plists created by older Spark versions invoked `start` directly.
          // launchd exposes the label here, so legacy managed activation must
          // still honor a durable Cancelled tombstone instead of clearing it.
          explicit: !managed,
          managed,
        });
      }
      case "__service-start":
        // This entrypoint is shared by launchd and detached starts. Only the
        // former has a supervisor that can replace a planned restart exit.
        return await start(paths, {
          explicit: false,
          managed: process.env.XPC_SERVICE_NAME === "dev.spark.daemon",
          expectedRestartId: process.env.SPARK_DAEMON_EXPECTED_RESTART_ID?.trim() || undefined,
        });
      case "stop":
        return await stop(paths, args.slice(1), io);
      case "restart":
        return await restart(paths, args.slice(1), io);
      case "__restart-successor":
        return await restartSuccessor(paths, args.slice(1), io);
      case "submit":
        return await daemonSubmit(paths, args.slice(1), io);
      case "workspace":
      case "ws":
        return await workspace(paths, subcommand, rest, io);
      case "uplink":
        return await uplink(paths, subcommand, rest, io);
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
      error instanceof RegistrationGrantRefusedError ||
      error instanceof DeviceAuthorizationError
    ) {
      return 3;
    }
    if (error instanceof SparkDaemonUnavailableError || error instanceof LocalRpcUnavailableError) {
      return 2;
    }
    return 1;
  }
}

async function login(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (helpRequested(args)) {
    printLoginHelp(io);
    return 0;
  }
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const current = readSparkDaemonConfig(paths);
  const profiles = listSparkDaemonServerProfiles(paths);
  const registrationDefault =
    profiles.length === 1 ? sparkDaemonConfigForServerProfile(current, profiles[0]!) : current;
  const serverUrl = await resolveRegistrationServerUrl(flags, registrationDefault, io);
  const deviceIdentity = {
    serverUrl,
    installationId: current.installationId,
    displayName: current.displayName,
    ...(flags["allow-insecure-http"] === "true" ? { allowInsecureHttp: true } : {}),
  };
  const authorization = await startSparkDaemonDeviceAuthorization(paths, deviceIdentity);

  io.stdout.write(
    `${STRINGS.deviceAuthorizationVerification(authorization.verificationUri, authorization.userCode)}\n`,
  );
  if (flags["no-open"] !== "true") {
    const opened = (io.openExternal ?? openExternalUrl)(authorization.verificationUriComplete);
    if (!opened) {
      io.stdout.write(
        `${STRINGS.deviceAuthorizationOpenFailed(authorization.verificationUriComplete)}\n`,
      );
    }
  }
  io.stdout.write(`${STRINGS.deviceAuthorizationWaiting}\n`);

  const registered = await completeSparkDaemonDeviceAuthorization(
    paths,
    { ...deviceIdentity, authorization },
    io.deviceAuthorizationSleep ? { sleep: io.deviceAuthorizationSleep } : {},
  );
  io.stdout.write(`${STRINGS.deviceAuthorizationSucceeded(registered.runtimeId, serverUrl)}\n`);
  return 0;
}

function openExternalUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!command) {
    return false;
  }
  const result = spawnSync(command, [url.toString()], { stdio: "ignore" });
  return !result.error && result.status === 0;
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

function configForCockpitServer(
  paths: ReturnType<typeof resolveSparkPaths>,
  identity: ReturnType<typeof readSparkDaemonConfig>,
  serverUrl: string,
) {
  const profile = getSparkDaemonServerProfile(paths, serverUrl);
  return profile ? sparkDaemonConfigForServerProfile(identity, profile) : identity;
}

function serverProfileStatus(
  identity: ReturnType<typeof readSparkDaemonConfig>,
  profile: SparkDaemonServerProfile,
) {
  const config = sparkDaemonConfigForServerProfile(identity, profile);
  return {
    serverUrl: profile.serverUrl,
    runtimeId: profile.runtimeId,
    enrolled: Boolean(profile.runtimeId && profile.runtimeToken),
    runnable: hasRunnableSparkDaemonCredentialsForServer(config, profile.serverUrl),
    runtimeTokenExpiresAt: profile.runtimeTokenExpiresAt,
    refreshTokenExpiresAt: profile.refreshTokenExpiresAt,
  };
}

async function doctor(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo): Promise<number> {
  prepareSparkDaemonState(paths);
  const config = readSparkDaemonConfig(paths);
  const profiles = listSparkDaemonServerProfiles(paths);
  const daemon = await buildDaemonStatus(paths, io);
  const workspace = await buildDoctorWorkspaceStatus(paths, io, daemon);
  const credentialServers = profiles.map((profile) => serverProfileStatus(config, profile));
  const credentialsOk =
    credentialServers.length > 0 && credentialServers.every((server) => server.runnable);
  const primary = profiles[0];
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
            ...(daemon.running ? { invocations: daemon.invocations } : {}),
            ...("unreachable" in daemon && daemon.unreachable
              ? { unreachable: true, error: daemon.error }
              : {}),
          },
          credentials: {
            ok: credentialsOk,
            enrolled: credentialServers.some((server) => server.enrolled),
            servers: credentialServers,
          },
          workspace,
          cockpit,
        },
        paths,
        config: {
          installationId: config.installationId,
          displayName: config.displayName,
          // Retain the single-server fields as a compatibility projection when
          // exactly one profile exists; `servers` is authoritative.
          serverUrl: profiles.length === 1 ? primary?.serverUrl : undefined,
          runtimeId: profiles.length === 1 ? primary?.runtimeId : undefined,
          runtimeTokenExpiresAt: profiles.length === 1 ? primary?.runtimeTokenExpiresAt : undefined,
          refreshTokenExpiresAt: profiles.length === 1 ? primary?.refreshTokenExpiresAt : undefined,
          enrolled: credentialServers.some((server) => server.enrolled),
          servers: credentialServers,
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
  const profiles = listSparkDaemonServerProfiles(paths);
  const credentialServers = profiles.map((profile) => serverProfileStatus(config, profile));
  const primary = profiles[0];
  const daemon = await buildDaemonStatus(paths, io);
  const workspaceCount = daemon.running
    ? daemon.servers.reduce((sum, server) => sum + server.workspaceCount, 0)
    : 0;
  io.stdout.write(
    JSON.stringify(
      {
        enrolled: credentialServers.some((server) => server.enrolled),
        runtimeId: profiles.length === 1 ? primary?.runtimeId : undefined,
        serverUrl: profiles.length === 1 ? primary?.serverUrl : undefined,
        runtimeTokenExpiresAt: profiles.length === 1 ? primary?.runtimeTokenExpiresAt : undefined,
        refreshTokenExpiresAt: profiles.length === 1 ? primary?.refreshTokenExpiresAt : undefined,
        servers: credentialServers.map((server) => ({
          ...server,
          ...(daemon.running
            ? {
                connection:
                  daemon.servers.find((current) => current.url === server.serverUrl) ?? null,
              }
            : {}),
        })),
        workspaceCount,
        daemonRunning: daemon.running,
        invocations: daemon.running ? daemon.invocations : undefined,
        lifecycle: daemon.running ? daemon.lifecycle : undefined,
        pidFile: paths.pidFile,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
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

  if (subcommand === "relocate") {
    return await relocateWorkspaceCommand(paths, args, io);
  }

  throw new Error("Usage: spark daemon workspace <register|relocate|ls|show|stop>");
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
  const profiles = listSparkDaemonServerProfiles(paths);
  const registrationDefault =
    profiles.length === 1 ? sparkDaemonConfigForServerProfile(config, profiles[0]!) : config;
  const serverUrl = await resolveRegistrationServerUrl(flags, registrationDefault, io, {
    interactive,
  });
  const registrationToken = await resolveRegistrationToken(flags, io, {
    interactive,
  });
  if (!registrationToken) {
    throw new Error(STRINGS.workspaceTokenRequired(serverUrl));
  }
  const displayName =
    flags.name ?? (interactive ? await promptWorkspaceName(localPath, io) : undefined);
  const profile = await resolveWorkspaceProfile(localPath, flags, io, {
    allowDetectedPrompt: interactive,
  });

  const workspaceOptions: WorkspaceRegistrationRequest = {
    serverUrl,
    localPath,
    ...(flags["allow-insecure-http"] === "true" ? { allowInsecureHttp: true } : {}),
    ...(registrationToken ? { registrationToken } : {}),
    ...(flags.key || flags["local-key"]
      ? { localWorkspaceKey: flags.key ?? flags["local-key"] }
      : {}),
    ...(displayName ? { displayName } : {}),
    ...(flags["workspace-name"] ? { workspaceName: flags["workspace-name"] } : {}),
    ...(flags["workspace-slug"] ? { workspaceSlug: flags["workspace-slug"] } : {}),
    ...(profile ? { profile } : {}),
  };
  const added = await registerWorkspaceForCli(paths, workspaceOptions, io);
  io.stdout.write(
    `✓ workspace '${added.displayName}' registered\n` +
      `  path     ${formatPathForDisplay(added.localPath)}\n` +
      `  server   ${added.serverUrl}\n` +
      profileTextLine(added.profile) +
      `  status   ${workspaceStatusLabel(added)}\n` +
      workspaceAuthorizationText(added, serverUrl) +
      `  note     Cockpit can unbind this projection; rerun workspace register to bind it again.\n`,
  );

  if (readRunningPid(paths) !== null) {
    io.stdout.write("Spark daemon is running.\n");
  }
  return 0;
}

function workspaceAuthorizationText(workspace: SparkDaemonWorkspace, serverUrl: string): string {
  const authorization = workspace.workspaceAuthorization;
  if (!authorization) return "";
  const loginUrl = new URL(`/${encodeURIComponent(authorization.workspaceSlug)}/login`, serverUrl);
  return (
    `  authorize ${loginUrl.toString()}\n` +
    `  one-time ${authorization.oneTimeToken}\n` +
    `  expires  ${authorization.expiresAt}\n` +
    `  note     Additional browsers: spark cockpit workspace access create --workspace ${authorization.workspaceId}\n`
  );
}

async function uplink(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (
    helpRequested(args) ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printUplinkHelp(io);
    return 0;
  }
  prepareSparkDaemonState(paths);
  if (subcommand === "park") {
    return await uplinkParkCommand(paths, args, io);
  }
  if (subcommand === "unpark") {
    return await uplinkUnparkCommand(paths, args, io);
  }
  if (subcommand === "prefer") {
    return await uplinkPreferCommand(paths, args, io);
  }
  if (subcommand === "status" || subcommand === undefined) {
    return await uplinkStatusCommand(paths, args, io);
  }
  throw new Error("Usage: spark daemon uplink <park|unpark|prefer|status>");
}

async function uplinkParkCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const serverUrl = flags["server-url"] ?? positionalArgs(args)[0];
  if (!serverUrl) {
    throw new Error("Usage: spark daemon uplink park --server-url <origin>");
  }
  const profile = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { parkUplinkInService?: typeof requestUplinkPark }).parkUplinkInService ??
      requestUplinkPark
    )(paths, { serverUrl }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify({ action: "uplink-park", profile }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`✓ Uplink parked for ${serverUrl}\n`);
  return 0;
}

async function uplinkUnparkCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const serverUrl = flags["server-url"] ?? positionalArgs(args)[0];
  if (!serverUrl) {
    throw new Error("Usage: spark daemon uplink unpark --server-url <origin>");
  }
  const profile = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { unparkUplinkInService?: typeof requestUplinkUnpark }).unparkUplinkInService ??
      requestUplinkUnpark
    )(paths, { serverUrl }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify({ action: "uplink-unpark", profile }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`✓ Uplink unparked for ${serverUrl}\n`);
  return 0;
}

async function uplinkPreferCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const serverUrl = flags["server-url"];
  const workspace = flags.workspace ?? positionalArgs(args)[0];
  if (!serverUrl || !workspace) {
    throw new Error("Usage: spark daemon uplink prefer --workspace <id> --server-url <origin>");
  }
  const preferred = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { preferUplinkInService?: typeof requestUplinkPrefer }).preferUplinkInService ??
      requestUplinkPrefer
    )(paths, { workspace, serverUrl }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify({ action: "uplink-prefer", preferred }, null, 2)}\n`);
    return 0;
  }
  const row = preferred as {
    previousServerUrl?: string;
    serverUrl?: string;
    workspace?: { displayName?: string };
  };
  io.stdout.write(
    `✓ Workspace preferred onto ${row.serverUrl ?? serverUrl}\n` +
      `  workspace ${row.workspace?.displayName ?? workspace}\n` +
      `  previous  ${row.previousServerUrl ?? "—"}\n`,
  );
  return 0;
}

async function uplinkStatusCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const status = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { uplinkStatusInService?: typeof requestUplinkStatus }).uplinkStatusInService ??
      requestUplinkStatus
    )(paths),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const payload = status as {
    origins?: Array<{
      serverUrl: string;
      parked: boolean;
      desired: boolean;
      runnable: boolean;
      workspaceCount: number;
    }>;
  };
  const origins = payload.origins ?? [];
  if (origins.length === 0) {
    io.stdout.write("No Cockpit uplink profiles.\n");
    return 0;
  }
  for (const origin of origins) {
    io.stdout.write(
      `${origin.serverUrl}  parked=${origin.parked}  desired=${origin.desired}  runnable=${origin.runnable}  workspaces=${origin.workspaceCount}\n`,
    );
  }
  return 0;
}

async function relocateWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const toServerUrl = flags["to-server-url"] ?? flags.to ?? positionalArgs(args)[0];
  if (!toServerUrl) {
    throw new Error("Workspace relocation requires --to-server-url <https-origin>.");
  }
  if (!(await confirmAction(io, flags, `Relocate Cockpit uplink to ${toServerUrl}?`))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }
  const result = await requestWorkspaceService(
    paths,
    io,
    async () =>
      await (io.relocateWorkspaceInService ?? requestWorkspaceRelocate)(paths, {
        toServerUrl,
        ...(flags["from-server-url"] ? { fromServerUrl: flags["from-server-url"] } : {}),
      }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(
    `✓ Cockpit uplink relocated\n` +
      `  instance   ${result.instanceId}\n` +
      `  runtime    ${result.runtimeId}\n` +
      `  from       ${result.fromServerUrl}\n` +
      `  to         ${result.toServerUrl}\n` +
      `  workspaces ${result.workspaceCount}\n` +
      `  bindings   ${result.workspaceBindingIds.join(", ") || "none"}\n`,
  );
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
      "no workspaces registered.\n  spark daemon workspace register . --server-url <url> --token <workspace-token> --name <ws>\n",
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
        "  spark daemon workspace register . --server-url <url> --token <workspace-token> --name <ws>\n" +
        "or cd into a registered workspace, or pass --workspace <id>.\n",
    );
    return 2;
  }

  assertDirectory(workspace.localPath);
  const config = readSparkDaemonConfig(paths);
  const serverConfig = configForCockpitServer(paths, config, workspace.serverUrl);
  if (!hasRunnableSparkDaemonCredentialsForServer(serverConfig, workspace.serverUrl)) {
    throw new Error(
      `Workspace '${workspace.displayName}' is registered locally, but daemon credentials for ${workspace.serverUrl} are missing. Run spark daemon login --server-url ${shellQuote(workspace.serverUrl)}, then retry.`,
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
      "no workspaces registered.\n  spark daemon workspace register . --server-url <url> --token <workspace-token> --name <ws>\n",
    );
    return 0;
  }

  const idWidth = Math.max(37, ...workspaces.map((entry) => entry.id.length));
  io.stdout.write(
    `${pad("ID", idWidth)} ${pad("NAME", 20)} ${pad("SERVER", 30)} ${pad("STATUS", 24)} ${pad("PATH", 38)} ${pad("PROJECTS", 8)} ${pad("INBOX", 5)} LAST SESSION\n`,
  );
  for (const workspace of workspaces) {
    const listItem = workspaceListItem(workspace, statusContext);
    io.stdout.write(
      `${pad(workspace.id, idWidth)} ` +
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
      if (!(error instanceof LocalRpcUnavailableError)) {
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
    `  id             ${workspace.id}\n` +
    `  status         ${workspaceStatusLabel(workspace, statusContext)}\n` +
    `  server         ${workspace.serverUrl || "—"}\n` +
    `  binding        ${workspace.serverBindingId ?? "—"}${
      workspace.cockpitBindingState ? ` (${workspace.cockpitBindingState})` : ""
    }\n` +
    `  cockpit ws     ${workspace.serverWorkspaceId ?? "—"}\n` +
    `  path           ${formatPathForDisplay(workspace.localPath)}\n` +
    profileTextLine(workspace.profile, "  profile        ") +
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
      "No workspace found. Run spark daemon workspace register . --server-url <url>.",
    );
  }

  const cwd = resolveInvocationCwd();
  const workspace = resolveWorkspaceForCwd(workspaces, cwd);
  if (!workspace) {
    throw new Error(`${cwd} is not under a registered workspace. Pass a workspace id.`);
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
    throw new Error("Pass a workspace id or --workspace <id>.");
  }
  const workspace = resolveWorkspace(await loadWorkspaceList(paths, io), identifier);
  if (
    !(await confirmAction(
      io,
      flags,
      `Pause workspace '${workspace.id}' (${workspace.displayName})?`,
    ))
  ) {
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
        "No workspace found. Run spark daemon workspace register . --server-url <url>.",
      );
    }
    throw new Error(
      `Multiple workspaces are registered. Pass --workspace <id>. Available: ${workspaces
        .map(workspaceIdentifier)
        .join(", ")}.`,
    );
  }

  const parsed = parseWorkspaceIdentifier(identifier);
  const idMatches = workspaces.filter((workspace) => workspaceMatchesId(workspace, parsed.name));
  let matches =
    idMatches.length > 0
      ? idMatches
      : workspaces.filter((workspace) => workspaceMatchesName(workspace, parsed.name));
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
      `Ambiguous workspace: ${identifier}. Use ${matches.map(workspaceIdentifier).join(", ")}.`,
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
    id: workspace.id,
    slug: workspace.localWorkspaceKey,
    name: workspace.displayName,
    serverUrl: workspace.serverUrl,
    ...(workspace.serverBindingId ? { serverBindingId: workspace.serverBindingId } : {}),
    ...(workspace.serverWorkspaceId ? { serverWorkspaceId: workspace.serverWorkspaceId } : {}),
    ...(workspace.cockpitBindingState
      ? { cockpitBindingState: workspace.cockpitBindingState }
      : {}),
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
    fix: "check Cockpit reachability and run spark daemon login again if authorization expired",
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

function workspaceMatchesId(workspace: SparkDaemonWorkspace, ref: string): boolean {
  return (
    workspace.id === ref || workspace.serverBindingId === ref || workspace.serverWorkspaceId === ref
  );
}

function workspaceMatchesName(workspace: SparkDaemonWorkspace, name: string): boolean {
  return workspace.displayName === name || workspace.localWorkspaceKey === name;
}

function serverMatchesRef(serverUrl: string, serverRef: string): boolean {
  return serverUrl === serverRef || serverUrl.startsWith(serverRef);
}

/** Canonical CLI marker for a daemon workspace. */
function workspaceIdentifier(workspace: SparkDaemonWorkspace): string {
  return workspace.id;
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

async function resolveRegistrationServerUrl(
  flags: Record<string, string>,
  current: ReturnType<typeof readSparkDaemonConfig>,
  io: CliIo,
  options: { interactive?: boolean } = {},
): Promise<string> {
  const serverUrl = flags["server-url"] ?? flags.server;
  const validationOptions = {
    allowInsecureHttp: flags["allow-insecure-http"] === "true",
  };
  if (serverUrl) {
    return validateRegistrationServerUrl(serverUrl, validationOptions);
  }

  const configured = configuredServerUrl(current);
  if (options.interactive) {
    return validateRegistrationServerUrl(
      await promptWithDefault(io, "server URL", configured),
      validationOptions,
    );
  }

  if (configured) {
    return validateRegistrationServerUrl(configured, validationOptions);
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
  const sources = daemonLogSources(paths);
  writeLogTail(sources, lineCount, io);
  if (flags.follow !== "true" && flags.f !== "true") {
    return 0;
  }

  await followLogFiles(sources, io);
  return 0;
}

interface DaemonLogSource {
  label: string;
  path: string;
}

function daemonLogSources(paths: ReturnType<typeof resolveSparkPaths>): DaemonLogSource[] {
  return [
    { label: "service stdout", path: join(paths.logDir, "service.stdout.log") },
    { label: "service stderr", path: join(paths.logDir, "service.stderr.log") },
    // Keep the structured log path visible for compatibility with callers or
    // future sinks that write it, even though service output currently lands
    // in the supervisor-owned stdout/stderr files above.
    { label: "daemon events", path: paths.logFile },
  ];
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

function writeLogTail(sources: readonly DaemonLogSource[], lineCount: number, io: CliIo): void {
  const existingSources = sources.filter((source) => existsSync(source.path));
  if (existingSources.length === 0) {
    io.stdout.write(
      `no daemon logs yet; checked:\n${sources
        .map((source) => `  ${source.label}: ${source.path}`)
        .join("\n")}\n`,
    );
    return;
  }

  for (const source of existingSources) {
    const content = readFileSync(source.path, "utf8");
    if (!content) {
      continue;
    }

    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const selected = lineCount === 0 ? [] : lines.slice(-lineCount);
    if (selected.length > 0) {
      writeLogSource(source, `${selected.join("\n")}\n`, io);
    }
  }
}

function writeLogSource(source: DaemonLogSource, content: string, io: CliIo): void {
  io.stdout.write(`==> ${source.label} (${source.path}) <==\n`);
  io.stdout.write(content);
  if (!content.endsWith("\n")) {
    io.stdout.write("\n");
  }
}

async function followLogFiles(sources: readonly DaemonLogSource[], io: CliIo): Promise<void> {
  const offsets = new Map(
    sources.map((source) => [
      source.path,
      existsSync(source.path) ? readFileSync(source.path, "utf8").length : 0,
    ]),
  );
  const listeners = new Map<string, () => void>();

  await new Promise<void>((resolvePromise) => {
    for (const source of sources) {
      const listener = () => {
        if (!existsSync(source.path)) {
          return;
        }

        const content = readFileSync(source.path, "utf8");
        let offset = offsets.get(source.path) ?? 0;
        if (content.length < offset) {
          offset = 0;
        }
        if (content.length > offset) {
          writeLogSource(source, content.slice(offset), io);
          offsets.set(source.path, content.length);
        }
      };
      listeners.set(source.path, listener);
      watchFile(source.path, { interval: 500 }, listener);
    }

    process.once("SIGINT", () => {
      for (const source of sources) {
        unwatchFile(source.path, listeners.get(source.path));
      }
      resolvePromise();
    });
  });
}

bindCliDaemonLogs(logs);

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

async function promptWorkspacePath(io: CliIo): Promise<string> {
  return promptWithDefault(io, "path", ".");
}

async function promptWorkspaceName(localPath: string, io: CliIo): Promise<string> {
  return promptWithDefault(io, "workspace name", workspaceNameForPath(localPath));
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
