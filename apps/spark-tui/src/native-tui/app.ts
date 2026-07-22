/** SparkNativeTuiApp — native pi-tui host surface (input, slash, ask, render, cockpit). */

import { homedir } from "node:os";

import {
  SparkAskFlowController,
  type RenderTheme as AskRenderTheme,
  type SparkAskFlowResult,
} from "@zendev-lab/spark-ask";
import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  parseSparkInteractionResponse,
  parseSparkViewModelEvent,
  sparkSlashActionBarForInput,
  type SparkActionBarView,
  type SparkActionView,
  type SparkArtifactView,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkRunView,
  type SparkSessionView,
  type SparkTaskView,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  Markdown,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type DefaultTextStyle,
  type Focusable,
  type SlashCommand,
  type TUI,
} from "../tui/pi-tui-adapter.ts";
import type { SparkKeybindingContext, SparkKeybindings } from "../host/keybindings.ts";
import {
  createSparkHostRenderTheme,
  createSparkMarkdownTheme,
  styleSparkDiffLine,
  styleSparkRoleLine,
  type SparkTheme,
} from "../host/theme.ts";
import type {
  SparkHostCustomMessage,
  SparkHostMessageRenderer,
  SparkHostRenderTheme,
} from "../host/types.ts";
import {
  createSparkTuiActionBarComponent,
  type SparkTuiActionAvailability,
  type SparkTuiActionBarComponent,
} from "../tui/action-bar.ts";
import type { SparkModelSelectorTheme, SparkModelSelectorTuiLike } from "../tui/model-selector.ts";

import {
  channelQuotePreviewFromDetails,
  compactToolPreview,
  canonicalToolStatus,
  stringFromRecord,
  toolStatusColor,
  toolStatusIcon,
  userSenderLabelFromDetails,
} from "./message-view.ts";
import {
  addFooterMetrics,
  footerMetricsFromRecord,
  footerMetricsFromRun,
  formatFooterMetrics,
  mergeFooterMetrics,
  runTimeMs,
} from "./footer-metrics.ts";
import {
  compareRunsForCockpit,
  createSparkNativeCockpitState,
  cockpitTaskDeepLink,
  graftSummaryFromRecord,
  isDoneTaskStatus,
  isReviewArtifact,
  isSparkNativeCockpitPanel,
  isSparkNativeLocalControlCommand,
  workflowRunControlHints,
  workflowRunDisplayStatus,
} from "./cockpit-helpers.ts";
import {
  compactNativeQueuePreview,
  parseBangCommand,
  prepareSparkNativeEditorInput,
  runSparkNativeBangCommand,
} from "./editor-input.ts";
import {
  createSparkNativeLocalControlSlashCommands,
  nativeKernelSlashCommandEntries,
  parseSlashCommand,
} from "./slash-commands.ts";
import {
  createNativeWidgetComponent,
  normalizeNativeWidgetLines,
  renderNativeWidgetComponent,
} from "./widgets.ts";
import { nativeAskAnswers, nativeAskFlowRequest, nativeAskLanguage } from "./ask-helpers.ts";
import {
  createEditorTheme,
  DEFAULT_NATIVE_THEME,
  isOverlayRequest,
  isSparkAppKey,
} from "./theme-helpers.ts";
import {
  NATIVE_WORKING_SPINNER_FRAMES,
  NATIVE_WORKING_SPINNER_INTERVAL_MS,
  nativeTuiStrings,
} from "./strings.ts";
import { SparkNativeSession } from "./session.ts";
import {
  MAX_NATIVE_QUEUE_ITEMS,
  MAX_COCKPIT_PANEL_ROWS,
  SPARK_COCKPIT_PANELS,
  type SparkNativeCockpitPanel,
  type SparkNativeCockpitSnapshot,
  type SparkNativeFooterMetrics,
  type SparkNativeInteractionHandler,
  type SparkNativeMessage,
  type SparkNativeMessageRole,
  type SparkNativeQueueMode,
  type SparkNativeSlashCommandMap,
  type SparkNativeStatusContext,
  type SparkNativeToolStatus,
  type SparkNativeTuiAppOptions,
  type SparkNativeWidget,
  type SparkNativeWorkspaceSessionState,
} from "./types.ts";

type NativeWidgetFactory = (
  tui: { terminal: { columns: number }; requestRender(): void },
  theme: SparkHostRenderTheme,
) => Component | { render(width?: number): string[]; invalidate?(): void } | undefined;

export class SparkNativeTuiApp implements Component, Focusable {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly session: SparkNativeSession;
  private readonly onExit: () => void;
  private readonly messageRenderers: ReadonlyMap<string, SparkHostMessageRenderer>;
  private readonly keybindings?: SparkKeybindings;
  private readonly keybindingContext: SparkKeybindingContext;
  private readonly slashCommands: SparkNativeSlashCommandMap;
  private readonly interactionHandler?: SparkNativeInteractionHandler;
  private readonly statusContext?: SparkNativeStatusContext;
  private readonly inputBasePath: string;
  private readonly theme: SparkTheme;
  private readonly renderTheme: SparkHostRenderTheme;
  private workspaceSession?: SparkNativeWorkspaceSessionState;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, SparkNativeWidget>();
  private readonly cockpit = createSparkNativeCockpitState();
  private readonly completedTaskSummaryKeys = new Set<string>();
  private readonly presentedAskRequestIds = new Set<string>();
  private activeCockpitPanel: SparkNativeCockpitPanel | undefined;
  private activeActionBarView: SparkActionBarView | undefined;
  private activeActionBar: SparkTuiActionBarComponent | undefined;
  private actionBarHandle: { hide(): void } | undefined;
  private sessionFooterMetrics: SparkNativeFooterMetrics = {};
  private readonly runFooterMetrics = new Map<string, SparkNativeFooterMetrics>();
  private focusedValue = false;
  private toolsExpanded = false;
  private thinkingExpanded = false;
  private workingSpinnerFrame = 0;
  private workingSpinnerTimer: ReturnType<typeof setInterval> | undefined;
  private readonly handleSessionChange = () => {
    this.syncWorkingSpinner();
    this.invalidate();
    this.tui.requestRender();
  };

  constructor(
    tui: TUI,
    session: SparkNativeSession,
    onExit: () => void,
    options: SparkNativeTuiAppOptions = {},
  ) {
    this.tui = tui;
    this.session = session;
    this.onExit = onExit;
    this.messageRenderers = options.messageRenderers ?? new Map();
    this.keybindings = options.keybindings;
    this.keybindingContext = options.keybindingContext ?? { hasUI: true };
    this.slashCommands = {
      ...createSparkNativeLocalControlSlashCommands(),
      ...(options.slashCommands ?? {}),
    };
    this.interactionHandler = options.interactionHandler;
    this.statusContext = options.statusContext;
    this.inputBasePath = options.autocompleteBasePath ?? process.cwd();
    this.theme = options.theme ?? DEFAULT_NATIVE_THEME;
    this.renderTheme = createSparkHostRenderTheme(this.theme);
    this.workspaceSession = options.workspaceSession;
    this.registerToggleKeybindings(options.keybindings);
    this.editor = new Editor(tui, createEditorTheme(this.theme), { paddingX: 1 });
    this.installAutocompleteProvider(options);
    this.editor.onSubmit = (text) => {
      void this.submitEditorText(text, { mode: "steer" });
    };
    this.session.onChange = this.handleSessionChange;
    this.syncWorkingSpinner();
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.editor.focused = value;
  }

  dispose(): void {
    this.closeActionBar();
    if (this.session.onChange === this.handleSessionChange) this.session.onChange = undefined;
    this.stopWorkingSpinner();
  }

  setEditorText(text: string): void {
    if (this.editor.isShowingAutocomplete()) this.editor.handleInput(Key.escape);
    this.editor.setText(text);
    this.invalidate();
    this.tui.requestRender();
  }

  async executeSlashCommand(input: string): Promise<void> {
    await this.runSlashCommand(input);
  }

  actionBarSnapshot(): { id: string; selectedActionId?: string; focused: boolean } | undefined {
    if (!this.activeActionBarView || !this.activeActionBar) return undefined;
    return {
      id: this.activeActionBarView.id,
      selectedActionId: this.activeActionBar.selectedAction?.id,
      focused: this.activeActionBar.focused,
    };
  }

