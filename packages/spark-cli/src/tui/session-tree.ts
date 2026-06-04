/** pi-tui SelectList wrapper for Spark session branch trees. */

import {
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

import type { SparkSessionTreeRow } from "../host/session-navigation.ts";

const plain = (text: string): string => text;

export const PLAIN_SPARK_SESSION_TREE_THEME: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export interface SparkSessionTreeComponentOptions {
  rows: SparkSessionTreeRow[];
  title?: string;
  maxVisible?: number;
  theme?: SelectListTheme;
  onSelect: (leafId: string) => void;
  onCancel?: () => void;
  requestRender?: () => void;
}

export function createSparkSessionTreeComponent(
  options: SparkSessionTreeComponentOptions,
): Component {
  return new SparkSessionTreeComponent(options);
}

export class SparkSessionTreeComponent implements Component {
  private readonly title: string;
  private readonly requestRender?: () => void;
  private readonly selectList: SelectList;
  private readonly hasRows: boolean;

  constructor(options: SparkSessionTreeComponentOptions) {
    this.title = options.title ?? "Session Branches";
    this.requestRender = options.requestRender;
    this.hasRows = options.rows.length > 0;
    const items = options.rows.map(toSelectItem);
    this.selectList = new SelectList(
      items,
      Math.min(Math.max(items.length, 1), options.maxVisible ?? 12),
      options.theme ?? PLAIN_SPARK_SESSION_TREE_THEME,
    );
    const activeIndex = options.rows.findIndex((row) => row.active);
    if (activeIndex >= 0) this.selectList.setSelectedIndex(activeIndex);
    this.selectList.onSelect = (item) => options.onSelect(item.value);
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
    const lines = [
      truncateToWidth(this.title, width),
      truncateToWidth("".padEnd(Math.min(width, 80), "─"), width),
    ];
    if (this.hasRows) lines.push(...this.selectList.render(width));
    else lines.push(truncateToWidth("Session branch tree is empty.", width));
    lines.push(truncateToWidth("↑↓ navigate • enter switch • esc cancel", width));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function toSelectItem(row: SparkSessionTreeRow): SelectItem {
  const branch = `${"  ".repeat(row.depth)}${row.active ? "* " : "  "}${row.label}`;
  return {
    value: row.id,
    label: branch,
    description: `${row.id} • ${row.description}`,
  };
}
