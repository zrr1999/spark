import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { fileURLToPath } from "node:url";

import { sparkTuiCliStrings, sparkTuiPiParityStrings } from "@zendev-lab/spark-i18n/cli";
import {
  SPARK_PROTOCOL_VERSION,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
  type SparkTaskView,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";

import {
  attachSparkWorkspaceClient,
  clientCancelTurn,
  clientCreateManagedSession,
  clientGetManagedSession,
  clientGetManagedSessionSnapshot,
  clientListDaemonWorkspaces,
  clientListManagedSessions,
  createSparkDaemonNativeCommands,
  createSparkDaemonNativeResponder,
  ensureSparkDaemonWorkspaceSession,
  handleSparkDaemonHumanInteractionRequest,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
  type SparkDaemonCliCommand,
  type SparkDaemonWorkspace,
} from "./cli/daemon.ts";
import {
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
  createSparkNativeUiTransport,
  runNativeSparkTui,
  type SparkNativeSlashCommandMap,
  type SparkNativeTuiApp,
  type SparkNativeWorkspaceSessionState,
} from "./native-tui.ts";
import {
  createSparkPiParitySlashCommands,
  PI_PARITY_COMMAND_NAMES,
} from "./cli/pi-parity-commands.ts";
import {
  createSparkDaemonModelAuthClient,
  daemonSnapshotToPickerState,
  resolveDaemonModelSelection,
  type SparkDaemonModelAuthClient,
} from "./cli/model-control.ts";
import { createSparkPromptTemplateSlashCommands } from "./cli/prompt-template-commands.ts";
import {
  formatSparkResourceResult,
  runSparkResourceCommand,
  type SparkResourceKind,
} from "./cli/resource-manager.ts";
import {
  createSparkCliHostServices,
  formatSparkModelSelection,
  loadSparkConfig,
  registerSparkSessionsCommand,
  resolveSparkModelSelectionById,
  SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
  SPARK_MODEL_CYCLE_PREV_BINDING_ID,
  SPARK_MODEL_PICKER_BINDING_ID,
  workspaceSessionHash,
  type SparkActiveSelection,
  type SparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkConfig,
  type SparkModelPickerState,
} from "./host/index.ts";
import {
  createSparkModelPickerFromCustomUi,
  type SparkModelSelectorCustomUi,
} from "./tui/model-selector.ts";
import {
  CREATE_SPARK_SESSION_SELECTION,
  formatSparkSessionListByWorkspace,
  isSelectableSparkSession,
  runNativeSparkSessionSelector,
  type SparkSessionSelectorOptions,
} from "./tui/session-selector.ts";
import { renderSparkFirstRunOnboarding } from "./cli/onboarding.ts";

const tuiCliStrings = sparkTuiCliStrings();

export interface SparkCliArgs {
  initialMessage?: string;
  help: boolean;
}

export type SparkCliMode = "text" | "json" | "rpc";

export interface SparkCliRuntimeOptions {
  mode?: SparkCliMode;
  provider?: string;
  model?: string;
  session?: string;
  sessionId?: string;
  sessionDir?: string;
  sparkSessionKey?: string;
  noSession?: boolean;
  name?: string;
  extensions?: string[];
  noExtensions?: boolean;
  skills?: string[];
  noSkills?: boolean;
  promptTemplates?: string[];
  noPromptTemplates?: boolean;
  themes?: string[];
  noThemes?: boolean;
  noContextFiles?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  excludeTools?: string[];
  projectTrustOverride?: boolean;
  fileArgs?: string[];
}

export type SparkCliCommand =
  | { kind: "help" }
  | { kind: "print"; prompt: string; mode?: "text" | "json"; options?: SparkCliRuntimeOptions }
  | { kind: "rpc"; options?: SparkCliRuntimeOptions }
  | { kind: "list-models"; query?: string; options?: SparkCliRuntimeOptions }
  | {
      kind: "resources";
      action: "install" | "remove" | "update" | "list" | "config";
      source?: string;
      resourceKind?: SparkResourceKind;
      local?: boolean;
      json?: boolean;
    }
  | { kind: "tui"; initialMessage?: string; options?: SparkCliRuntimeOptions }
  | { kind: "daemon"; command: SparkDaemonCliCommand }
  | { kind: "error"; message: string };

export interface SparkCliTerminalState {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export interface RunSparkCliOptions {
  daemonClient?: SparkDaemonClientOptions;
  runTui?: typeof runNativeSparkTui;
  selectSession?: (options: SparkSessionSelectorOptions) => Promise<string | null>;
  createHostServices?: (options?: SparkCliHostServicesOptions) => Promise<SparkCliHostServices>;
  terminal?: SparkCliTerminalState;
}

export function parseSparkCliArgs(argv: string[]): SparkCliArgs {
  if (argv.some((arg) => arg === "-h" || arg === "--help")) return { help: true };
  const initialMessage = argv.join(" ").trim();
  return { help: false, initialMessage: initialMessage || undefined };
}

export function parseSparkCliCommand(argv: string[]): SparkCliCommand {
  if (argv.length === 0) return { kind: "tui" };
  if (
    argv.some((arg) => arg === "-h" || arg === "--help") &&
    argv[0] !== "daemon" &&
    argv[0] !== "server"
  ) {
    return { kind: "help" };
  }
  if (argv[0] === "daemon")
    return { kind: "daemon", command: parseSparkDaemonCliArgs(argv.slice(1)) };
  if (argv[0] === "server") {
    return {
      kind: "error",
      message: '"server" is not a spark-tui command. Use "spark cockpit" instead.',
    };
  }
  if (argv[0] === "sessions" || argv[0] === "session") {
    return { kind: "daemon", command: parseSparkDaemonCliArgs(argv) };
  }

  const resource = parseSparkResourceCliCommand(argv);
  if (resource) return resource;

  const parsed = parseSparkPiCompatibleOptions(argv);
  const options = compactRuntimeOptions(parsed.options);
  if (parsed.listModels !== undefined) {
    return {
      kind: "list-models",
      ...(parsed.listModels ? { query: parsed.listModels } : {}),
      ...(options ? { options } : {}),
    };
  }
  if (parsed.options.mode === "rpc") return { kind: "rpc", ...(options ? { options } : {}) };
  if (parsed.print) {
    const prompt = parsed.messages.join(" ").trim();
    if (!prompt) throw new Error(tuiCliStrings.printRequiresPrompt);
    return {
      kind: "print",
      prompt,
      ...(parsed.options.mode === "json" || parsed.options.mode === "text"
        ? { mode: parsed.options.mode }
        : {}),
      ...(options ? { options } : {}),
    };
  }
  const initialMessage = parsed.messages.join(" ").trim();
  return {
    kind: "tui",
    ...(initialMessage ? { initialMessage } : {}),
    ...(options ? { options } : {}),
  };
}

interface ParsedSparkPiOptions {
  print: boolean;
  listModels?: string;
  messages: string[];
  options: SparkCliRuntimeOptions;
}

function parseSparkResourceCliCommand(argv: string[]): SparkCliCommand | undefined {
  const [actionToken, ...rest] = argv;
  if (
    actionToken !== "install" &&
    actionToken !== "remove" &&
    actionToken !== "uninstall" &&
    actionToken !== "update" &&
    actionToken !== "list" &&
    actionToken !== "config"
  ) {
    return undefined;
  }
  let resourceKind: SparkResourceKind | undefined;
  let json = false;
  let local = false;
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--provider") {
      resourceKind = "provider";
      continue;
    }
    if (arg === "--skill") {
      resourceKind = "skill";
      continue;
    }
    if (arg === "--prompt-template") {
      resourceKind = "prompt-template";
      continue;
    }
    if (arg === "--theme") {
      resourceKind = "theme";
      continue;
    }
    if (arg === "--extension") {
      resourceKind = "extension";
      continue;
    }
    if (arg === "--local" || arg === "-l") {
      local = true;
      continue;
    }
    positionals.push(arg);
  }
  const action = actionToken === "uninstall" ? "remove" : actionToken;
  return {
    kind: "resources",
    action,
    ...(positionals[0] ? { source: positionals[0] } : {}),
    ...(resourceKind ? { resourceKind } : {}),
    ...(local ? { local } : {}),
    ...(json ? { json } : {}),
  };
}