  renderQueueInspection(): string {
    const queued = this.session.queuedInputs;
    if (queued.length === 0) return "Turn queue is empty.";
    return [
      `Turn queue: ${queued.length} pending input${queued.length === 1 ? "" : "s"}`,
      ...queued.map(
        (input, index) =>
          `${index + 1}. ${input.mode === "followUp" ? "follow-up" : "steer"} — ${compactNativeQueuePreview(input.text)}`,
      ),
    ].join("\n");
  }

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete();
  }

  async submitInput(input: string): Promise<"started" | "queued" | "ignored" | "command"> {
    return await this.submitPreparedInput(input, { mode: "steer" });
  }

  private async submitEditorText(
    input: string,
    options: { mode: SparkNativeQueueMode },
  ): Promise<"started" | "queued" | "ignored" | "command"> {
    this.editor.addToHistory(input);
    this.editor.setText("");
    const result = await this.submitPreparedInput(input, options);
    this.invalidate();
    this.tui.requestRender();
    return result;
  }

  private async submitPreparedInput(
    input: string,
    options: { mode: SparkNativeQueueMode },
  ): Promise<"started" | "queued" | "ignored" | "command"> {
    const text = input.trim();
    if (!text) return await this.session.submit(input, options);
    // Host controls must bypass SparkNativeSession.submit: an active turn may queue prompts,
    // but it must never queue or swallow slash commands such as /model and /plan.
    if (text.startsWith("/") && !text.startsWith("//")) {
      await this.runSlashCommand(text);
      this.invalidate();
      this.tui.requestRender();
      return "command";
    }
    const bang = parseBangCommand(input);
    if (bang?.hidden) {
      const hiddenResult = await runSparkNativeBangCommand(bang.command, true, this.inputBasePath);
      this.session.addToolMessage({ toolName: "shell", text: hiddenResult, status: "success" });
      return "ignored";
    }
    try {
      const prepared = await prepareSparkNativeEditorInput(input, this.inputBasePath);
      return await this.session.submit(prepared, options);
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.inputPreparationFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
      return "ignored";
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.alt("enter"))) {
      void this.submitEditorText(this.editor.getExpandedText(), { mode: "followUp" });
      return;
    }
    if (this.handleCockpitPanelInput(data)) return;
    if (matchesKey(data, Key.escape)) {
      const restoredText = this.session.abort("escape").restoredText;
      if (restoredText) this.editor.setText(restoredText);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.alt("up"))) {
      const restoredText = this.session.restoreQueuedText();
      if (restoredText) {
        this.editor.setText(restoredText);
        this.session.addSystemMessage("Restored queued input to the editor.");
      } else {
        this.session.addSystemMessage(nativeTuiStrings.noQueuedInputToRestore);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.handleSparkKeybinding(data)) return;
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      this.onExit();
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.toggleTools();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toggleThinking();
      return;
    }
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  setWorkspaceSession(state: SparkNativeWorkspaceSessionState | undefined): void {
    this.workspaceSession = state;
    this.invalidate();
    this.tui.requestRender();
  }

  setStatus(key: string, text: string | undefined): void {
    if (!key) return;
    if (text === undefined || text.trim() === "") this.statuses.delete(key);
    else this.statuses.set(key, text);
    this.invalidate();
    this.tui.requestRender();
  }

  setWidget(
    key: string,
    content: unknown,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    if (!key) return;
    const placement = options?.placement ?? "aboveEditor";
    if (content === undefined || content === null || content === false) {
      this.widgets.delete(key);
    } else if (typeof content === "function") {
      const component = createNativeWidgetComponent(
        content as NativeWidgetFactory,
        this.tui,
        this.renderTheme,
        () => this.invalidate(),
      );
      if (!component) this.widgets.delete(key);
      else this.widgets.set(key, { key, component, placement });
    } else {
      const lines = normalizeNativeWidgetLines(content);
      if (lines.length === 0) this.widgets.delete(key);
      else this.widgets.set(key, { key, lines, placement });
    }
    this.invalidate();
    this.tui.requestRender();
  }

  cockpitSnapshot(): SparkNativeCockpitSnapshot {
    return {
      activePanel: this.activeCockpitPanel,
      sessionId: this.cockpit.sessionId,
      sessionStatus: this.cockpit.sessionStatus,
      workflows: this.cockpit.workflows.size,
      workflowRuns: [...this.cockpit.runs.values()].filter((run) => run.kind === "workflow").length,
      roleRuns: [...this.cockpit.runs.values()].filter((run) => run.kind === "role").length,
      tasks: this.cockpit.tasks.size,
      artifacts: this.cockpit.artifacts.size,
      evidence: this.cockpit.evidence.size,
      reviews: this.reviewItems().length,
      graftItems: this.graftItems().length,
      interactions: this.cockpit.interactions.size,
    };
  }

  toggleCockpitPanel(panel: SparkNativeCockpitPanel = "overview"): boolean {
    this.activeCockpitPanel = this.activeCockpitPanel === panel ? undefined : panel;
    if (this.activeCockpitPanel === "runs" || this.activeCockpitPanel === "workflows") {
      this.ensureWorkflowRunSelection();
    }
    this.invalidate();
    this.tui.requestRender();
    return this.activeCockpitPanel !== undefined;
  }

  cycleCockpitPanel(): SparkNativeCockpitPanel {
    const current = this.activeCockpitPanel ?? "overview";
    const index = SPARK_COCKPIT_PANELS.indexOf(current);
    const next = SPARK_COCKPIT_PANELS[(index + 1) % SPARK_COCKPIT_PANELS.length] ?? "overview";
    this.activeCockpitPanel = next;
    if (next === "runs" || next === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    return next;
  }

  private handleCockpitPanelInput(data: string): boolean {
    if (this.activeCockpitPanel !== "runs" && this.activeCockpitPanel !== "workflows") {
      return false;
    }
    if (matchesKey(data, Key.escape)) {
      this.activeCockpitPanel = undefined;
      this.invalidate();
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveWorkflowRunSelection(-1);
      return true;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.moveWorkflowRunSelection(1);
      return true;
    }
    if (matchesKey(data, Key.enter) || data === "i") {
      this.runSelectedWorkflowCommand("inspect");
      return true;
    }
    if (data === "p") {
      this.runSelectedWorkflowCommand("pause");
      return true;
    }
    if (data === "u") {
      this.runSelectedWorkflowCommand("resume");
      return true;
    }
    if (data === "x") {
      this.runSelectedWorkflowCommand("stop");
      return true;
    }
    if (data === "r") {
      this.runSelectedWorkflowCommand("restart");
      return true;
    }
    if (data === "s") {
      this.runSelectedWorkflowCommand("save");
      return true;
    }
    if (data === "a") {
      this.runSelectedWorkflowCommand("ack");
      return true;
    }
    return false;
  }

  private moveWorkflowRunSelection(delta: number): void {
    const runs = this.selectableWorkflowRuns();
    if (runs.length === 0) return;
    const selectedIndex = Math.max(
      0,
      runs.findIndex((run) => run.id === this.cockpit.selectedWorkflowRunId),
    );
    const nextIndex = (selectedIndex + delta + runs.length) % runs.length;
    this.cockpit.selectedWorkflowRunId = runs[nextIndex]?.id;
    this.invalidate();
    this.tui.requestRender();
  }

  private runSelectedWorkflowCommand(
    action: "inspect" | "pause" | "resume" | "stop" | "restart" | "save" | "ack",
  ): void {
    const run = this.selectedWorkflowRun();
    if (!run) {
      this.session.addSystemMessage(nativeTuiStrings.noWorkflowRunSelected);
      return;
    }
    if (!/^run:[a-zA-Z0-9-]+$/u.test(run.id)) {
      this.session.addSystemMessage(nativeTuiStrings.selectedWorkflowNotLive(run.id));
      return;
    }
    const commandName = `workflow-${action}`;
    if (!this.slashCommands[commandName]) {
      this.session.addSystemMessage(nativeTuiStrings.hostCommandNotRegistered(commandName));
      return;
    }
    void this.runSlashCommand(`/${commandName} ${run.id}`).finally(() => {
      this.invalidate();
      this.tui.requestRender();
    });
  }

  private openActionBar(view: SparkActionBarView): void {
    this.closeActionBar();
    const component = createSparkTuiActionBarComponent({
      view,
      theme: this.renderTheme,
      resolveAvailability: (action) => this.resolveActionAvailability(action),
      requestRender: () => this.tui.requestRender(),
      onCancel: () => this.closeActionBar(),
      onAction: async (action) => {
        this.closeActionBar();
        await this.executeActionBarAction(action);
      },
    });
    this.activeActionBarView = view;
    this.activeActionBar = component;
    if (typeof this.tui.showOverlay === "function") {
      this.actionBarHandle = this.tui.showOverlay(component, {
        width: "72%",
        minWidth: 44,
        maxHeight: 6,
        anchor: "bottom-center",
        margin: { bottom: 3, left: 1, right: 1 },
      });
    } else {
      this.tui.addChild(component);
      this.tui.setFocus(component);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private resolveActionAvailability(action: SparkActionView): SparkTuiActionAvailability {
    const requiredCommand = this.requiredActionCommand(action);
    if (requiredCommand && !this.slashCommands[requiredCommand]) {
      return {
        disabled: true,
        reason: `/${requiredCommand} is not registered in this host`,
      };
    }

    if (action.intent === "turn.retry" && !this.session.canRetry) {
      return {
        disabled: true,
        reason: this.session.isProcessing
          ? "wait for the active turn to finish"
          : "no previous prompt to retry",
      };
    }
    if (action.intent === "turn.stop" && !this.session.canStopOrRestore) {
      return { disabled: true, reason: "no active turn or queued input" };
    }
    if (action.intent === "workflow.inspect") {
      const selected = this.selectedWorkflowRun();
      if (!selected) return { disabled: true, reason: "no workflow run is selected" };
      if (!/^run:[a-zA-Z0-9-]+$/u.test(selected.id)) {
        return { disabled: true, reason: `selected workflow ${selected.id} is not live` };
      }
    }
    return { disabled: false };
  }

  private requiredActionCommand(action: SparkActionView): string | undefined {
    switch (action.intent) {
      case "model.select":
        return "model";
      case "thinking.select":
      case "settings.inspect":
        return "settings";
      case "settings.providers":
        return "login";
      case "status.inspect":
        return "status";
      case "session.select":
      case "session.create":
        return "sessions";
      case "session.inspect":
        return "session";
      case "turn.stop":
        return "stop";
      case "turn.retry":
        return "retry";
      case "goal.status":
      case "goal.start":
      case "goal.restart":
      case "goal.stop":
        return "goal";
      case "loop.status":
      case "loop.start":
      case "loop.restart":
      case "loop.stop":
        return "loop";
      case "repro.status":
      case "repro.start":
      case "repro.restart":
      case "repro.stop":
        return "repro";
      case "workflow.inspect":
        return "workflow-inspect";
      case "help.hotkeys":
        return "hotkeys";
      case "queue.inspect":
      case "workflow.open":
      case "help.commands":
        return undefined;
    }
  }

  private closeActionBar(): void {
    const component = this.activeActionBar;
    if (!component) return;
    if (this.actionBarHandle) this.actionBarHandle.hide();
    else this.tui.removeChild(component);
    this.actionBarHandle = undefined;
    this.activeActionBar = undefined;
    this.activeActionBarView = undefined;
    this.tui.setFocus(this);
    this.invalidate();
    this.tui.requestRender();
  }

  private async executeActionBarAction(action: SparkActionView): Promise<void> {
    try {
      switch (action.intent) {
        case "model.select":
          await this.invokeRegisteredSlashCommand("model", "", false);
          return;
        case "thinking.select": {
          const thinkingLevel = stringFromRecord(action.payload, "thinkingLevel");
          if (thinkingLevel) {
            await this.invokeRegisteredSlashCommand(
              "settings",
              `set thinking ${thinkingLevel}`,
              false,
            );
          } else {
            const thinkingBar = sparkSlashActionBarForInput("/thinking");
            if (thinkingBar) this.openActionBar(thinkingBar);
          }
          return;
        }
        case "settings.inspect":
          await this.invokeRegisteredSlashCommand("settings", "inspect", true);
          return;
        case "settings.providers":
          await this.invokeRegisteredSlashCommand("login", "", true);
          return;
        case "status.inspect":
          await this.invokeRegisteredSlashCommand("status", "", true);
          return;
        case "session.select":
          await this.invokeRegisteredSlashCommand("sessions", "", false);
          return;
        case "session.create":
          await this.invokeRegisteredSlashCommand("sessions", "", false);
          return;
        case "session.inspect":
          await this.invokeRegisteredSlashCommand("session", "inspect", true);
          return;
        case "queue.inspect":
          this.session.addSystemMessage(this.renderQueueInspection());
          return;
        case "turn.stop":
          await this.invokeRegisteredSlashCommand("stop", "", false);
          return;
        case "turn.retry":
          await this.invokeRegisteredSlashCommand("retry", "", false);
          return;
        case "goal.status":
        case "goal.start":
        case "goal.restart":
        case "goal.stop":
        case "loop.status":
        case "loop.start":
        case "loop.restart":
        case "loop.stop":
        case "repro.status":
        case "repro.start":
        case "repro.restart":
        case "repro.stop": {
          const [command, operation] = action.intent.split(".", 2) as [string, string];
          await this.invokeRegisteredSlashCommand(command, operation, operation === "status");
          return;
        }
        case "workflow.open":
          this.openCockpitPanel("runs");
          return;
        case "workflow.inspect":
          this.runSelectedWorkflowCommand("inspect");
          return;
        case "help.commands":
          this.session.addSystemMessage(this.renderCommandHelp());
          return;
        case "help.hotkeys":
          await this.invokeRegisteredSlashCommand("hotkeys", "", true);
          return;
      }
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.commandFailed(
          action.intent,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  custom<T>(
    factory: (
      tui: SparkModelSelectorTuiLike,
      theme: SparkModelSelectorTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => Component,
    options?: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      let handle: { hide(): void } | undefined;
      const done = (value: T) => {
        if (settled) return;
        settled = true;
        handle?.hide();
        this.tui.setFocus(this);
        this.tui.requestRender();
        resolve(value);
      };
      const component = factory(
        {
          terminal: { columns: this.tui.terminal.columns },
          requestRender: () => this.tui.requestRender(),
        },
        this.renderTheme,
        this.keybindings,
        done,
      );
      const overlayOptions = isOverlayRequest(options) ? options.overlayOptions : undefined;
      if (
        (!isOverlayRequest(options) || options.overlay !== false) &&
        typeof this.tui.showOverlay === "function"
      ) {
        handle = this.tui.showOverlay(component, overlayOptions);
      } else {
        this.tui.addChild(component);
        this.tui.setFocus(component);
        handle = {
          hide: () => {
            this.tui.removeChild(component);
            this.tui.setFocus(this);
            this.tui.requestRender();
          },
        };
      }
    });
  }

  async handleInteractionRequest(
    request: SparkInteractionRequest,
  ): Promise<SparkInteractionResponse> {
    this.recordInteractionRequest(request);
    if (this.interactionHandler) {
      const response = await this.interactionHandler(request, { app: this, session: this.session });
      const parsed = parseSparkInteractionResponse(response);
      this.completeInteractionRequest(parsed);
      return parsed;
    }
    if (request.kind === "askFlow") {
      const response = await this.presentAskFlow(request);
      this.completeInteractionRequest(response);
      return response;
    }
    this.session.addCustomMessage({
      customType: request.kind === "workflowPicker" ? "workflow-picker" : "interaction-request",
      content: `${request.kind}: ${request.title}`,
      display: true,
      details: { request },
    });
    this.invalidate();
    this.tui.requestRender();
    return createBlockedInteractionResponse(request, nativeTuiStrings.noInteractionHandler);
  }

  private async presentAskFlow(
    request: Extract<SparkInteractionRequest, { kind: "askFlow" }>,
  ): Promise<Extract<SparkInteractionResponse, { kind: "askFlow" }>> {
    if (!this.presentedAskRequestIds.has(request.requestId)) {
      this.presentedAskRequestIds.add(request.requestId);
      this.session.addCustomMessage({
        customType: "interaction-request",
        content: `${request.title}${request.prompt ? `\n${request.prompt}` : ""}`,
        display: true,
        details: { request },
      });
    }
    const flowRequest = nativeAskFlowRequest(request);
    const controller = new SparkAskFlowController({
      request: flowRequest,
      language: nativeAskLanguage(),
    });
    let timedOut = false;
    const resultPromise = this.custom<SparkAskFlowResult>(
      (tui, theme, _keybindings, done) => controller.run(tui, theme as AskRenderTheme, done),
      {
        overlay: true,
        overlayOptions: { width: "78%", minWidth: 56, maxHeight: "88%" },
      },
    );
    const timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = controller.cancel();
        }, request.timeoutMs)
      : undefined;
    timeout?.unref?.();
    let result: SparkAskFlowResult;
    try {
      result = await resultPromise;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const cancelled = result.cancelled || result.status === "cancelled";
    return {
      version: SPARK_PROTOCOL_VERSION,
      kind: "askFlow",
      requestId: request.requestId,
      status: cancelled ? "cancelled" : "answered",
      answers: nativeAskAnswers(result),
      nextAction: cancelled
        ? "cancel"
        : result.nextAction === "block" || result.nextAction === "clarify_then_reask"
          ? "block"
          : "resume",
      metadata: {
        surface: "native-tui",
        ...(timedOut && cancelled ? { timedOut: true } : {}),
      },
    };
  }

  private completeInteractionRequest(response: SparkInteractionResponse): void {
    if (response.status !== "pending") {
      this.cockpit.interactions.delete(response.requestId);
      this.invalidate();
      this.tui.requestRender();
    }
  }

  hydrateCockpit(input: {
    sessionId?: string;
    sessionTitle?: string;
    sessionStatus?: SparkSessionView["status"];
    tasks?: SparkTaskView[];
    artifacts?: SparkArtifactView[];
  }): void {
    if (input.sessionId) this.cockpit.sessionId = input.sessionId;
    if (input.sessionTitle) this.cockpit.sessionTitle = input.sessionTitle;
    if (input.sessionStatus) this.cockpit.sessionStatus = input.sessionStatus;
    for (const task of input.tasks ?? []) this.cockpit.tasks.set(task.ref, task);
    for (const artifact of input.artifacts ?? [])
      this.cockpit.artifacts.set(artifact.ref, artifact);
    this.invalidate();
    this.tui.requestRender();
  }

  applyViewModelEvent(event: SparkViewModelEvent): void {
    const parsed = parseSparkViewModelEvent(event);
    switch (parsed.type) {
      case "session.snapshot":
        this.recordSessionView(parsed.session);
        this.session.applySessionView(parsed.session);
        break;
      case "session.message":
        this.session.addMessageView(parsed.message);
        break;
      case "run.update":
        this.recordRunView(parsed.run);
        break;
      case "task.update": {
        this.cockpit.tasks.set(parsed.task.ref, parsed.task);
        this.session.addCustomMessage({
          customType: "task-view",
          content: `${parsed.task.ref} [${parsed.task.status}] ${parsed.task.title}`,
          display: true,
          details: { task: parsed.task },
        });
        const evidenceSummary = this.taskCompletionEvidenceSummary(parsed.task);
        if (evidenceSummary) this.session.addSystemMessage(evidenceSummary);
        break;
      }
      case "artifact.update":
        this.cockpit.artifacts.set(parsed.artifact.ref, parsed.artifact);
        break;
      case "evidence.update":
        this.cockpit.evidence.set(parsed.evidence.ref, parsed.evidence);
        break;
      default: {
        const _exhaustive: never = parsed;
        void _exhaustive;
        break;
      }
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private recordSessionView(view: SparkSessionView): void {
    this.cockpit.sessionId = view.sessionId;
    this.cockpit.sessionTitle = view.title;
    this.cockpit.sessionStatus = view.status;
    if (view.cwd) this.cockpit.cwd = view.cwd;
    else delete this.cockpit.cwd;
    if (view.gitBranch) this.cockpit.gitBranch = view.gitBranch;
    else delete this.cockpit.gitBranch;
    if (view.model) this.cockpit.model = view.model;
    else delete this.cockpit.model;
    if (view.thinkingLevel) this.cockpit.thinkingLevel = view.thinkingLevel;
    else delete this.cockpit.thinkingLevel;
    this.sessionFooterMetrics = view.usage ? footerMetricsFromRecord(view.usage) : {};
    this.runFooterMetrics.clear();
    this.cockpit.runs.clear();
    this.cockpit.tasks.clear();
    this.cockpit.artifacts.clear();
    this.cockpit.evidence.clear();
    for (const run of view.runs) this.recordRunView(run, false);
    if (view.runs.length === 0) this.recordActiveRunStatus();
    for (const task of view.tasks) this.cockpit.tasks.set(task.ref, task);
    for (const artifact of view.artifacts) {
      if (artifact.kind === "issue" || artifact.kind === "pr" || artifact.kind === "preview") {
        this.cockpit.artifacts.set(artifact.ref, artifact);
      } else {
        this.cockpit.evidence.set(artifact.ref, {
          version: artifact.version,
          ref: artifact.ref,
          title: artifact.title,
          kind:
            artifact.kind === "document" ||
            artifact.kind === "record" ||
            artifact.kind === "trace" ||
            artifact.kind === "knowledge"
              ? artifact.kind
              : "other",
          format:
            artifact.format === "markdown" ||
            artifact.format === "json" ||
            artifact.format === "text" ||
            artifact.format === "blob"
              ? artifact.format
              : "other",
          ...(artifact.status ? { status: artifact.status } : {}),
          ...(artifact.producer ? { producer: artifact.producer } : {}),
          ...(artifact.createdAt ? { createdAt: artifact.createdAt } : {}),
          ...(artifact.updatedAt ? { updatedAt: artifact.updatedAt } : {}),
          ...(artifact.preview ? { preview: artifact.preview } : {}),
          metadata: artifact.metadata,
        });
      }
    }
    for (const evidence of view.evidence ?? []) this.cockpit.evidence.set(evidence.ref, evidence);
  }

  private recordRunView(run: SparkRunView, includeUsage = true): void {
    this.cockpit.runs.set(run.id, run);
    this.recordCacheUsageStatus(run, includeUsage);
    this.recordActiveRunStatus();
    if (run.kind === "workflow") {
      const selector = stringFromRecord(run.metadata, "selector") ?? run.id;
      this.cockpit.workflows.set(selector, {
        selector,
        label: run.title ?? run.summary ?? run.id,
        description: run.summary,
        source: "run",
      });
      this.ensureWorkflowRunSelection();
    }
  }

  private recordCacheUsageStatus(run: SparkRunView, includeUsage: boolean): void {
    if (run.summary && /\bcache read=\d+ write=\d+/iu.test(run.summary)) {
      this.statuses.set("cache-usage", run.summary);
    }
    if (!includeUsage) return;
    const next = footerMetricsFromRun(run);
    if (!Object.values(next).some((value) => value !== undefined)) return;
    const current = this.runFooterMetrics.get(run.id) ?? {};
    this.runFooterMetrics.delete(run.id);
    this.runFooterMetrics.set(run.id, mergeFooterMetrics(current, next));
  }

  private taskCompletionEvidenceSummary(task: SparkTaskView): string | undefined {
    if (!isDoneTaskStatus(task.status)) return undefined;
    const key = `${task.ref}:${task.status}:${task.artifactRefs.join(",")}`;
    if (this.completedTaskSummaryKeys.has(key)) return undefined;
    this.completedTaskSummaryKeys.add(key);
    const artifactCount = task.artifactRefs.length;
    const reviewStatus = this.taskReviewStatus(task);
    return [
      "✔ task done",
      `${artifactCount} artifact${artifactCount === 1 ? "" : "s"}`,
      reviewStatus ? `review ${reviewStatus}` : "review not recorded",
      cockpitTaskDeepLink(task.ref),
    ].join(" · ");
  }

  private taskReviewStatus(task: SparkTaskView): string | undefined {
    const metadataStatus =
      stringFromRecord(task.metadata, "reviewStatus") ??
      stringFromRecord(task.metadata, "reviewOutcome") ??
      stringFromRecord(task.metadata, "review") ??
      stringFromRecord(task.metadata, "verdict") ??
      stringFromRecord(task.metadata, "outcome");
    if (metadataStatus) return metadataStatus;
    for (const ref of task.artifactRefs) {
      const artifact =
        this.cockpit.artifacts.get(ref) ?? this.cockpit.evidence.get(ref) ?? undefined;
      if (!artifact || !isReviewArtifact(artifact)) continue;
      return (
        stringFromRecord(artifact.metadata, "outcome") ??
        stringFromRecord(artifact.metadata, "verdict") ??
        artifact.status ??
        "recorded"
      );
    }
    return undefined;
  }

  private recordActiveRunStatus(): void {
    const activeRuns = [...this.cockpit.runs.values()]
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort((left, right) => runTimeMs(left) - runTimeMs(right));
    const active = activeRuns.at(-1);
    if (!active) {
      this.statuses.delete("active-run");
      return;
    }
    const label = active.summary?.trim() || active.title?.trim() || active.id;
    this.statuses.set("active-run", `${active.kind} ${active.status}: ${label}`);
  }

  private recordInteractionRequest(request: SparkInteractionRequest): void {
    this.cockpit.interactions.set(request.requestId, request);
    if (request.kind === "workflowPicker") {
      for (const option of request.options) {
        this.cockpit.workflows.set(option.selector, {
          selector: option.selector,
          label: option.label,
          description: option.description,
          source: "interaction",
        });
      }
    }
    this.invalidate();
    this.tui.requestRender();
  }

  toggleTools(): boolean {
    this.toolsExpanded = !this.toolsExpanded;
    this.invalidate();
    this.tui.requestRender();
    return this.toolsExpanded;
  }

  toggleThinking(): boolean {
    this.thinkingExpanded = !this.thinkingExpanded;
    this.invalidate();
    this.tui.requestRender();
    return this.thinkingExpanded;
  }

  areToolsExpanded(): boolean {
    return this.toolsExpanded;
  }

  isThinkingExpanded(): boolean {
    return this.thinkingExpanded;
  }

  private handleSparkKeybinding(data: string): boolean {
    const key = parseKey(data) ?? data;
    const keybindings = this.keybindings;
    if (!keybindings || !isSparkAppKey(key)) return false;
    void keybindings.executeKey(key, this.keybindingContext).then((didHandle) => {
      if (didHandle) {
        this.invalidate();
        this.tui.requestRender();
      }
    });
    return true;
  }

  private installAutocompleteProvider(options: SparkNativeTuiAppOptions): void {
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        this.autocompleteSlashCommands(),
        options.autocompleteBasePath ?? process.cwd(),
        options.autocompleteFdPath ?? null,
      ),
    );
  }

  private autocompleteSlashCommands(): SlashCommand[] {
    const registered = Object.entries(this.slashCommands)
      .sort(([leftName, left], [rightName, right]) => {
        const leftRank = isSparkNativeLocalControlCommand(left) ? 1 : 0;
        const rightRank = isSparkNativeLocalControlCommand(right) ? 1 : 0;
        return leftRank - rightRank || leftName.localeCompare(rightName);
      })
      .map(([name, command]) => ({
        name,
        description: command.description,
        argumentHint: command.argumentHint,
        getArgumentCompletions: command.getArgumentCompletions,
      }));
    return [...registered, ...this.builtInAutocompleteCommands()];
  }

  private builtInAutocompleteCommands(): SlashCommand[] {
    return nativeKernelSlashCommandEntries().map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    }));
  }

  private registerToggleKeybindings(keybindings: SparkKeybindings | undefined): void {
    if (!keybindings) return;
    keybindings.register({
      id: "app.toggleTools",
      defaultKey: "ctrl+o",
      description: nativeTuiStrings.keybindings.toggleTools,
      handler: () => void this.toggleTools(),
    });
    keybindings.register({
      id: "app.toggleThinking",
      defaultKey: "ctrl+t",
      description: nativeTuiStrings.keybindings.toggleThinking,
      handler: () => void this.toggleThinking(),
    });
    keybindings.register({
      id: "app.toggleCockpit",
      defaultKey: "ctrl+k",
      description: nativeTuiStrings.keybindings.toggleCockpit,
      handler: () => void this.toggleCockpitPanel(),
    });
    keybindings.register({
      id: "app.cycleCockpitPanel",
      defaultKey: "shift+ctrl+k",
      description: nativeTuiStrings.keybindings.cycleCockpitPanel,
      handler: () => void this.cycleCockpitPanel(),
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
    for (const widget of this.widgets.values()) widget.component?.invalidate?.();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    lines.push(
      truncateToWidth(
        this.renderTheme.bold(this.renderTheme.fg("accent", nativeTuiStrings.appTitle)),
        width,
      ),
    );
    lines.push(truncateToWidth(this.renderTheme.fg("muted", this.statusLine()), width));
    lines.push(...this.renderWorkspaceSessionState(width));
    lines.push(...this.renderWidgets("aboveEditor", width));
    lines.push(...this.renderActiveCockpitPanel(width));
    lines.push(this.separatorLine(width));

    for (const message of this.session.messages) {
      lines.push(...this.renderMessage(message, width));
    }

    lines.push(...this.renderInputQueue(width));
    lines.push(this.separatorLine(width));
    lines.push(...this.editor.render(width));
    lines.push(...this.renderWidgets("belowEditor", width));
    lines.push(truncateToWidth(this.renderTheme.fg("muted", this.footerLine()), width));
    lines.push(...this.runtimeFooterLines(width));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width));
    return this.cachedLines;
  }

  private renderWorkspaceSessionState(width: number): string[] {
    const state = this.workspaceSession;
    if (!state) return [];
    const title =
      state.mode === "attached"
        ? "Spark session attached"
        : state.mode === "mismatch"
          ? "Spark session attach blocked"
          : "Select Spark session";
    const details = [
      title,
      `workspace: ${state.workspaceDir}`,
      `workspace hash: ${state.workspaceHash}`,
      ...(state.controlPlaneSessionId
        ? [`control-plane session: ${state.controlPlaneSessionId}`]
        : []),
      ...(state.attachTarget ? [`attach target: ${state.attachTarget}`] : []),
      ...(state.mode === "select" ? ["attach a daemon-managed session"] : []),
      ...(state.mismatchDiagnostic ? [`diagnostic: ${state.mismatchDiagnostic}`] : []),
    ];
    return [truncateToWidth(this.renderTheme.fg("muted", details.join(" • ")), width)];
  }

  private renderInputQueue(width: number): string[] {
    const queued = this.session.queuedInputs;
    const daemonPending = this.session.daemonPending;
    if (queued.length === 0 && daemonPending.length === 0) return [];

    const visible = queued.slice(0, MAX_NATIVE_QUEUE_ITEMS);
    const hidden = queued.length - visible.length;
    const lines = [
      this.renderTheme.bold(
        this.renderTheme.fg(
          "accent",
          `◆ Input queue · local ${queued.length}` +
            (daemonPending.length > 0 ? ` · daemon ${daemonPending.length}` : ""),
        ),
      ),
      this.renderTheme.fg("muted", "│ Enter steer · Alt+Enter follow-up · Alt+Up restore all"),
    ];
    for (const [index, input] of visible.entries()) {
      const isLast = index === visible.length - 1 && hidden === 0 && daemonPending.length === 0;
      const marker = isLast ? "└─" : "├─";
      const mode = input.mode === "followUp" ? "follow-up" : "steer";
      lines.push(`${marker} ${index + 1}. ${mode} · ${compactNativeQueuePreview(input.text)}`);
    }
    if (hidden > 0) {
      lines.push(`${daemonPending.length > 0 ? "├─" : "└─"} … +${hidden} more local`);
    }
    for (const [index, turn] of daemonPending.entries()) {
      const isLast = index === daemonPending.length - 1;
      const marker = isLast ? "└─" : "├─";
      lines.push(`${marker} daemon ${turn.status} · ${compactNativeQueuePreview(turn.prompt)}`);
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderMessage(message: SparkNativeMessage, width: number): string[] {
    if (message.display === false) return [];
    if (message.role === "tool") return this.renderToolMessage(message, width);
    if (message.role === "thinking") return this.renderThinkingMessage(message, width);
    if (message.role === "custom") return this.renderCustomMessage(message, width);

    const prefix = this.messagePrefix(message);
    const body = message.text || " ";
    const suffix = message.streaming ? " ▋" : "";
    const quoteLines = message.role === "user" ? this.renderChannelQuoteLines(message, width) : [];
    const lines =
      message.role === "assistant"
        ? this.renderPrefixedLines(
            prefix,
            this.renderMarkdownBlock(`${body}${suffix}`, width),
            width,
          )
        : this.renderPrefixedBlock(prefix, `${body}${suffix}`, width);
    return this.styleRoleLines(message.role, [...quoteLines, ...lines]);
  }

  private renderChannelQuoteLines(message: SparkNativeMessage, width: number): string[] {
    const quote = channelQuotePreviewFromDetails(message.details);
    if (!quote) return [];
    const label = quote.senderLabel
      ? this.renderTheme.fg("dim", `│ ${quote.senderLabel}`)
      : this.renderTheme.fg("dim", "│");
    const body = this.renderTheme.fg("dim", `│ ${quote.text}`);
    return [
      truncateToWidth(label, width),
      ...wrapTextWithAnsi(body, width).map((line) => truncateToWidth(line, width)),
    ];
  }

  private renderToolMessage(message: SparkNativeMessage, width: number): string[] {
    const toolName = message.toolName ?? "tool";
    const status = canonicalToolStatus(message.toolStatus ?? "succeeded");
    const header = `tool:${toolName} [${status}]`;
    const icon = toolStatusIcon(status);
    const preview = compactToolPreview(message.text);
    const styledHeader = this.renderToolHeader(header, status, icon);
    if (!this.toolsExpanded) {
      const suffix = this.renderTheme.fg("dim", " • folded (Ctrl+O expand)");
      const previewText = preview ? ` ${this.renderTheme.fg("muted", `— ${preview}`)}` : "";
      return [truncateToWidth(`${styledHeader}${previewText}${suffix}`, width)];
    }

    const id = message.toolCallId ? this.renderTheme.fg("dim", ` · ${message.toolCallId}`) : "";
    const body = this.renderToolBody(message.text || " ");
    const innerWidth = Math.max(1, width - 2);
    const lines = [
      truncateToWidth(`${this.renderTheme.fg("border", "┌─")} ${styledHeader}${id}`, width),
    ];
    for (const line of body.split("\n")) {
      for (const wrapped of wrapTextWithAnsi(line || " ", innerWidth)) {
        lines.push(truncateToWidth(`${this.renderTheme.fg("border", "│")} ${wrapped}`, width));
      }
    }
    lines.push(
      truncateToWidth(
        `${this.renderTheme.fg("border", "└─")} ${this.renderTheme.fg("dim", "Ctrl+O collapse")}`,
        width,
      ),
    );
    return lines;
  }

  private renderToolHeader(header: string, status: SparkNativeToolStatus, icon: string): string {
    const color = toolStatusColor(status);
    return `${this.renderTheme.fg(color, icon)} ${this.renderTheme.fg("tool", header)}`;
  }

  private renderThinkingMessage(message: SparkNativeMessage, width: number): string[] {
    if (!this.thinkingExpanded) {
      return this.styleRoleLines("thinking", [
        truncateToWidth(nativeTuiStrings.thinkingFolded(Boolean(message.streaming)), width),
      ]);
    }
    const suffix = message.streaming ? " ▋" : "";
    return this.styleRoleLines(
      "thinking",
      this.renderPrefixedBlock(
        nativeTuiStrings.thinkingPrefix,
        `${message.text || " "}${suffix}`,
        width,
      ),
    );
  }

  private renderCustomMessage(message: SparkNativeMessage, width: number): string[] {
    const customType = message.customType ?? "custom";
    const renderer = this.messageRenderers.get(customType);
    if (renderer) {
      const component = renderer(
        this.toCustomMessage(message, customType),
        { expanded: true },
        this.renderTheme,
      );
      if (component) return component.render(width).map((line) => truncateToWidth(line, width));
    }
    return this.styleRoleLines(
      "custom",
      this.renderPrefixedBlock(`custom:${customType}> `, message.text || " ", width),
    );
  }

  private renderMarkdownBlock(body: string, width: number): string[] {
    const markdown = new Markdown(
      body,
      0,
      0,
      createSparkMarkdownTheme(this.theme),
      this.markdownDefaultTextStyle(),
      { preserveOrderedListMarkers: true },
    );
    return markdown.render(
      Math.max(1, width - this.messagePrefix({ role: "assistant", text: "" }).length),
    );
  }

  private markdownDefaultTextStyle(): DefaultTextStyle {
    return { color: (text) => this.renderTheme.fg("assistant", text) };
  }

  private renderToolBody(body: string): string {
    return body
      .split("\n")
      .map((line) => styleSparkDiffLine(this.theme, line))
      .join("\n");
  }

  private separatorLine(width: number): string {
    return this.renderTheme.fg("border", "".padEnd(Math.max(1, width), "─"));
  }

  private styleRoleLines(role: SparkNativeMessageRole, lines: string[]): string[] {
    return lines.map((line) => styleSparkRoleLine(this.theme, role, line));
  }

  private renderPrefixedLines(prefix: string, bodyLines: string[], width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of bodyLines.entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
  }

  private renderPrefixedBlock(prefix: string, body: string, width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of body.split("\n").entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
  }

  private renderWidgets(placement: "aboveEditor" | "belowEditor", width: number): string[] {
    return [...this.widgets.values()]
      .filter((widget) => widget.placement === placement)
      .sort((a, b) => a.key.localeCompare(b.key))
      .flatMap((widget) => {
        const lines = widget.component
          ? renderNativeWidgetComponent(widget.component, width)
          : (widget.lines ?? []);
        return lines.map((line) => truncateToWidth(line, width));
      });
  }

  private renderActiveCockpitPanel(width: number): string[] {
    if (!this.activeCockpitPanel) return [];
    return this.renderCockpitPanel(this.activeCockpitPanel, width).map((line) =>
      truncateToWidth(line, width),
    );
  }

  private renderCockpitPanel(panel: SparkNativeCockpitPanel, width?: number): string[] {
    switch (panel) {
      case "overview":
        return this.renderCockpitOverview();
      case "workflows":
        return this.renderWorkflowCockpit();
      case "runs":
        return this.renderRunCockpit();
      case "tasks":
        return this.renderTaskCockpit(width);
      case "artifacts":
        return this.renderArtifactCockpit();
      case "reviews":
        return this.renderReviewCockpit();
      case "graft":
        return this.renderGraftCockpit();
    }
  }

  private renderCockpitOverview(): string[] {
    const snapshot = this.cockpitSnapshot();
    return [
      "◆ Spark cockpit: overview",
      `├─ Workflow picker/progress: ${snapshot.workflows} option(s), ${snapshot.workflowRuns} workflow run(s)`,
      `├─ Role-run board: ${snapshot.roleRuns} role run(s), ${snapshot.interactions} interaction(s)`,
      `├─ Task/project board: ${snapshot.tasks} tracked task(s)`,
      `├─ Artifacts panel: ${snapshot.artifacts} product artifact(s), ${snapshot.evidence} evidence item(s), ${snapshot.reviews} review item(s)`,
      `└─ Graft provenance/patch status: ${snapshot.graftItems} item(s)`,
    ];
  }

  private renderWorkflowCockpit(): string[] {
    const selected = this.selectedWorkflowRun();
    const lines = [
      "◆ Spark cockpit: workflows",
      "│  Keys: ↑/↓ or j/k select · Enter/i inspect · p pause · u resume · x stop · r restart · s save · a ack · Esc close",
      selected
        ? `│  Selected: ${selected.id} [${workflowRunDisplayStatus(selected)}]`
        : "│  Selected: none",
      "│  Commands: /workflow-runs [runRef] · /workflow-inspect <runRef>",
      "│            /workflow-pause|resume|stop|restart|save|ack <runRef>",
    ];
    const interactions = [...this.cockpit.interactions.values()].filter(
      (request) => request.kind === "workflowPicker",
    );
    for (const request of interactions.slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      lines.push(
        `├─ picker ${request.requestId}: ${request.title} (${request.options.length} option(s))`,
      );
    }
    for (const workflow of [...this.cockpit.workflows.values()].slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const source = workflow.source === "interaction" ? "picker" : "run";
      lines.push(
        `├─ ${source} ${workflow.selector}: ${workflow.label}${workflow.description ? ` — ${workflow.description}` : ""}`,
      );
    }
    for (const run of this.runsByKind("workflow").slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const marker = run.id === selected?.id ? "▸" : "├";
      lines.push(
        `${marker}─ workflow run ${run.id} [${workflowRunDisplayStatus(run)}] ${run.title ?? run.summary ?? ""}`.trimEnd(),
      );
      if (run.id === selected?.id) {
        for (const hint of workflowRunControlHints(run)) lines.push(`│  ${hint}`);
      }
    }
    if (lines.length === 5)
      lines.push("└─ No workflow picker options or workflow runs have been published yet.");
    return lines;
  }

  private renderRunCockpit(): string[] {
    const selected = this.selectedWorkflowRun();
    const lines = [
      "◆ Spark cockpit: role/run board",
      "│  Keys: ↑/↓ or j/k select workflow run · Enter/i inspect · p pause · u resume · x stop · r restart · s save · a ack · Esc close",
      selected
        ? `│  Selected: ${selected.id} [${workflowRunDisplayStatus(selected)}]`
        : "│  Selected: none",
      "│  Workflow commands: /workflow-runs [runRef] · /workflow-inspect <runRef>",
      "│                     /workflow-pause|resume|stop|restart|save|ack <runRef>",
    ];
    const runs = [...this.cockpit.runs.values()].sort(compareRunsForCockpit);
    for (const run of runs.slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const progress = run.progress === undefined ? "" : ` ${(run.progress * 100).toFixed(0)}%`;
      const artifacts = run.artifactRefs.length > 0 ? ` artifacts=${run.artifactRefs.length}` : "";
      const marker = run.kind === "workflow" && run.id === selected?.id ? "▸" : "├";
      const status = run.kind === "workflow" ? workflowRunDisplayStatus(run) : run.status;
      lines.push(
        `${marker}─ ${run.kind} ${run.id} [${status}]${progress}${artifacts} ${run.title ?? run.summary ?? ""}`.trimEnd(),
      );
      if (run.kind === "workflow" && run.id === selected?.id) {
        for (const hint of workflowRunControlHints(run)) lines.push(`│  ${hint}`);
      }
    }
    if (lines.length === 5) lines.push("└─ No run view-model updates have been published yet.");
    return lines;
  }

  private renderTaskCockpit(width?: number): string[] {
    const lines = ["◆ Spark cockpit: task/project board"];
    if (this.cockpit.sessionTitle) {
      lines.push(...wrapTextWithAnsi(`│  Project: ${this.cockpit.sessionTitle}`, width ?? 100));
    }
    for (const task of [...this.cockpit.tasks.values()].slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const doneTodos = task.todos.filter((todo) => todo.status === "done").length;
      const todoSummary = task.todos.length > 0 ? ` todos=${doneTodos}/${task.todos.length}` : "";
      const artifacts = task.artifactRefs.length > 0 ? ` evidence=${task.artifactRefs.length}` : "";
      lines.push(`├─ ${task.ref} [${task.status}]${todoSummary}${artifacts} ${task.title}`);
    }
    if (lines.length === (this.cockpit.sessionTitle ? 2 : 1))
      lines.push("└─ No task/project view-model updates have been published yet.");
    return lines;
  }

  private renderArtifactCockpit(): string[] {
    const lines = ["◆ Spark cockpit: artifacts"];
    const rows = [...this.cockpit.artifacts.values(), ...this.cockpit.evidence.values()].slice(
      0,
      MAX_COCKPIT_PANEL_ROWS,
    );
    for (const artifact of rows) {
      const producer = artifact.producer ? ` producer=${artifact.producer}` : "";
      const status = artifact.status ? ` status=${artifact.status}` : "";
      lines.push(
        `├─ ${artifact.ref} [${artifact.kind}/${artifact.format}]${producer}${status} ${artifact.title}`,
      );
      if (artifact.preview) lines.push(`│  ${artifact.preview}`);
    }
    if (lines.length === 1)
      lines.push("└─ No artifact view-model updates have been published yet.");
    return lines;
  }

  private renderReviewCockpit(): string[] {
    const lines = ["◆ Spark cockpit: reviewer verdicts"];
    for (const item of this.reviewItems().slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      lines.push(`├─ ${item}`);
    }
    if (lines.length === 1)
      lines.push("└─ No reviewer verdict artifacts or run metadata have been published yet.");
    return lines;
  }

  private renderGraftCockpit(): string[] {
    const lines = ["◆ Spark cockpit: Graft provenance/patch status"];
    for (const item of this.graftItems().slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      lines.push(`├─ ${item}`);
    }
    if (lines.length === 1)
      lines.push("└─ No Graft candidate, patch, or provenance metadata has been published yet.");
    return lines;
  }

  private selectableWorkflowRuns(): SparkRunView[] {
    return this.runsByKind("workflow").sort(compareRunsForCockpit);
  }

  private selectedWorkflowRun(): SparkRunView | undefined {
    this.ensureWorkflowRunSelection();
    const selectedId = this.cockpit.selectedWorkflowRunId;
    if (!selectedId) return undefined;
    return this.cockpit.runs.get(selectedId);
  }

  private ensureWorkflowRunSelection(): void {
    const runs = this.selectableWorkflowRuns();
    if (runs.length === 0) {
      this.cockpit.selectedWorkflowRunId = undefined;
      return;
    }
    if (
      !this.cockpit.selectedWorkflowRunId ||
      !runs.some((run) => run.id === this.cockpit.selectedWorkflowRunId)
    ) {
      this.cockpit.selectedWorkflowRunId = runs[0]?.id;
    }
  }

  private runsByKind(kind: SparkRunView["kind"]): SparkRunView[] {
    return [...this.cockpit.runs.values()].filter((run) => run.kind === kind);
  }

  private reviewItems(): string[] {
    const artifactItems = [...this.cockpit.artifacts.values(), ...this.cockpit.evidence.values()]
      .filter(isReviewArtifact)
      .map((artifact) => {
        const outcome =
          stringFromRecord(artifact.metadata, "outcome") ?? artifact.status ?? "recorded";
        return `${artifact.ref} [${outcome}] ${artifact.title}`;
      });
    const runItems = [...this.cockpit.runs.values()]
      .filter((run) =>
        Boolean(
          stringFromRecord(run.metadata, "reviewer") ??
          stringFromRecord(run.metadata, "verdict") ??
          stringFromRecord(run.metadata, "outcome"),
        ),
      )
      .map((run) => {
        const outcome =
          stringFromRecord(run.metadata, "outcome") ??
          stringFromRecord(run.metadata, "verdict") ??
          run.status;
        return `${run.kind}:${run.id} [${outcome}] ${run.title ?? run.summary ?? "review"}`;
      });
    return [...artifactItems, ...runItems];
  }

  private graftItems(): string[] {
    const records: string[] = [];
    for (const artifact of [
      ...this.cockpit.artifacts.values(),
      ...this.cockpit.evidence.values(),
    ]) {
      const summary = graftSummaryFromRecord(artifact.metadata);
      if (
        summary ||
        /\bgraft\b|candidate:|patch:/iu.test(`${artifact.title} ${artifact.preview ?? ""}`)
      ) {
        records.push(`${artifact.ref} ${summary ?? artifact.title}`);
      }
    }
    for (const run of this.cockpit.runs.values()) {
      const summary = graftSummaryFromRecord(run.metadata);
      if (
        summary ||
        /\bgraft\b|candidate:|patch:/iu.test(`${run.title ?? ""} ${run.summary ?? ""}`)
      ) {
        records.push(`${run.kind}:${run.id} ${summary ?? run.title ?? run.summary ?? "graft"}`);
      }
    }
    return records;
  }

  private toCustomMessage(message: SparkNativeMessage, customType: string): SparkHostCustomMessage {
    return {
      customType,
      content: message.text,
      display: message.display,
      details: message.details,
    };
  }

  private statusLine(): string {
    const statusSuffix = this.extensionStatusSuffix();
    const commandSuffix = this.commandAvailabilitySuffix();
    const sessionLabel =
      this.cockpit.sessionTitle?.trim() ||
      this.cockpit.sessionId?.trim() ||
      this.workspaceSession?.controlPlaneSessionId?.trim() ||
      "local";
    const activeProvider = this.statusContext?.activeProvider?.()?.trim();
    const activeModel = this.statusContext?.activeModel?.()?.trim();
    const modelLabel =
      activeProvider && activeModel ? `${activeProvider}/${activeModel}` : activeModel;
    const thinkingLevel = this.statusContext?.thinkingLevel?.()?.trim();
    const queue = this.session.queueSummary;
    return (
      nativeTuiStrings.statusLine({
        session: sessionLabel,
        ...(modelLabel ? { model: modelLabel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        state: this.sessionStateLabel(),
        ...(queue.total > 0 ? { queue: { steer: queue.steer, followUp: queue.followUp } } : {}),
      }) +
      commandSuffix +
      statusSuffix
    );
  }

  private footerLine(): string {
    return this.session.isProcessing
      ? `${this.workingSpinner()} Working... • ${nativeTuiStrings.busyFooter(this.session.queuedCount > 0)}`
      : nativeTuiStrings.footer;
  }

  private runtimeFooterLines(width: number): string[] {
    const cwd = this.cockpit.cwd ?? this.inputBasePath;
    const home = homedir();
    const compactCwd =
      cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
    const branch = this.cockpit.gitBranch?.trim();
    const pathLine = branch ? `${compactCwd} (${branch})` : compactCwd;
    const metrics = formatFooterMetrics(
      this.currentFooterMetrics(),
      this.statusContext?.autoCompactionEnabled?.() ?? true,
    );
    const identity = this.runtimeModelIdentity();
    const lines = [truncateToWidth(this.renderTheme.fg("muted", pathLine), width)];
    if (!metrics && !identity.full) return lines;
    const line = this.alignRuntimeFooter(metrics ?? "", identity, width);
    lines.push(truncateToWidth(this.renderTheme.fg("muted", line), width));
    return lines;
  }

  private currentFooterMetrics(): SparkNativeFooterMetrics {
    let metrics = { ...this.sessionFooterMetrics };
    for (const run of this.runFooterMetrics.values()) metrics = addFooterMetrics(metrics, run);
    const contextWindow = this.statusContext?.contextWindow?.() ?? metrics.contextWindow;
    return contextWindow ? { ...metrics, contextWindow } : metrics;
  }

  private runtimeModelIdentity(): { full?: string; compact?: string } {
    let provider =
      this.statusContext?.activeProvider?.()?.trim() ?? this.cockpit.model?.providerName;
    let model = this.statusContext?.activeModel?.()?.trim() ?? this.cockpit.model?.modelId;
    if (!provider && model?.includes("/")) {
      const separator = model.indexOf("/");
      provider = model.slice(0, separator);
      model = model.slice(separator + 1);
    }
    const thinking = this.statusContext?.thinkingLevel?.()?.trim() ?? this.cockpit.thinkingLevel;
    if (!model) return {};
    const compact = thinking ? `${model} • ${thinking}` : model;
    return { full: provider ? `(${provider}) ${compact}` : compact, compact };
  }

  private alignRuntimeFooter(
    metrics: string,
    identity: { full?: string; compact?: string },
    width: number,
  ): string {
    if (!identity.full) return truncateToWidth(metrics, width);
    let right = identity.full;
    const minimumGap = metrics ? 2 : 0;
    if (visibleWidth(metrics) + minimumGap + visibleWidth(right) > width && identity.compact) {
      right = identity.compact;
    }
    let left = metrics;
    const availableForLeft = Math.max(0, width - visibleWidth(right) - minimumGap);
    if (visibleWidth(left) > availableForLeft) left = truncateToWidth(left, availableForLeft, "…");
    if (!left) return truncateToWidth(right, width, "…");
    const availableForRight = Math.max(0, width - visibleWidth(left) - minimumGap);
    if (visibleWidth(right) > availableForRight) {
      right = truncateToWidth(right, availableForRight, "");
    }
    const padding = " ".repeat(
      Math.max(minimumGap, width - visibleWidth(left) - visibleWidth(right)),
    );
    return `${left}${padding}${right}`;
  }

  private workingSpinner(): string {
    return NATIVE_WORKING_SPINNER_FRAMES[
      this.workingSpinnerFrame % NATIVE_WORKING_SPINNER_FRAMES.length
    ];
  }

  private syncWorkingSpinner(): void {
    if (!this.session.isProcessing) {
      this.stopWorkingSpinner();
      return;
    }
    if (this.workingSpinnerTimer) return;
    this.workingSpinnerTimer = setInterval(() => {
      this.workingSpinnerFrame =
        (this.workingSpinnerFrame + 1) % NATIVE_WORKING_SPINNER_FRAMES.length;
      this.invalidate();
      this.tui.requestRender();
    }, NATIVE_WORKING_SPINNER_INTERVAL_MS);
    this.workingSpinnerTimer.unref?.();
  }

  private stopWorkingSpinner(): void {
    if (this.workingSpinnerTimer) clearInterval(this.workingSpinnerTimer);
    this.workingSpinnerTimer = undefined;
    this.workingSpinnerFrame = 0;
  }

  private sessionStateLabel(): string {
    if (this.session.isProcessing) return "running";
    if (this.session.queuedCount > 0) return "queued";
    switch (this.cockpit.sessionStatus) {
      case "streaming":
        return "running";
      case "succeeded":
        return "complete";
      case "timed_out":
        return "timed-out";
      default:
        return this.cockpit.sessionStatus ?? "idle";
    }
  }

  private async runSlashCommand(input: string): Promise<void> {
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      this.session.addSystemMessage(nativeTuiStrings.emptyCommand);
      return;
    }

    const builtIn = this.builtInSlashCommand(parsed.name, parsed.args);
    if (builtIn !== undefined) {
      if (builtIn) this.session.addSystemMessage(builtIn);
      return;
    }

    // `/sessions` is an explicit navigation command, not a palette request.
    // Execute it directly so the host can exit this TUI and reopen the same
    // selector used at startup. `/session` keeps the richer action bar.
    if (parsed.name === "sessions" && !parsed.args.trim()) {
      await this.invokeRegisteredSlashCommand(parsed.name, parsed.args, true);
      return;
    }

    const actionBar = sparkSlashActionBarForInput(input);
    if (actionBar) {
      this.openActionBar(actionBar);
      return;
    }

    await this.invokeRegisteredSlashCommand(parsed.name, parsed.args, true);
  }

  private async invokeRegisteredSlashCommand(
    name: string,
    args: string,
    emitResult: boolean,
  ): Promise<void> {
    const command = this.slashCommands[name];
    if (!command) {
      this.session.addSystemMessage(nativeTuiStrings.unknownCommand(name));
      return;
    }

    try {
      const result = await command.handler(args, {
        app: this,
        session: this.session,
        exit: this.onExit,
      });
      if (emitResult && result?.trim()) this.session.addSystemMessage(result.trim());
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.commandFailed(
          name,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private builtInSlashCommand(name: string, _args: string): string | undefined | false {
    switch (name) {
      case "help":
        return this.renderCommandHelp();
      case "clear":
        this.session.clearTranscript();
        return false;
      case "reload":
        return "Reload requested. Restart Spark TUI to reload extension state.";
      case "stop": {
        const result = this.session.abort(_args.trim() || "user stop");
        if (result.restoredText) this.setEditorText(result.restoredText);
        if (result.aborted) return false;
        return result.clearedQueued > 0
          ? `Restored ${result.clearedQueued} queued input(s) to the editor.`
          : nativeTuiStrings.noTurnRunning;
      }
      case "retry":
        void this.session.retryLast();
        return false;
      case "cockpit":
        return this.openCockpitPanelFromArgs(_args);
      case "workflows":
        return this.openCockpitPanel("workflows");
      case "runs":
      case "run":
        return this.openCockpitPanel("runs");
      case "tasks":
      case "task":
        return this.openCockpitPanel("tasks");
      case "artifacts":
      case "artifact":
      case "evidence":
        return this.openCockpitPanel("artifacts");
      case "reviews":
      case "review":
        return this.openCockpitPanel("reviews");
      case "graft":
        return this.openCockpitPanel("graft");
      case "exit":
      case "quit":
        this.onExit();
        return nativeTuiStrings.exiting;
      default:
        return undefined;
    }
  }

  openCockpitPanelFromArgs(args: string): string | false {
    const requested = args.trim().toLowerCase();
    if (requested === "off" || requested === "close" || requested === "hide") {
      this.activeCockpitPanel = undefined;
      this.invalidate();
      this.tui.requestRender();
      return nativeTuiStrings.cockpitPanelClosed;
    }
    if (requested && !isSparkNativeCockpitPanel(requested)) {
      return `Unknown cockpit panel '${requested}'. Choose: ${SPARK_COCKPIT_PANELS.join(", ")}, off.`;
    }
    return this.openCockpitPanel((requested as SparkNativeCockpitPanel | "") || "overview");
  }

  openCockpitPanel(panel: SparkNativeCockpitPanel): string | false {
    this.activeCockpitPanel = panel;
    if (panel === "runs" || panel === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    return false;
  }

  private renderCommandHelp(): string {
    const system = nativeKernelSlashCommandEntries().map((command) => {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      return `/${command.name}${hint} — ${command.description}`;
    });
    const extensions = Object.entries(this.slashCommands)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => {
        const target = command.metadata?.canonicalCliTarget
          ? ` → ${command.metadata.canonicalCliTarget}`
          : "";
        const source = command.metadata?.source ?? "extension";
        const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
        return `/${name}${hint} — ${command.description} [${source}]${target}`;
      });
    return [
      "Spark native TUI commands:",
      "System",
      ...system,
      "Ctrl+K — toggle Spark cockpit overview; Shift+Ctrl+K — cycle cockpit panels",
      "Everyday:",
      "- ordinary input — send a prompt to Spark",
      "- /plan — plan durable project work",
      "- /implement — execute the selected concrete work",
      "- /model — switch or inspect the active model",
      "- /resume — resume or preview a persisted session",
      "Advanced:",
      "- /goal — run reviewer-gated autonomous goal work",
      "- /loop — run an open-ended recurring loop",
      "- /workflow — run saved or scripted multi-agent workflows",
      "- /ultracode — run the advanced workflow-backed coding mode",
      "Panels & controls:",
      "/cockpit [overview|workflows|runs|tasks|artifacts|reviews|graft|off] — show Spark cockpit panels",
      "/workflows, /runs, /tasks, /artifacts, /reviews, /graft — open a focused cockpit panel",
      "Extensions",
      `${extensions.length} extension command${extensions.length === 1 ? "" : "s"} available.`,
      ...(extensions.length > 0 ? ["Other registered:"] : []),
      ...extensions,
    ].join("\n");
  }

  private commandAvailabilitySuffix(): string {
    const count = Object.values(this.slashCommands).filter(
      (command) => !isSparkNativeLocalControlCommand(command),
    ).length;
    if (count === 0) return "";
    return " • " + count.toString() + " registered command" + (count === 1 ? "" : "s");
  }

  private extensionStatusSuffix(): string {
    const statuses = [...this.statuses.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, text]) => text.trim())
      .filter(Boolean);
    return statuses.length > 0 ? " • " + statuses.join(" • ") : "";
  }

  private messagePrefix(message: SparkNativeMessage): string {
    if (message.role === "user") {
      if (!message.queued) {
        const senderLabel = userSenderLabelFromDetails(message.details);
        return senderLabel ? `${senderLabel}> ` : "you> ";
      }
      const mode = stringFromRecord(message.details ?? {}, "queueMode");
      return nativeTuiStrings.queuedUserPrefix(mode === "followUp" ? "followUp" : "steer");
    }
    if (message.role === "assistant") return "spark> ";
    if (message.role === "custom") return `custom:${message.customType ?? "custom"}> `;
    if (message.role === "tool") return `tool:${message.toolName ?? "tool"}> `;
    if (message.role === "thinking") return "thinking> ";
    return "system> ";
  }
}
