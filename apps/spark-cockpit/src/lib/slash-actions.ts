import type { CockpitMessages } from "@zendev-lab/spark-i18n";
import {
  parseSparkSlashInput,
  resolveSparkSlashEditorInput,
  sparkSlashActionBarCatalog,
  type SparkActionBarView,
} from "@zendev-lab/spark-protocol";

export const cockpitOpenSearchEvent = "spark-cockpit:open-search";

export type CockpitActionScheduler = (callback: () => void) => unknown;
export type CockpitComposerSubmissionState = "idle" | "submitting" | "success" | "error";

export type CockpitComposerFeedbackTransition = Readonly<{
  state: CockpitComposerSubmissionState;
  clearFeedback: boolean;
}>;

export type CockpitSlashActionMessages = CockpitMessages["sessions"]["workbench"]["slashActions"];

export type CockpitSlashCommandSuggestion = Readonly<{
  id: string;
  command: string;
  canonicalCommand: string;
  title: string;
  description?: string;
}>;

export function cockpitComposerFeedbackAfterInput(
  state: CockpitComposerSubmissionState,
): CockpitComposerFeedbackTransition {
  if (state === "submitting") return { state, clearFeedback: false };
  return {
    state: state === "error" || state === "success" ? "idle" : state,
    clearFeedback: true,
  };
}

/**
 * Defer a dialog-opening action until the click that selected the slash action
 * has finished. Otherwise the dialog can observe that same click as an outside
 * interaction and immediately close itself.
 */
export function scheduleCockpitActionAfterCurrentEvent(
  action: () => void,
  schedule: CockpitActionScheduler = (callback) => requestAnimationFrame(callback),
): void {
  schedule(action);
}

/** Replace protocol fallback copy with the active Cockpit locale. */
export function localizeCockpitSlashActionBar(
  view: SparkActionBarView,
  messages: CockpitSlashActionMessages,
): SparkActionBarView {
  const { description: _description, ...rest } = view;
  const description = lookup(messages.descriptions, view.id);
  return {
    ...rest,
    title: lookup(messages.titles, view.id) ?? messages.fallbackTitle,
    ...(description ? { description } : {}),
    actions: view.actions.map(({ description: _actionDescription, ...action }) => ({
      ...action,
      label: lookup(messages.actions, action.id) ?? messages.fallbackAction,
    })),
  };
}

/** Build localized, de-duplicated suggestions for the current editor value. */
export function cockpitSlashSuggestionsForInput(
  input: string,
  messages: CockpitSlashActionMessages,
): readonly CockpitSlashCommandSuggestion[] {
  const resolution = resolveSparkSlashEditorInput(input);
  if (resolution.kind !== "suggest") return [];

  return resolution.suggestions.map((suggestion) => {
    const view = localizeCockpitSlashActionBar(suggestion.descriptor.actionBar, messages);
    return {
      id: `${suggestion.canonicalCommand}:${suggestion.command}`,
      command: suggestion.command,
      canonicalCommand: suggestion.canonicalCommand,
      title: view.title,
      ...(view.description ? { description: view.description } : {}),
    };
  });
}

/** Match a known command name even when arguments are present. */
export function cockpitSlashCatalogActionBarForInput(
  input: string,
): SparkActionBarView | undefined {
  const parsed = parseSparkSlashInput(input);
  return parsed ? sparkSlashActionBarCatalog[parsed.command] : undefined;
}

export function cockpitSlashSubmissionError(
  input: string,
  messages: CockpitSlashActionMessages,
): string | null {
  const parsed = parseSparkSlashInput(input);
  if (!parsed) return null;
  const view = sparkSlashActionBarCatalog[parsed.command];
  if (!view) {
    return messages.unsupportedRejected.replace("{command}", parsed.command);
  }
  const title = localizeCockpitSlashActionBar(view, messages).title;
  return messages.serverRejected.replace("{title}", title);
}

function lookup(values: object, key: string): string | undefined {
  const candidate = (values as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}
