/** Native widget normalization and TUI bridge helpers. */

import type { Component, TUI } from "../tui/pi-tui-adapter.ts";
import type { SparkHostRenderTheme } from "../host/types.ts";
import { nativeTuiStrings } from "./strings.ts";
import { MAX_NATIVE_WIDGET_LINES, type SparkNativeWidgetComponent } from "./types.ts";

export function normalizeNativeWidgetLines(content: unknown): string[] {
  if (content === undefined || content === null || content === false) return [];
  const rawLines = nativeWidgetContentToLines(content);
  return normalizeNativeWidgetRenderedLines(rawLines);
}

export function normalizeNativeWidgetRenderedLines(lines: readonly unknown[]): string[] {
  return lines
    .flatMap((line) => String(line).split("\n"))
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, MAX_NATIVE_WIDGET_LINES);
}

export function nativeWidgetContentToLines(content: unknown): string[] {
  if (Array.isArray(content)) return content.flatMap((line) => String(line).split("\n"));
  if (typeof content === "string") return content.split("\n");
  return [JSON.stringify(content) ?? Object.prototype.toString.call(content)];
}

type NativeWidgetFactory = (
  tui: { terminal: { columns: number }; requestRender(): void },
  theme: SparkHostRenderTheme,
) => Component | { render(width?: number): string[]; invalidate?(): void } | undefined;

export function createNativeWidgetComponent(
  content: NativeWidgetFactory,
  tui: TUI,
  theme: SparkHostRenderTheme,
  onRequestRender: () => void,
): SparkNativeWidgetComponent | undefined {
  try {
    const widgetTheme = {
      ...theme,
      strikethrough: theme.strikethrough
        ? (text: string) => theme.strikethrough?.(text) ?? text
        : (text: string) => text,
    };
    const component = content(createNativeWidgetTui(tui, onRequestRender), widgetTheme);
    if (!component || typeof component.render !== "function") return undefined;
    return component;
  } catch (error) {
    const message = nativeTuiStrings.widgetRenderFailed(
      error instanceof Error ? error.message : String(error),
    );
    return { render: () => [message] };
  }
}

export function renderNativeWidgetComponent(
  component: SparkNativeWidgetComponent,
  width: number,
): string[] {
  try {
    return normalizeNativeWidgetRenderedLines(component.render(width));
  } catch (error) {
    return [
      nativeTuiStrings.widgetRenderFailed(error instanceof Error ? error.message : String(error)),
    ];
  }
}

export function createNativeWidgetTui(
  tui: TUI,
  onRequestRender?: () => void,
): { terminal: { columns: number }; requestRender(): void } {
  return {
    terminal: {
      get columns() {
        return widgetTuiColumns(tui);
      },
    },
    requestRender: () => {
      onRequestRender?.();
      tui.requestRender();
    },
  };
}

export function widgetTuiColumns(tui: TUI): number {
  const terminal = (tui as { terminal?: { columns?: number; cols?: number } }).terminal;
  return terminal?.columns ?? terminal?.cols ?? 80;
}
