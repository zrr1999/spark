import { readSparkBuildInfo } from "./build-info.ts";
import { parseChannel, parsePolicy } from "./config.ts";
import { SparkUpdateManager } from "./manager.ts";

type Output = Pick<NodeJS.WriteStream, "write">;

export interface SparkUpdateCliIo {
  stdout?: Output;
  stderr?: Output;
}

export async function runSparkVersionCommand(
  argv: string[],
  io: SparkUpdateCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--json")) {
    (io.stderr ?? process.stderr).write('spark version accepts only the optional "--json" flag\n');
    return 2;
  }
  const build = readSparkBuildInfo();
  stdout.write(argv[0] === "--json" ? `${JSON.stringify(build, null, 2)}\n` : `${build.version}\n`);
  return 0;
}

export async function runSparkManagedInstallCommand(
  argv: string[],
  io: SparkUpdateCliIo = {},
): Promise<number> {
  return await guarded(io, async () => {
    const version = optionValue(argv, "--version");
    const prefix = optionValue(argv, "--prefix");
    const unknown = argv.filter(
      (argument, index) =>
        argument !== "--managed" &&
        argument !== "--version" &&
        argument !== "--prefix" &&
        argv[index - 1] !== "--version" &&
        argv[index - 1] !== "--prefix",
    );
    if (unknown.length > 0) throw new Error(`Unknown managed install option: ${unknown[0]}`);
    const status = await new SparkUpdateManager({ prefix }).installManaged(version);
    (io.stdout ?? process.stdout).write(`${formatStatus(status)}\n`);
  });
}

export async function runSparkUpdateCommand(
  argv: string[],
  io: SparkUpdateCliIo = {},
): Promise<number> {
  return await guarded(io, async () => {
    const [action = "status", ...rest] = argv;
    const prefix = optionValue(rest, "--prefix");
    const manager = new SparkUpdateManager({ prefix });
    const handler = UPDATE_COMMAND_HANDLERS[action];
    if (!handler) throw new Error(`Unknown spark update action: ${action}`);
    await handler({ manager, rest, stdout: io.stdout ?? process.stdout });
  });
}

interface UpdateCommandContext {
  manager: SparkUpdateManager;
  rest: string[];
  stdout: Output;
}

type UpdateCommandHandler = (context: UpdateCommandContext) => Promise<void>;

const UPDATE_COMMAND_HANDLERS: Readonly<Record<string, UpdateCommandHandler>> = {
  status: async ({ manager, rest, stdout }) => {
    writeStatus(stdout, await manager.status(), rest.includes("--json"));
  },
  check: async ({ manager, rest, stdout }) => {
    writeStatus(stdout, await manager.check(), rest.includes("--json"));
  },
  __tick: async ({ manager }) => {
    try {
      await manager.tick();
    } catch {
      // Background failures are already rate-limited and persisted by the
      // updater. Keep launchd's 15-minute tick from duplicating log noise.
    }
  },
  configure: async ({ manager, rest, stdout }) => {
    const policyValue = optionValue(rest, "--policy");
    const channelValue = optionValue(rest, "--channel");
    const policy = policyValue ? parsePolicy(policyValue) : undefined;
    const channel = channelValue ? parseChannel(channelValue) : undefined;
    if (policyValue && !policy) throw new Error(`Invalid update policy: ${policyValue}`);
    if (channelValue && !channel) throw new Error(`Invalid update channel: ${channelValue}`);
    if (!policy && !channel) {
      throw new Error("spark update configure requires --policy and/or --channel");
    }
    const config = await manager.configure({
      ...(policy ? { policy } : {}),
      ...(channel ? { channel } : {}),
    });
    stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  },
  apply: async ({ manager, rest, stdout }) => {
    requireConfirmation(rest);
    stdout.write(`${formatStatus(await manager.apply(positional(rest), { wait: true }))}\n`);
  },
  rollback: async ({ manager, rest, stdout }) => {
    requireConfirmation(rest);
    stdout.write(`${formatStatus(await manager.rollback({ wait: true }))}\n`);
  },
  retry: async ({ manager, rest, stdout }) => {
    requireConfirmation(rest);
    stdout.write(`${formatStatus(await manager.retry(positional(rest)))}\n`);
  },
};

function writeStatus(
  output: Output,
  status: Awaited<ReturnType<SparkUpdateManager["status"]>>,
  json: boolean,
): void {
  output.write(json ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}\n`);
}

function optionValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || undefined;
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positional(argv: string[]): string | undefined {
  return argv.find(
    (argument, index) =>
      !argument.startsWith("--") &&
      argv[index - 1] !== "--prefix" &&
      argv[index - 1] !== "--policy" &&
      argv[index - 1] !== "--channel",
  );
}

function requireConfirmation(argv: string[]): void {
  if (!argv.includes("--yes")) {
    throw new Error("This command changes the managed installation; rerun with --yes to confirm");
  }
}

function formatStatus(status: Awaited<ReturnType<SparkUpdateManager["status"]>>): string {
  const state = status.state;
  return [
    `managed: ${status.managed ? "yes" : "no"}`,
    `policy: ${status.config.policy}`,
    `channel: ${status.config.channel}`,
    `current: ${state.currentVersion ?? "none"}`,
    `available: ${state.availableVersion ?? "none"}`,
    `pending: ${state.pendingVersion ?? "none"}`,
    `quarantined: ${state.quarantined.map((entry) => entry.version).join(", ") || "none"}`,
    ...(status.repairCommand ? [`repair: ${status.repairCommand}`] : []),
  ].join("\n");
}

async function guarded(io: SparkUpdateCliIo, operation: () => Promise<void>): Promise<number> {
  try {
    await operation();
    return 0;
  } catch (error) {
    (io.stderr ?? process.stderr).write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