function parseSparkPiCompatibleOptions(argv: string[]): ParsedSparkPiOptions {
  const messages: string[] = [];
  const options: SparkCliRuntimeOptions = {};
  let print = false;
  let listModels: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--mode":
        options.mode = readMode(argv[++index]);
        break;
      case "--provider":
        options.provider = readRequired(argv, ++index, arg);
        break;
      case "--model":
        options.model = readRequired(argv, ++index, arg);
        break;
      case "--session":
        options.session = readRequired(argv, ++index, arg);
        break;
      case "--session-id":
        options.sessionId = readRequired(argv, ++index, arg);
        break;
      case "--session-dir":
        options.sessionDir = readRequired(argv, ++index, arg);
        break;
      case "--spark-session-key":
        options.sparkSessionKey = readRequired(argv, ++index, arg);
        break;
      case "--no-session":
        options.noSession = true;
        break;
      case "--name":
      case "-n":
        options.name = readRequired(argv, ++index, arg);
        break;
      case "--extension":
      case "-e":
        (options.extensions ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-extensions":
      case "-ne":
        options.noExtensions = true;
        break;
      case "--skill":
        (options.skills ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-skills":
      case "-ns":
        options.noSkills = true;
        break;
      case "--prompt-template":
        (options.promptTemplates ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-prompt-templates":
      case "-np":
        options.noPromptTemplates = true;
        break;
      case "--theme":
        (options.themes ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-themes":
        options.noThemes = true;
        break;
      case "--no-context-files":
      case "-nc":
        options.noContextFiles = true;
        break;
      case "--thinking":
        options.thinking = readThinkingLevel(argv[++index]);
        break;
      case "--tools":
      case "-t":
        options.tools = splitCsv(readRequired(argv, ++index, arg));
        break;
      case "--exclude-tools":
      case "-xt":
        options.excludeTools = splitCsv(readRequired(argv, ++index, arg));
        break;
      case "--approve":
      case "-a":
        options.projectTrustOverride = true;
        break;
      case "--no-approve":
      case "-na":
        options.projectTrustOverride = false;
        break;
      case "--print":
      case "-p":
        print = true;
        break;
      case "--list-models": {
        const next = argv[index + 1];
        if (next && !next.startsWith("-") && !next.startsWith("@")) {
          listModels = next;
          index += 1;
        } else {
          listModels = "";
        }
        break;
      }
      default:
        if (arg.startsWith("@")) {
          (options.fileArgs ??= []).push(arg.slice(1));
        } else if (arg.startsWith("-")) {
          throw new Error(`Unknown spark option: ${arg}`);
        } else {
          messages.push(arg);
        }
    }
  }
  return { print, messages, options, ...(listModels !== undefined ? { listModels } : {}) };
}

function compactRuntimeOptions(
  options: SparkCliRuntimeOptions,
): SparkCliRuntimeOptions | undefined {
  return Object.values(options).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  )
    ? options
    : undefined;
}

interface SparkCliSessionAttachResolution {
  target?: string;
  state: SparkNativeWorkspaceSessionState;
  attachMatchesControlPlane: boolean;
  shouldEmitSessionStart: boolean;
}

interface SparkCliSelectedSession {
  resolution: SparkCliSessionAttachResolution;
  session?: SparkSessionRegistryRecord;
  snapshot?: SparkSessionView;
  created?: boolean;
  cancelled?: boolean;
}

async function resolveSparkCliWorkspaceSessionState(
  services: SparkCliHostServices,
  lease: Awaited<ReturnType<typeof attachSparkWorkspaceClient>>,
  runtimeOptions: SparkCliRuntimeOptions | undefined,
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkCliSelectedSession> {
  const target = requestedSparkCliSessionTarget(runtimeOptions);
  const baseState = {
    workspaceDir: services.cwd,
    workspaceHash: services.sessionStore.workspaceHash,
    controlPlaneSessionId: lease.client.id,
  } satisfies Omit<SparkNativeWorkspaceSessionState, "mode">;
  if (!target) {
    return {
      resolution: {
        state: { ...baseState, mode: "select" },
        attachMatchesControlPlane: false,
        shouldEmitSessionStart: false,
      },
    };
  }

  const targetResolution = await resolveSparkCliSessionTarget(services, target, daemonClient);
  if (targetResolution.mismatchDiagnostic) {
    return {
      resolution: {
        target,
        state: {
          ...baseState,
          mode: "mismatch",
          attachTarget: target,
          mismatchDiagnostic: targetResolution.mismatchDiagnostic,
        },
        attachMatchesControlPlane: false,
        shouldEmitSessionStart: false,
      },
    };
  }
  const canonicalTarget = targetResolution.sessionId!;
  return {
    resolution: attachResolutionForManagedSession(
      baseState,
      canonicalTarget,
      targetResolution.session,
      lease.workspace.id,
    ),
    ...(targetResolution.session ? { session: targetResolution.session } : {}),
  };
}

async function selectSparkCliWorkspaceSession(
  services: SparkCliHostServices,
  lease: Awaited<ReturnType<typeof attachSparkWorkspaceClient>>,
  runtimeOptions: SparkCliRuntimeOptions | undefined,
  daemonClient: SparkDaemonClientOptions,
  selectSession: (options: SparkSessionSelectorOptions) => Promise<string | null>,
): Promise<SparkCliSelectedSession> {
  const initial = await resolveSparkCliWorkspaceSessionState(
    services,
    lease,
    runtimeOptions,
    daemonClient,
  );
  if (initial.resolution.state.mode !== "select") {
    if (initial.resolution.state.mode !== "attached" || !initial.resolution.target) return initial;
    return {
      ...initial,
      snapshot: await managedSessionSnapshotIfAvailable(initial.resolution.target, daemonClient),
    };
  }

  const [sessions, workspaces] = await Promise.all([
    clientListManagedSessions({}, daemonClient),
    listSparkSessionSelectorWorkspaces(daemonClient),
  ]);
  const selectableSessions = sessions.filter(isSelectableSparkSession);
  const selection = await selectSession({
    sessions: selectableSessions,
    workspaceId: lease.workspace.id,
    workspaceLabel: `${lease.workspace.displayName} • ${services.cwd}`,
    workspaces,
  });
  if (!selection) return { ...initial, cancelled: true };

  const created = selection === CREATE_SPARK_SESSION_SELECTION;
  const selected = created
    ? await clientCreateManagedSession(
        {
          scope: { kind: "workspace", workspaceId: lease.workspace.id },
          workspaceId: lease.workspace.id,
          cwd: services.cwd,
        },
        daemonClient,
      )
    : requireSelectedManagedSession(selectableSessions, selection);
  const baseState = initial.resolution.state;
  const snapshot = await managedSessionSnapshotIfAvailable(selected.sessionId, daemonClient);
  return {
    resolution: attachResolutionForManagedSession(
      baseState,
      selected.sessionId,
      selected,
      lease.workspace.id,
    ),
    session: selected,
    ...(created ? { created: true } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

function requireSelectedManagedSession(
  sessions: SparkSessionRegistryRecord[],
  sessionId: string,
): SparkSessionRegistryRecord {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!session) throw new Error(`Selected Spark session is no longer available: ${sessionId}`);
  return session;
}

function attachResolutionForManagedSession(
  baseState: Omit<SparkNativeWorkspaceSessionState, "mode">,
  sessionId: string,
  session: SparkSessionRegistryRecord | undefined,
  controlPlaneWorkspaceId: string,
): SparkCliSessionAttachResolution {
  const workspaceDir = session?.cwd ?? baseState.workspaceDir;
  const ownsControlPlane =
    session?.scope.kind !== "daemon" &&
    (!session || session.scope.workspaceId === controlPlaneWorkspaceId);
  return {
    target: sessionId,
    state: {
      ...baseState,
      mode: "attached",
      workspaceDir,
      workspaceHash: ownsControlPlane
        ? baseState.workspaceHash
        : workspaceSessionHash(workspaceDir),
      attachTarget: sessionId,
    },
    attachMatchesControlPlane: ownsControlPlane,
    shouldEmitSessionStart: ownsControlPlane,
  };
}

async function managedSessionSnapshotIfAvailable(
  sessionId: string,
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkSessionView | undefined> {
  try {
    return await clientGetManagedSessionSnapshot(sessionId, daemonClient);
  } catch {
    return undefined;
  }
}

function requestedSparkCliSessionTarget(
  options: SparkCliRuntimeOptions | undefined,
): string | undefined {
  return (
    options?.sessionId?.trim() ||
    options?.session?.trim() ||
    options?.sparkSessionKey?.trim() ||
    undefined
  );
}

function runtimeOptionsWithoutSparkSessionTarget(
  options: SparkCliRuntimeOptions | undefined,
): SparkCliRuntimeOptions | undefined {
  if (!options) return undefined;
  const result = { ...options };
  delete result.session;
  delete result.sessionId;
  delete result.sparkSessionKey;
  return result;
}

function runtimeOptionsForSparkSession(
  options: SparkCliRuntimeOptions | undefined,
  sessionId: string,
): SparkCliRuntimeOptions {
  return {
    ...runtimeOptionsWithoutSparkSessionTarget(options),
    sessionId,
  };
}

async function resolveSparkCliSessionTarget(
  services: SparkCliHostServices,
  target: string,
  daemonClient: SparkDaemonClientOptions,
): Promise<{
  sessionId?: string;
  session?: SparkSessionRegistryRecord;
  mismatchDiagnostic?: string;
}> {
  if (looksLikeSparkSessionPath(target)) {
    const normalizedTarget = target.startsWith("file://") ? fileURLToPath(target) : target;
    const absoluteTarget = resolve(normalizedTarget);
    const resolvedTarget = safeRealpath(absoluteTarget) ?? absoluteTarget;
    const resolvedWorkspaceSessionDir =
      safeRealpath(services.sessionStore.sessionDir) ?? services.sessionStore.sessionDir;
    if (!isSameOrChildPath(resolvedTarget, resolvedWorkspaceSessionDir)) {
      return {
        mismatchDiagnostic: `session path is outside workspace session directory ${services.sessionStore.sessionDir}`,
      };
    }
    try {
      const record = await services.sessionStore.loadByRef(absoluteTarget);
      return { sessionId: record.header.id };
    } catch {
      return {
        mismatchDiagnostic: `session path could not be loaded from workspace ${services.sessionStore.workspaceHash}`,
      };
    }
  }

  try {
    const session = await clientGetManagedSession(target, daemonClient);
    if (session.status === "archived") {
      return { mismatchDiagnostic: `session ${target} is archived` };
    }
    return { sessionId: session.sessionId, session };
  } catch {
    // Legacy local JSONL and durable state sessions may predate the daemon registry.
  }

  const existing = await services.sessionStore.findById(target);
  if (existing) return { sessionId: existing.header.id };
  if (!existing && !sparkDurableSessionExists(services, target)) {
    return {
      mismatchDiagnostic: `session ${target} was not found in workspace ${services.sessionStore.workspaceHash}`,
    };
  }
  return { sessionId: target };
}

function looksLikeSparkSessionPath(value: string): boolean {
  return value.endsWith(".jsonl") || value.includes("/") || value.includes("\\");
}

function sparkDurableSessionExists(services: SparkCliHostServices, target: string): boolean {
  const stateRoot = services.runtime.makeContext().sparkStateRoot?.trim();
  if (!stateRoot) return false;
  const sessionKey = normalizeSparkDurableSessionKey(target);
  if (!sessionKey) return false;
  return existsSync(join(stateRoot, "sessions", sanitizeSparkStoreScope(sessionKey)));
}

function normalizeSparkDurableSessionKey(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed || looksLikeSparkSessionPath(trimmed)) return undefined;
  if (trimmed.startsWith("session:") || trimmed.startsWith("leaf:")) return trimmed;
  return `session:${trimmed}`;
}

function sanitizeSparkStoreScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-") || "default";
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isSameOrChildPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function sparkSessionSelectorWorkspaceIds(workspace: SparkDaemonWorkspace): string[] {
  return [workspace.id, workspace.serverWorkspaceId, workspace.localWorkspaceKey].filter(
    (id): id is string => Boolean(id),
  );
}

async function listSparkSessionSelectorWorkspaces(
  daemonClient: SparkDaemonClientOptions,
): Promise<Array<{ id: string; canonicalId: string; displayName: string; localPath: string }>> {
  try {
    const { workspaces } = await clientListDaemonWorkspaces(daemonClient);
    return workspaces.flatMap((workspace) =>
      sparkSessionSelectorWorkspaceIds(workspace).map((id) => ({
        id,
        canonicalId: workspace.id,
        displayName: workspace.displayName,
        localPath: workspace.localPath,
      })),
    );
  } catch {
    return [];
  }
}

async function daemonSparkSessionListText(
  services: SparkCliHostServices,
  daemonClient: SparkDaemonClientOptions,
  workspace: { workspaceId: string; workspaceLabel: string },
): Promise<string | undefined> {
  try {
    const [sessions, workspaces] = await Promise.all([
      clientListManagedSessions({}, daemonClient),
      listSparkSessionSelectorWorkspaces(daemonClient),
    ]);
    return formatSparkSessionListByWorkspace({
      sessions,
      workspaceId: workspace.workspaceId,
      workspaceLabel: workspace.workspaceLabel,
      workspaces,
    });
  } catch {
    return await durableSparkSessionListText(services);
  }
}

async function durableSparkSessionListText(
  services: SparkCliHostServices,
): Promise<string | undefined> {
  const stateRoot = services.runtime.makeContext().sparkStateRoot?.trim();
  if (!stateRoot) return undefined;
  const indexPath = join(stateRoot, "sessions", "index.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
    return undefined;
  }
  const lines = ["Spark durable sessions:"];
  for (const session of parsed.sessions.slice(0, 12)) {
    if (!isRecord(session)) continue;
    const sessionKey = stringField(session, "sessionKey") ?? "session:unknown";
    const project = stringField(session, "currentProjectRef");
    const task = stringField(session, "currentTaskRef");
    const activeGoal = session.activeGoal === true ? " goal=active" : "";
    const updated = stringField(session, "updatedAt");
    lines.push(
      `- ${sessionKey}${project ? ` project=${project}` : ""}${task ? ` task=${task}` : ""}${activeGoal}${updated ? ` updated=${updated}` : ""}`,
    );
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

async function hydrateNativeCockpitFromTaskRead(
  services: SparkCliHostServices,
  app: SparkNativeTuiApp,
  workspaceSession: SparkNativeWorkspaceSessionState,
): Promise<void> {
  const tool = services.runtime.getTool("task_read")?.config;
  if (!tool) return;
  let details: Record<string, unknown> | undefined;
  try {
    const result = await tool.execute(
      "native-cockpit-hydrate",
      { action: "project_status", view: "active", format: "json", limit: 6 },
      new AbortController().signal,
      () => undefined,
      services.runtime.makeContext(),
    );
    details = isRecord(result.details) ? result.details : parseFirstJsonContent(result.content);
  } catch {
    return;
  }
  if (!details?.found) return;
  const selectedProject = isRecord(details.selectedProject)
    ? details.selectedProject
    : isRecord(details.activeProject)
      ? details.activeProject
      : undefined;
  const projectTitle = stringField(selectedProject, "title");
  const tasks: SparkTaskView[] = [];
  addCompactTaskView(tasks, details.currentClaim);
  addCompactTaskViews(tasks, details.ready);
  addCompactTaskView(tasks, details.selectedTask);
  app.hydrateCockpit({
    sessionId: workspaceSession.attachTarget ?? workspaceSession.controlPlaneSessionId,
    ...(projectTitle ? { sessionTitle: projectTitle } : {}),
    sessionStatus: "idle",
    tasks,
  });
}

function addCompactTaskViews(output: SparkTaskView[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) addCompactTaskView(output, entry);
}

function addCompactTaskView(output: SparkTaskView[], value: unknown): void {
  if (!isRecord(value)) return;
  const ref = stringField(value, "ref");
  const title = stringField(value, "title");
  const status = stringField(value, "status");
  if (!ref || !title || !status || output.some((task) => task.ref === ref)) return;
  const todosRecord = isRecord(value.todos) ? value.todos : undefined;
  const todoItems = Array.isArray(todosRecord?.items) ? todosRecord.items : [];
  output.push({
    version: SPARK_PROTOCOL_VERSION,
    ref,
    ...(stringField(value, "name") ? { name: stringField(value, "name") } : {}),
    title,
    ...(stringField(value, "kind") ? { kind: stringField(value, "kind") } : {}),
    status,
    ...(stringField(value, "projectRef") ? { projectRef: stringField(value, "projectRef") } : {}),
    ...(stringField(value, "owner") ? { owner: stringField(value, "owner") } : {}),
    todos: todoItems.filter(isRecord).map((todo) => ({
      id: stringField(todo, "id") ?? "todo",
      content: stringField(todo, "content") ?? "todo",
      status: sparkTaskTodoStatus(stringField(todo, "status")),
      notes: [],
    })),
    runRefs: [],
    artifactRefs: [],
    metadata: {},
  });
}

function sparkTaskTodoStatus(value: string | undefined): SparkTaskView["todos"][number]["status"] {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "done" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "pending";
}

function parseFirstJsonContent(
  content: Array<{ type: "text"; text: string }>,
): Record<string, unknown> | undefined {
  const text = content.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readRequired(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readMode(value: string | undefined): SparkCliMode {
  if (value === "text" || value === "json" || value === "rpc") return value;
  throw new Error(`--mode must be text, json, or rpc`);
}

function readThinkingLevel(
  value: string | undefined,
): NonNullable<SparkCliRuntimeOptions["thinking"]> {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error("--thinking must be off, minimal, low, medium, high, or xhigh");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runSparkCli(
  argv: string[] = process.argv.slice(2),
  options: RunSparkCliOptions = {},
): Promise<number> {
  const command = parseSparkCliCommand(argv);
  const daemonClient = options.daemonClient ?? {};
  switch (command.kind) {
    case "help":
      printHelp();
      return 0;
    case "daemon":
      return await runSparkDaemonCliCommand(command.command, undefined, daemonClient);
    case "error":
      throw new Error(command.message);
    case "resources": {
      const result = await runSparkResourceCommand(command.action, command.source, {
        kind: command.resourceKind,
        local: command.local,
      });
      console.log(
        command.json ? JSON.stringify(result, null, 2) : formatSparkResourceResult(result),
      );
      return 0;
    }
    case "list-models": {
      const createHostServices = options.createHostServices ?? createSparkCliHostServices;
      const services = await createHostServices(
        await hostServiceOptionsFromRuntime(command.options),
      );
      console.log(formatSparkModelList(services, command.query));
      return 0;
    }
    case "rpc":
      await runSparkRpcMode(daemonClient, command.options);
      return 0;
    case "print": {
      const sessionId =
        command.options?.sessionId ??
        command.options?.session ??
        `spark-print-${Date.now().toString(36)}`;
      const lease = await attachSparkWorkspaceClient(daemonClient, {
        kind: "headless",
        displayName: tuiCliStrings.headlessDisplayName,
        heartbeatIntervalMs: false,
      });
      try {
        await ensureSparkDaemonWorkspaceSession(
          {
            sessionId,
            workspaceId: lease.workspace.id,
            cwd: lease.workspace.localPath,
          },
          daemonClient,
        );
        const result = await handleSparkDaemonCliCommand(
          {
            action: "submit",
            json: true,
            sessionId,
            prompt: command.prompt,
            reset: command.options?.noSession,
          },
          daemonClient,
        );
        if (command.mode === "json") printSparkJsonEventStream(command.prompt, sessionId, result);
        else console.log(JSON.stringify(result, null, 2));
        return 0;
      } finally {
        await lease.release();
      }
    }
    case "tui": {
      if (!isInteractiveSparkCliTerminal(options) && (options.terminal || !options.runTui)) {
        console.error(tuiCliStrings.tuiRequiresTty);
        return 2;
      }
      const lease = await attachSparkWorkspaceClient(daemonClient, {
        kind: "interactive",
        displayName: tuiCliStrings.interactiveDisplayName,
      });
      try {
        const createHostServices = options.createHostServices ?? createSparkCliHostServices;
        let pendingNativeUiTransport: ReturnType<typeof createSparkNativeUiTransport> | undefined;
        const services = await createHostServices({
          ...(await hostServiceOptionsFromRuntime(command.options)),
          sessionSource: "tui",
          hasUI: true,
          modelPicker: (state, ctx) =>
            pendingNativeUiTransport
              ? createSparkModelPickerFromCustomUi(
                  pendingNativeUiTransport as SparkModelSelectorCustomUi,
                )(state, ctx)
              : undefined,
        });
        registerSparkSessionsCommand(services.runtime, {
          store: services.sessionStore,
          getNavigationState: () => undefined,
          listTextProvider: () =>
            daemonSparkSessionListText(services, daemonClient, {
              workspaceId: lease.workspace.id,
              workspaceLabel: `${lease.workspace.displayName} • ${services.cwd}`,
            }),
        });
        let activeModelControl: SparkDaemonModelAuthClient | undefined;
        const modelControl = createDelegatingSparkDaemonModelAuthClient(() => activeModelControl);
        registerSparkNativeModelCommand(services, modelControl);
        registerSparkDaemonModelKeybindings(services, modelControl);
        const selectSession = options.selectSession ?? runNativeSparkSessionSelector;
        const runTui = options.runTui ?? runNativeSparkTui;
        let selectionOptions = command.options;
        let currentSessionOptions: SparkCliRuntimeOptions | undefined;
        let initialMessage = command.initialMessage;
        let hasLaunchedTui = false;

        while (true) {
          const selectedSession = await selectSparkCliWorkspaceSession(
            services,
            lease,
            selectionOptions,
            daemonClient,
            selectSession,
          );
          if (selectedSession.cancelled) {
            if (!currentSessionOptions) return 0;
            selectionOptions = currentSessionOptions;
            continue;
          }

          const workspaceSession = selectedSession.resolution;
          const currentSessionId = workspaceSession.state.attachTarget;
          if (!currentSessionId) {
            throw new Error("Spark TUI requires a selected daemon-managed session.");
          }
          currentSessionOptions = runtimeOptionsForSparkSession(command.options, currentSessionId);
          services.runtime.setSessionId(currentSessionId);

          const selectedManagedSession = selectedSession.session;
          const sessionWorkspaceId =
            selectedManagedSession?.scope.kind === "workspace"
              ? selectedManagedSession.scope.workspaceId
              : lease.workspace.id;
          const sessionCwd = selectedManagedSession?.cwd ?? services.cwd;
          let currentSessionReady: Promise<void> | undefined;
          const ensureCurrentSession = () => {
            currentSessionReady ??= (
              selectedManagedSession
                ? Promise.resolve()
                : ensureSparkDaemonWorkspaceSession(
                    {
                      sessionId: currentSessionId,
                      workspaceId: sessionWorkspaceId,
                      cwd: sessionCwd,
                    },
                    daemonClient,
                  )
            ).catch((error) => {
              currentSessionReady = undefined;
              throw error;
            });
            return currentSessionReady;
          };
          const firstRunOnboarding =
            hasLaunchedTui || initialMessage || (!selectedSession.created && selectedManagedSession)
              ? undefined
              : renderSparkFirstRunOnboarding(services);
          let sessionStatusModel =
            modelRefToSelection(selectedSession.snapshot?.model) ??
            services.modelSelector.getActive();
          let sessionStatusThinkingLevel =
            selectedSession.snapshot?.thinkingLevel ?? services.config.activeThinkingLevel;
          const daemonModelControl = createSparkDaemonModelAuthClient(daemonClient, {
            sessionId: currentSessionId,
            ensureSession: ensureCurrentSession,
          });
          activeModelControl = {
            ...daemonModelControl,
            snapshot: async () => {
              const snapshot = await daemonModelControl.snapshot();
              sessionStatusModel =
                modelRefToSelection(snapshot.session?.model ?? snapshot.defaultModel) ??
                sessionStatusModel;
              sessionStatusThinkingLevel =
                snapshot.session?.thinkingLevel ?? sessionStatusThinkingLevel;
              return snapshot;
            },
            setSessionModel: async (model) => {
              const session = await daemonModelControl.setSessionModel(model);
              sessionStatusModel = modelRefToSelection(session.model ?? model);
              return session;
            },
            setSessionThinkingLevel: async (thinkingLevel) => {
              const session = await daemonModelControl.setSessionThinkingLevel(thinkingLevel);
              sessionStatusThinkingLevel = session.thinkingLevel ?? thinkingLevel;
              return session;
            },
          };
          let sessionSelectorRequested = false;
          await runTui({
            initialMessage,
            responder: createSparkDaemonNativeResponder(daemonClient, {
              sessionId: currentSessionId,
              workspaceId: sessionWorkspaceId,
              cwd: sessionCwd,
              ensureSession: ensureCurrentSession,
              onViewEvent: (event) => {
                if (event.type === "run.update") pendingNativeUiTransport?.publishView?.(event);
              },
              onInteractionRequest: async (request, event, interactionContext) => {
                const interaction = pendingNativeUiTransport?.interaction;
                if (!interaction) {
                  throw new Error("Spark TUI interaction surface is not ready for this request.");
                }
                await handleSparkDaemonHumanInteractionRequest(request, event, {
                  currentSessionId,
                  client: daemonClient,
                  ...(interactionContext.signal ? { signal: interactionContext.signal } : {}),
                  interaction,
                  notify: (message, level) => pendingNativeUiTransport?.notify?.(message, level),
                });
              },
            }),
            workspaceSession: workspaceSession.state,
            slashCommands: createSparkNativeSlashCommands(
              services,
              daemonClient,
              modelControl,
              currentSessionId,
              ensureCurrentSession,
              () => {
                sessionSelectorRequested = true;
              },
            ),
            autocompleteBasePath: sessionCwd,
            keybindings: services.keybindings,
            statusContext: {
              activeProvider: () => sessionStatusModel?.providerName,
              activeModel: () => sessionStatusModel?.modelId,
              thinkingLevel: () => sessionStatusThinkingLevel ?? "default",
              autoCompactionEnabled: () => true,
              contextWindow: () => {
                const active = sessionStatusModel;
                return active
                  ? services.providerRegistry
                      .listModelsFor(active.providerName)
                      .find((model) => model.id === active.modelId)?.contextWindow
                  : undefined;
              },
            },
            theme: services.theme,
            messageRenderers: new Map(
              services.runtime
                .listMessageRenderers()
                .map(({ customType, renderer }) => [customType, renderer]),
            ),
            configureApp: async (app, session) => {
              pendingNativeUiTransport = createSparkNativeUiTransport(app, session);
              services.runtime.setUiTransport(pendingNativeUiTransport);
              app.setWorkspaceSession(workspaceSession.state);
              if (selectedSession.snapshot) {
                app.applyViewModelEvent({
                  version: SPARK_PROTOCOL_VERSION,
                  type: "session.snapshot",
                  session: selectedSession.snapshot,
                });
              }
              if (workspaceSession.attachMatchesControlPlane) {
                await hydrateNativeCockpitFromTaskRead(services, app, workspaceSession.state);
              }
              if (workspaceSession.shouldEmitSessionStart) {
                await services.runtime.emit("session_start", {
                  source: "native-tui",
                  workspaceDir: workspaceSession.state.workspaceDir,
                  workspaceHash: workspaceSession.state.workspaceHash,
                  controlPlaneSessionId: workspaceSession.state.controlPlaneSessionId,
                  attachTarget: workspaceSession.target,
                });
              }
              if (firstRunOnboarding) {
                session.addCustomMessage({
                  customType: "first-run-onboarding",
                  content: firstRunOnboarding,
                  display: true,
                });
              }
            },
          });
          initialMessage = undefined;
          hasLaunchedTui = true;
          pendingNativeUiTransport = undefined;
          if (!sessionSelectorRequested) return 0;
          selectionOptions = runtimeOptionsWithoutSparkSessionTarget(command.options);
        }
      } finally {
        await lease.release();
      }
    }
  }
}

function isInteractiveSparkCliTerminal(options: RunSparkCliOptions): boolean {
  return Boolean(
    (options.terminal?.stdinIsTTY ?? processStdin.isTTY) &&
    (options.terminal?.stdoutIsTTY ?? processStdout.isTTY),
  );
}

const NATIVE_SLASH_COMMAND_EXCLUSIONS = [
  "help",
  "exit",
  "quit",
  "clear",
  "reload",
  "stop",
  "retry",
  "cockpit",
  "workflows",
  "runs",
  "run",
  "tasks",
  "task",
  "artifacts",
  "artifact",
  "evidence",
  "reviews",
  "review",
  "graft",
] as const;

function registerSparkNativeModelCommand(
  services: SparkCliHostServices,
  modelControl?: SparkDaemonModelAuthClient,
): void {
  if (services.runtime.getCommand("model")) return;
  services.runtime.registerCommand("model", {
    description: tuiCliStrings.modelCommandDescription,
    argumentHint: tuiCliStrings.modelCommandArgumentHint,
    metadata: {
      source: "extension",
      extensionId: "spark-model",
      plane: "tui",
      resource: "model",
      verbs: ["select", "status"],
      canonicalCliTarget: "spark tui --model <model-id>",
    },
    getArgumentCompletions: (prefix) => modelArgumentCompletions(services, prefix),
    async handler(args, ctx) {
      const selection = await handleSparkNativeModelCommand(services, args, modelControl);
      ctx.ui?.notify?.(formatSparkModelSelection(selection), "info");
    },
  });
}

async function handleSparkNativeModelCommand(
  services: SparkCliHostServices,
  args: string,
  modelControl?: SparkDaemonModelAuthClient,
): Promise<SparkActiveSelection> {
  if (modelControl) {
    const snapshot = await modelControl.snapshot();
    const query = args.trim();
    const selection = query
      ? resolveDaemonModelSelection(snapshot, query)
      : await services.modelSelector.pick(daemonSnapshotToPickerState(snapshot), { hasUI: true });
    const active =
      selection ?? modelRefToSelection(snapshot.session?.model ?? snapshot.defaultModel);
    if (!active) throw new Error(tuiCliStrings.noActiveModel);
    await modelControl.setSessionModel(active);
    synchronizeLocalModelSelection(services, active);
    return active;
  }
  const query = args.trim();
  if (query) return await services.modelSelector.select(resolveSparkModelArgument(services, query));
  const picked = await services.modelSelector.openPicker({ hasUI: true });
  const active = picked ?? services.modelSelector.getActive();
  if (!active) throw new Error(tuiCliStrings.noActiveModel);
  return active;
}

function registerSparkDaemonModelKeybindings(
  services: SparkCliHostServices,
  modelControl: SparkDaemonModelAuthClient,
): void {
  const keybindings = services.keybindings as SparkCliHostServices["keybindings"] & {
    register?: SparkCliHostServices["keybindings"]["register"];
  };
  if (typeof keybindings.register !== "function") return;
  const notify = (selection: SparkActiveSelection | undefined) => {
    if (selection) {
      services.runtime.makeContext().ui?.notify?.(formatSparkModelSelection(selection), "info");
    }
  };
  keybindings.register({
    id: SPARK_MODEL_PICKER_BINDING_ID,
    defaultKey: "ctrl+l",
    description: "Open the model selector",
    handler: async (ctx) => {
      const snapshot = await modelControl.snapshot();
      const selection = await services.modelSelector.pick(
        daemonSnapshotToPickerState(snapshot),
        ctx,
      );
      if (!selection) return;
      await modelControl.setSessionModel(selection);
      synchronizeLocalModelSelection(services, selection);
      notify(selection);
    },
  });
  registerDaemonModelCycleKeybinding(
    services,
    modelControl,
    SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
    "ctrl+p",
    "next",
    notify,
  );
  registerDaemonModelCycleKeybinding(
    services,
    modelControl,
    SPARK_MODEL_CYCLE_PREV_BINDING_ID,
    "shift+ctrl+p",
    "prev",
    notify,
  );
  services.keybindings.register({
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle the assistant thinking level (off/minimal/low/medium/high/xhigh)",
    handler: async () => {
      const snapshot = await modelControl.snapshot();
      const next = cycleThinkingLevel(
        snapshot.session?.thinkingLevel ?? services.config.activeThinkingLevel,
      );
      await modelControl.setSessionThinkingLevel(next);
      services.runtime
        .makeContext()
        .ui?.notify?.(sparkTuiPiParityStrings().thinkingLevelSet(next), "info");
    },
  });
}

function registerDaemonModelCycleKeybinding(
  services: SparkCliHostServices,
  modelControl: SparkDaemonModelAuthClient,
  id: string,
  defaultKey: string,
  direction: "next" | "prev",
  notify: (selection: SparkActiveSelection | undefined) => void,
): void {
  services.keybindings.register({
    id,
    defaultKey,
    description: `Cycle to the ${direction} Spark model`,
    handler: async () => {
      const snapshot = await modelControl.snapshot();
      const items = daemonSnapshotToPickerState(snapshot).items;
      if (items.length === 0) return;
      const effectiveModel = snapshot.session?.model ?? snapshot.defaultModel;
      const activeValue = effectiveModel
        ? `${effectiveModel.providerName}/${effectiveModel.modelId}`
        : undefined;
      const activeIndex = activeValue ? items.findIndex((item) => item.value === activeValue) : -1;
      const step = direction === "next" ? 1 : -1;
      const index =
        activeIndex < 0
          ? direction === "next"
            ? 0
            : items.length - 1
          : (activeIndex + step + items.length) % items.length;
      const item = items[index]!;
      const selection = { providerName: item.providerName, modelId: item.modelId };
      await modelControl.setSessionModel(selection);
      synchronizeLocalModelSelection(services, selection);
      notify(selection);
    },
  });
}

function synchronizeLocalModelSelection(
  services: SparkCliHostServices,
  selection: SparkActiveSelection,
): void {
  try {
    services.providerRegistry.setActive(selection);
  } catch {
    // The daemon catalog is authoritative; a presentation adapter may have a narrower catalog.
  }
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function cycleThinkingLevel(current: SparkThinkingLevel | undefined): SparkThinkingLevel {
  const index = current ? THINKING_LEVELS.indexOf(current) : -1;
  return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
}

function modelRefToSelection(
  model: { providerName: string; modelId: string } | undefined,
): SparkActiveSelection | undefined {
  return model ? { providerName: model.providerName, modelId: model.modelId } : undefined;
}

function createDelegatingSparkDaemonModelAuthClient(
  getCurrent: () => SparkDaemonModelAuthClient | undefined,
): SparkDaemonModelAuthClient {
  const current = (): SparkDaemonModelAuthClient => {
    const client = getCurrent();
    if (!client) throw new Error("No active Spark session is selected.");
    return client;
  };
  return {
    snapshot: () => current().snapshot(),
    setSessionModel: (model) => current().setSessionModel(model),
    setSessionThinkingLevel: (thinkingLevel) => current().setSessionThinkingLevel(thinkingLevel),
    setDefaultModel: (model) => current().setDefaultModel(model),
    setApiKey: (providerName, apiKey) => current().setApiKey(providerName, apiKey),
    logout: (providerName) => current().logout(providerName),
    startOAuth: (providerName) => current().startOAuth(providerName),
    oauthStatus: (flowId) => current().oauthStatus(flowId),
    respondOAuth: (flowId, promptId, value) => current().respondOAuth(flowId, promptId, value),
    cancelOAuth: (flowId) => current().cancelOAuth(flowId),
  };
}

function resolveSparkModelArgument(
  services: SparkCliHostServices,
  query: string,
): SparkActiveSelection {
  return resolveSparkModelSelectionById(services.providerRegistry, query);
}

function modelArgumentCompletions(
  services: SparkCliHostServices,
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const normalized = prefix.trim().toLowerCase();
  return modelCompletionItems(services.modelSelector.getPickerState())
    .filter((item) =>
      [item.value, item.label, item.description ?? ""].some((text) =>
        text.toLowerCase().includes(normalized),
      ),
    )
    .slice(0, 25);
}

function modelCompletionItems(
  state: SparkModelPickerState,
): Array<{ value: string; label: string; description?: string }> {
  return state.items.map((item) => ({
    value: item.value,
    label: `${item.modelLabel}${item.active ? tuiCliStrings.activeModelSuffix : ""}`,
    description: item.description,
  }));
}

function createSparkNativeSlashCommands(
  services: SparkCliHostServices,
  daemonClient: SparkDaemonClientOptions,
  modelControl: SparkDaemonModelAuthClient,
  currentSessionId: string,
  ensureCurrentSession: () => Promise<void>,
  requestSessionSelector: () => void,
): SparkNativeSlashCommandMap {
  const daemonCommands = createSparkDaemonNativeCommands(daemonClient);
  const localControlCommands = createSparkNativeLocalControlSlashCommands();
  const piParityCommands = createSparkPiParitySlashCommands(services, modelControl);
  const runtimeCommands = createSparkNativeRuntimeSlashCommands(services.runtime, {
    exclude: [
      ...NATIVE_SLASH_COMMAND_EXCLUSIONS,
      ...Object.keys(daemonCommands),
      ...Object.keys(localControlCommands),
      ...PI_PARITY_COMMAND_NAMES,
    ],
    sendUserMessage: async (content, context) => {
      const prompt = content.trim();
      if (!prompt) return;
      await ensureCurrentSession();
      await context.session.submit(prompt);
    },
  });
  const sessionsCommand = runtimeCommands.sessions;
  if (sessionsCommand) {
    runtimeCommands.sessions = {
      ...sessionsCommand,
      description: "Open the session selector or run an explicit session subcommand",
      handler: async (args, context) => {
        if (args.trim()) {
          await sessionsCommand.handler(args, context);
          return;
        }
        requestSessionSelector();
        context.exit();
      },
    };
  }
  const promptTemplateCommands = createSparkPromptTemplateSlashCommands(services, {
    reservedNames: [
      ...NATIVE_SLASH_COMMAND_EXCLUSIONS,
      ...Object.keys(runtimeCommands),
      ...Object.keys(daemonCommands),
      ...Object.keys(localControlCommands),
      ...Object.keys(piParityCommands),
    ],
  });
  return {
    ...runtimeCommands,
    ...daemonCommands,
    ...localControlCommands,
    ...piParityCommands,
    ...promptTemplateCommands,
  };
}

async function hostServiceOptionsFromRuntime(
  options: SparkCliRuntimeOptions | undefined,
): Promise<SparkCliHostServicesOptions> {
  if (!options) return {};
  const config = await configFromRuntimeOptions(options);
  return {
    ...(config ? { config } : {}),
    ...(options.sessionDir
      ? { sparkHome: options.sessionDir, sparkStateRoot: options.sessionDir }
      : {}),
    ...(explicitSparkSessionKey(options)
      ? { sessionManager: { getLeafId: () => explicitSparkSessionKey(options) } }
      : {}),
    ...(options.noPromptTemplates ? { noPromptTemplates: true } : {}),
  };
}

function explicitSparkSessionKey(options: SparkCliRuntimeOptions): string | undefined {
  const key = options.sparkSessionKey?.trim();
  if (key) return key;
  const sessionId = options.sessionId?.trim();
  return sessionId ? `session:${sessionId}` : undefined;
}

async function configFromRuntimeOptions(
  options: SparkCliRuntimeOptions,
): Promise<SparkConfig | undefined> {
  const needsConfig = Boolean(
    options.provider ||
    options.model ||
    options.thinking ||
    options.extensions?.length ||
    options.noExtensions ||
    options.skills?.length ||
    options.noSkills ||
    options.promptTemplates?.length ||
    options.noPromptTemplates ||
    options.themes?.length ||
    options.noThemes,
  );
  if (!needsConfig) return undefined;
  const config = await loadSparkConfig();
  if (options.provider && options.model) {
    config.activeModelId = `${options.provider}/${options.model}`;
    delete config.activeProvider;
    delete config.activeModel;
  } else if (options.model) {
    config.activeModelId = options.model;
    delete config.activeProvider;
    delete config.activeModel;
  } else if (options.provider) {
    config.activeProvider = options.provider;
  }
  if (options.thinking) config.activeThinkingLevel = options.thinking;
  if (options.noExtensions) config.extensions = [];
  if (options.extensions?.length)
    config.extensions = appendUnique(config.extensions, options.extensions);
  if (options.noSkills) config.skills = [];
  if (options.skills?.length) config.skills = appendUnique(config.skills ?? [], options.skills);
  if (options.noPromptTemplates) config.promptTemplates = [];
  if (options.promptTemplates?.length)
    config.promptTemplates = appendUnique(config.promptTemplates ?? [], options.promptTemplates);
  if (options.noThemes) config.themes = [];
  if (options.themes?.length) config.themes = appendUnique(config.themes ?? [], options.themes);
  return config;
}

function appendUnique(existing: string[], additions: readonly string[]): string[] {
  return [...new Set([...existing, ...additions])];
}

function formatSparkModelList(services: SparkCliHostServices, query: string | undefined): string {
  const normalized = query?.toLowerCase();
  const rows = services.modelSelector
    .getPickerState()
    .items.filter((item) =>
      normalized
        ? `${item.value} ${item.modelId} ${item.modelLabel} ${item.description}`
            .toLowerCase()
            .includes(normalized)
        : true,
    );
  if (rows.length === 0)
    return query ? tuiCliStrings.noModelsMatching(query) : tuiCliStrings.noModelsRegistered;
  return rows
    .map((row) => {
      const marker = row.active ? "*" : " ";
      return `${marker} ${row.value} — ${row.modelLabel} (${row.description})`;
    })
    .join("\n");
}

function printSparkJsonEventStream(
  prompt: string,
  sessionId: string,
  result: unknown,
  assistantText = tuiCliStrings.headlessAccepted,
): void {
  const timestamp = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: process.cwd() },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "queue_update", steering: [], followUp: [prompt] },
    {
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
      toolResults: [],
      result,
    },
    { type: "agent_end", messages: [] },
  ];
  for (const line of lines) console.log(JSON.stringify(line));
}

export interface SparkRpcState {
  lastInvocationId?: string;
}

async function runSparkRpcMode(
  daemonClient: SparkDaemonClientOptions,
  options: SparkCliRuntimeOptions | undefined,
): Promise<void> {
  writeRpc({
    type: "response",
    command: "ready",
    success: true,
    data: { protocol: "spark-rpc-jsonl", mode: "daemon" },
  });
  const state: SparkRpcState = {};
  let buffered = "";
  for await (const chunk of processStdin) {
    buffered += String(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (line.trim()) await handleSparkRpcLine(line, daemonClient, options, writeRpc, state);
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.trim())
    await handleSparkRpcLine(buffered.replace(/\r$/u, ""), daemonClient, options, writeRpc, state);
}

export async function handleSparkRpcLine(
  line: string,
  daemonClient: SparkDaemonClientOptions,
  options: SparkCliRuntimeOptions | undefined,
  writer: (value: Record<string, unknown>) => void = writeRpc,
  state: SparkRpcState = {},
): Promise<void> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    writer({ type: "response", command: "parse", success: false, error: errorMessage(error) });
    return;
  }
  const id = typeof request.id === "string" ? request.id : undefined;
  const command = typeof request.type === "string" ? request.type : "unknown";
  try {
    if (command === "prompt" || command === "steer" || command === "follow_up") {
      const message = typeof request.message === "string" ? request.message : "";
      if (!message) throw new Error(tuiCliStrings.rpcRequiresMessage(command));
      const sessionId =
        options?.sessionId ?? options?.session ?? `spark-rpc-${Date.now().toString(36)}`;
      const result = await handleSparkDaemonCliCommand(
        { action: "submit", json: true, sessionId, prompt: message },
        daemonClient,
      );
      const invocationId = invocationIdFromSubmitResult(result);
      if (invocationId) state.lastInvocationId = invocationId;
      writer({ id, type: "response", command, success: true, data: result });
      return;
    }
    if (command === "get_state") {
      const state = await handleSparkDaemonCliCommand(
        { action: "status", json: true },
        daemonClient,
      );
      writer({ id, type: "response", command, success: true, data: state });
      return;
    }
    if (command === "get_messages") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { messages: [] },
      });
      return;
    }
    if (command === "abort") {
      const invocationId = rpcAbortInvocationId(request) ?? state.lastInvocationId;
      if (!invocationId) {
        if (daemonClient.paths) {
          writer({
            id,
            type: "response",
            command,
            success: true,
            data: { queuedDaemonMode: true },
          });
          return;
        }
        writer({
          id,
          type: "response",
          command,
          success: false,
          error: "abort requires invocationId or a prior submitted turn",
        });
        return;
      }
      const result = await clientCancelTurn(
        {
          invocationId,
          reason: "Spark RPC abort requested by client.",
        },
        daemonClient,
      );
      if (state.lastInvocationId === invocationId) state.lastInvocationId = undefined;
      writer({
        id,
        type: "response",
        command,
        success: result.cancelRequested,
        data: result,
        ...(result.cancelRequested
          ? {}
          : { error: `Invocation ${invocationId} was not cancelled` }),
      });
      return;
    }
    if (command === "new_session") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { queuedDaemonMode: true },
      });
      return;
    }
    writer({
      id,
      type: "response",
      command,
      success: false,
      error: tuiCliStrings.unsupportedRpcCommand(command),
    });
  } catch (error) {
    writer({ id, type: "response", command, success: false, error: errorMessage(error) });
  }
}

function invocationIdFromSubmitResult(result: unknown): string | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const submit = record.result;
  if (!submit || typeof submit !== "object") return undefined;
  const submitRecord = submit as Record<string, unknown>;
  return typeof submitRecord.invocationId === "string" ? submitRecord.invocationId : undefined;
}

function rpcAbortInvocationId(request: Record<string, unknown>): string | undefined {
  const value = request.invocationId;
  if (typeof value === "string" && value.trim()) return value.trim();
  const nested = request.data ?? request.params;
  if (nested && typeof nested === "object") {
    return rpcAbortInvocationId(nested as Record<string, unknown>);
  }
  return undefined;
}

function writeRpc(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(tuiCliStrings.helpText);
}

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runSparkCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
