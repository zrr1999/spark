import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "./pi-tui-adapter.ts";
import type { SparkActionBarView, SparkActionView } from "@zendev-lab/spark-protocol";

export interface SparkTuiActionBarTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface SparkTuiActionAvailability {
  disabled: boolean;
  reason?: string;
}

export interface SparkTuiActionBarComponentOptions {
  view: SparkActionBarView;
  theme?: SparkTuiActionBarTheme;
  resolveAvailability?: (action: SparkActionView) => SparkTuiActionAvailability;
  onAction: (action: SparkActionView) => void | Promise<void>;
  onCancel?: () => void;
  requestRender?: () => void;
}

const ACTION_AVAILABLE: SparkTuiActionAvailability = Object.freeze({ disabled: false });

/** Compact, focusable action sheet used by no-argument slash commands. */
export class SparkTuiActionBarComponent implements Component, Focusable {
  focused = false;

  private readonly view: SparkActionBarView;
  private readonly theme: SparkTuiActionBarTheme;
  private readonly resolveAvailability?: SparkTuiActionBarComponentOptions["resolveAvailability"];
  private readonly onAction: SparkTuiActionBarComponentOptions["onAction"];
  private readonly onCancel?: () => void;
  private readonly requestRender?: () => void;
  private selectedIndex = 0;
  private confirmingDangerActionId: string | undefined;

  constructor(options: SparkTuiActionBarComponentOptions) {
    this.view = options.view;
    this.theme = options.theme ?? {};
    this.resolveAvailability = options.resolveAvailability;
    this.onAction = options.onAction;
    this.onCancel = options.onCancel;
    this.requestRender = options.requestRender;
  }

  get selectedAction(): SparkActionView | undefined {
    return this.view.actions[this.selectedIndex];
  }

  get selectedAvailability(): SparkTuiActionAvailability {
    const action = this.selectedAction;
    return action ? this.availability(action) : ACTION_AVAILABLE;
  }

  get pendingDangerActionId(): string | undefined {
    return this.confirmingDangerActionId;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "h" || data === "k") {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "l" || data === "j") {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const action = this.selectedAction;
      if (!action || this.availability(action).disabled) {
        this.requestRender?.();
        return;
      }
      if (action.tone === "danger" && this.confirmingDangerActionId !== action.id) {
        this.confirmingDangerActionId = action.id;
        this.requestRender?.();
        return;
      }
      this.confirmingDangerActionId = undefined;
      void this.onAction(action);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.confirmingDangerActionId = undefined;
      this.onCancel?.();
      this.requestRender?.();
    }
  }

  render(width: number): string[] {
    const usableWidth = Math.max(1, width);
    const selected = this.selectedAction;
    const title = this.theme.bold?.(this.view.title) ?? this.view.title;
    const lines = [truncateToWidth(title, usableWidth)];
    if (this.view.description) {
      lines.push(truncateToWidth(this.muted(this.view.description), usableWidth));
    }
    lines.push(truncateToWidth(this.renderActions(usableWidth), usableWidth));
    const selectedAvailability = selected ? this.availability(selected) : ACTION_AVAILABLE;
    if (selected && this.confirmingDangerActionId === selected.id) {
      lines.push(
        truncateToWidth(
          this.danger(`Confirm ${selected.label}: press Enter again to run.`),
          usableWidth,
        ),
      );
    } else if (selectedAvailability.disabled) {
      lines.push(
        truncateToWidth(
          this.muted(`Unavailable: ${selectedAvailability.reason ?? "not available here"}`),
          usableWidth,
        ),
      );
    } else if (selected?.description) {
      lines.push(truncateToWidth(this.muted(selected.description), usableWidth));
    }
    const hint = this.confirmingDangerActionId
      ? "Enter confirm • Esc cancel/close"
      : "←/→/↑/↓ select • Enter run • Esc close";
    lines.push(truncateToWidth(this.muted(hint), usableWidth));
    return lines;
  }

  private moveSelection(delta: number): void {
    if (this.view.actions.length === 0) return;
    this.confirmingDangerActionId = undefined;
    this.selectedIndex =
      (this.selectedIndex + delta + this.view.actions.length) % this.view.actions.length;
    this.requestRender?.();
  }

  private renderActions(width: number): string {
    if (this.view.actions.length === 0) return this.muted("No actions available");
    const tokens = this.view.actions.map((action, index) => this.renderAction(action, index));
    let start = this.selectedIndex;
    let end = this.selectedIndex + 1;
    let rendered = tokens[this.selectedIndex] ?? "";
    let preferRight = true;
    while (start > 0 || end < tokens.length) {
      const canTakeRight = end < tokens.length;
      const candidateIndex = preferRight && canTakeRight ? end : start - 1;
      if (candidateIndex < 0 || candidateIndex >= tokens.length) {
        preferRight = !preferRight;
        continue;
      }
      const candidateStart = Math.min(start, candidateIndex);
      const candidateEnd = Math.max(end, candidateIndex + 1);
      const candidate = this.joinActionTokens(tokens, candidateStart, candidateEnd);
      const ellipsisWidth = (candidateStart > 0 ? 2 : 0) + (candidateEnd < tokens.length ? 2 : 0);
      if (visibleWidth(candidate) + ellipsisWidth > width) break;
      start = candidateStart;
      end = candidateEnd;
      rendered = candidate;
      preferRight = !preferRight;
    }
    return `${start > 0 ? "… " : ""}${rendered}${end < tokens.length ? " …" : ""}`;
  }

  private joinActionTokens(tokens: readonly string[], start: number, end: number): string {
    return tokens.slice(start, end).join(this.muted(" • "));
  }

  private renderAction(action: SparkActionView, index: number): string {
    const selected = index === this.selectedIndex;
    const availability = this.availability(action);
    if (availability.disabled) {
      return this.muted(
        selected ? `> × ${action.label} unavailable` : ` × ${action.label} unavailable `,
      );
    }
    const confirming = selected && this.confirmingDangerActionId === action.id;
    const label = confirming ? `Confirm ${action.label}?` : action.label;
    const token = selected ? `[${label}]` : ` ${label} `;
    if (action.tone === "danger") return this.danger(token);
    return selected ? this.accent(token) : this.muted(token);
  }

  private availability(action: SparkActionView): SparkTuiActionAvailability {
    return this.resolveAvailability?.(action) ?? ACTION_AVAILABLE;
  }

  private accent(text: string): string {
    return this.theme.fg?.("accent", text) ?? text;
  }

  private muted(text: string): string {
    return this.theme.fg?.("muted", text) ?? text;
  }

  private danger(text: string): string {
    return this.theme.fg?.("error", text) ?? text;
  }
}

export function createSparkTuiActionBarComponent(
  options: SparkTuiActionBarComponentOptions,
): SparkTuiActionBarComponent {
  return new SparkTuiActionBarComponent(options);
}
