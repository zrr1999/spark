/** Process-terminal entrypoint for the native Spark TUI. */

import { ProcessTerminal, TUI } from "../tui/pi-tui-adapter.ts";
import type { SparkKeybindingContext, SparkKeybindings } from "../host/keybindings.ts";
import type { SparkTheme } from "../host/theme.ts";
import type { SparkHostMessageRenderer } from "../host/types.ts";
import { SparkNativeTuiApp } from "./app.ts";
import { SparkNativeSession } from "./session.ts";
import { nativeTuiStrings } from "./strings.ts";
import type {
  SparkNativeInteractionHandler,
  SparkNativeResponder,
  SparkNativeSlashCommandMap,
  SparkNativeStatusContext,
  SparkNativeWorkspaceSessionState,
} from "./types.ts";

export interface RunNativeSparkTuiOptions {
  initialMessage?: string;
  responder?: SparkNativeResponder;
  slashCommands?: SparkNativeSlashCommandMap;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  theme?: SparkTheme;
  workspaceSession?: SparkNativeWorkspaceSessionState;
  statusContext?: SparkNativeStatusContext;
  configureApp?: (app: SparkNativeTuiApp, session: SparkNativeSession) => void | Promise<void>;
}

export async function runNativeSparkTui(input?: string | RunNativeSparkTuiOptions): Promise<void> {
  const options = typeof input === "string" ? { initialMessage: input } : (input ?? {});
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const session = new SparkNativeSession(options.responder);

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = () => resolveDone?.();

  const app = new SparkNativeTuiApp(tui, session, stop, {
    slashCommands: options.slashCommands,
    autocompleteBasePath: options.autocompleteBasePath,
    autocompleteFdPath: options.autocompleteFdPath,
    interactionHandler: options.interactionHandler,
    keybindings: options.keybindings,
    keybindingContext: options.keybindingContext,
    messageRenderers: options.messageRenderers,
    statusContext: options.statusContext,
    theme: options.theme,
    workspaceSession: options.workspaceSession,
  });
  await options.configureApp?.(app, session);
  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle(nativeTuiStrings.appTitle);
  tui.start();
  tui.requestRender(true);

  if (options.initialMessage) {
    queueMicrotask(() => void session.submit(options.initialMessage!));
  }

  await done;
  app.dispose();
  tui.stop();
  await terminal.drainInput();
}
