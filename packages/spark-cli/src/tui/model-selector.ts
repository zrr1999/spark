/**
 * pi-tui SelectList wrapper for Spark model selection.
 *
 * The host-side selection and persistence logic lives in
 * `../host/model-selector.ts`. This file only turns a picker state into a
 * Component that future native TUI boot wiring can mount as an overlay.
 */

import {
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

import {
  sparkModelSelectionFromValue,
  type SparkModelPicker,
  type SparkModelPickerState,
  type SparkModelSelectorItem,
} from "../host/model-selector.ts";
import type { SparkActiveSelection } from "../host/provider-registry.ts";

const plain = (text: string): string => text;

export const PLAIN_SPARK_MODEL_SELECTOR_THEME: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export interface SparkModelSelectorTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface SparkModelSelectorTuiLike {
  requestRender(): void;
}

export interface SparkModelSelectorCustomUi {
  custom?<T>(
    factory: (
      tui: SparkModelSelectorTuiLike,
      theme: SparkModelSelectorTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => Component,
    options?: unknown,
  ): T | Promise<T>;
}

export interface SparkModelSelectorComponentOptions {
  state: SparkModelPickerState;
  title?: string;
  maxVisible?: number;
  theme?: SelectListTheme;
  onSelect: (selection: SparkActiveSelection) => void;
  onCancel?: () => void;
  requestRender?: () => void;
}

export function createSparkModelPickerFromCustomUi(
  ui: SparkModelSelectorCustomUi,
): SparkModelPicker {
  return async (state) => {
    if (typeof ui.custom !== "function") return undefined;
    const result = await ui.custom<SparkActiveSelection | null>(
      (tui, theme, _keybindings, done) =>
        createSparkModelSelectorComponent({
          state,
          theme: selectListThemeFromTheme(theme),
          onSelect: done,
          onCancel: () => done(null),
          requestRender: () => tui.requestRender(),
        }),
      {
        overlay: true,
        overlayOptions: { width: "60%", minWidth: 48, maxHeight: "80%" },
      },
    );
    return result ?? undefined;
  };
}

export function createSparkModelSelectorComponent(
  options: SparkModelSelectorComponentOptions,
): Component {
  return new SparkModelSelectorComponent(options);
}

export function selectListThemeFromTheme(theme: SparkModelSelectorTheme): SelectListTheme {
  const fg = theme.fg ?? ((_color: string, text: string) => text);
  return {
    selectedPrefix: (text) => fg("accent", text),
    selectedText: (text) => fg("accent", text),
    description: (text) => fg("muted", text),
    scrollInfo: (text) => fg("dim", text),
    noMatch: (text) => fg("warning", text),
  };
}

export class SparkModelSelectorComponent implements Component {
  private readonly title: string;
  private readonly requestRender?: () => void;
  private readonly selectList: SelectList;
  private readonly hasItems: boolean;

  constructor(options: SparkModelSelectorComponentOptions) {
    this.title = options.title ?? "Select Model";
    this.requestRender = options.requestRender;
    this.hasItems = options.state.items.length > 0;

    const selectItems = options.state.items.map(toSelectItem);
    this.selectList = new SelectList(
      selectItems,
      Math.min(Math.max(selectItems.length, 1), options.maxVisible ?? 10),
      options.theme ?? PLAIN_SPARK_MODEL_SELECTOR_THEME,
    );

    const activeIndex = options.state.items.findIndex((item) => item.active);
    if (activeIndex >= 0) this.selectList.setSelectedIndex(activeIndex);

    this.selectList.onSelect = (item) => options.onSelect(sparkModelSelectionFromValue(item.value));
    this.selectList.onCancel = () => options.onCancel?.();
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
    this.requestRender?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.title, width));
    lines.push(truncateToWidth("".padEnd(Math.min(width, 80), "─"), width));

    if (this.hasItems) {
      lines.push(...this.selectList.render(width));
    } else {
      lines.push(truncateToWidth("No providers or models registered.", width));
    }

    lines.push(truncateToWidth("↑↓ navigate • enter select • esc cancel", width));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function toSelectItem(item: SparkModelSelectorItem): SelectItem {
  const label = `${item.providerLabel} / ${item.modelLabel}${item.active ? " (active)" : ""}`;
  return {
    value: item.value,
    label,
    description: item.description,
  };
}
