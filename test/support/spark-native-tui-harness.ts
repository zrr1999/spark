import type {
  Component,
  OverlayOptions,
  TUI,
} from "../../apps/spark-tui/src/tui/pi-tui-adapter.ts";
import {
  SparkNativeSession,
  SparkNativeTuiApp,
  type SparkNativeInteractionHandler,
  type SparkNativeResponder,
  type SparkNativeSlashCommandMap,
} from "../../apps/spark-tui/src/native-tui.ts";
import type { SparkKeybindings } from "../../apps/spark-tui/src/host/keybindings.ts";
import type { SparkTheme } from "../../apps/spark-tui/src/host/theme.ts";

export interface FakeSparkNativeTuiState {
  readonly children: Component[];
  readonly overlays: Array<{ component: Component; options?: OverlayOptions; visible: boolean }>;
  readonly renderRequests: boolean[];
  focused: unknown;
  exited: boolean;
}

export interface SparkNativeTuiHarness {
  readonly tui: TUI;
  readonly app: SparkNativeTuiApp;
  readonly session: SparkNativeSession;
  readonly state: FakeSparkNativeTuiState;
  readonly width: number;
  render(width?: number): string;
  renderLines(width?: number): string[];
  press(data: string): Promise<void>;
  submit(input: string): Promise<Awaited<ReturnType<SparkNativeTuiApp["submitInput"]>>>;
  flush(): Promise<void>;
}

export interface SparkNativeTuiHarnessOptions {
  rows?: number;
  cols?: number;
  responder?: SparkNativeResponder;
  slashCommands?: SparkNativeSlashCommandMap;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  keybindings?: SparkKeybindings;
  theme?: SparkTheme;
  withOverlay?: boolean;
}

export function createSparkNativeTuiHarness(
  options: SparkNativeTuiHarnessOptions = {},
): SparkNativeTuiHarness {
  const width = options.cols ?? 100;
  const state: FakeSparkNativeTuiState = {
    children: [],
    overlays: [],
    renderRequests: [],
    focused: undefined,
    exited: false,
  };
  const fakeTui = {
    terminal: { rows: options.rows ?? 30, cols: width },
    requestRender(force?: boolean) {
      state.renderRequests.push(force === true);
    },
    addChild(component: Component) {
      state.children.push(component);
    },
    removeChild(component: Component) {
      const index = state.children.indexOf(component);
      if (index >= 0) state.children.splice(index, 1);
    },
    setFocus(component: unknown) {
      state.focused = component;
    },
    showOverlay: options.withOverlay
      ? (component: Component, overlayOptions?: OverlayOptions) => {
          const entry = { component, options: overlayOptions, visible: true };
          state.overlays.push(entry);
          state.focused = component;
          return {
            hide() {
              entry.visible = false;
              state.renderRequests.push(false);
            },
          };
        }
      : undefined,
  } as unknown as TUI;

  const session = new SparkNativeSession(options.responder);
  const app = new SparkNativeTuiApp(
    fakeTui,
    session,
    () => {
      state.exited = true;
    },
    options,
  );

  return {
    tui: fakeTui,
    app,
    session,
    state,
    width,
    render(renderWidth = width) {
      return app.render(renderWidth).join("\n");
    },
    renderLines(renderWidth = width) {
      return app.render(renderWidth);
    },
    async press(data: string) {
      app.handleInput(data);
      await flushNativeTuiMicrotasks();
    },
    async submit(input: string) {
      const result = await app.submitInput(input);
      await flushNativeTuiMicrotasks();
      return result;
    },
    flush: flushNativeTuiMicrotasks,
  };
}

export async function flushNativeTuiMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
