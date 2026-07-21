import { goto, invalidateAll } from "$app/navigation";
import { tick } from "svelte";
import {
  cockpitOpenSearchEvent,
  cockpitSessionSelectionShortcutForInput,
  scheduleCockpitActionAfterCurrentEvent,
  type CockpitSlashCommandSuggestion,
} from "$lib/slash-actions";
import {
  sparkThinkingLevelOptions,
  type SparkActionView,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { ComposerController } from "./composer.svelte";
import type { ComposerSurface } from "./types";

export type SlashHandlerDeps = {
  composer: ComposerController;
  getSessionsHref: () => string;
  getStartSlashSuggestions: () => readonly CockpitSlashCommandSuggestion[];
  getSessionSlashSuggestions: () => readonly CockpitSlashCommandSuggestion[];
  isSlashActionEnabled: (action: SparkActionView, surface: ComposerSurface) => boolean;
  getLatestRetryPrompt: () => string | null;
  retryConversationTurn: (prompt: string) => void;
  submitThinkingSelection: () => Promise<void>;
};

function thinkingLevelFromAction(action: SparkActionView): SparkThinkingLevel | null {
  const candidate = action.payload.thinkingLevel;
  return typeof candidate === "string" &&
    (sparkThinkingLevelOptions as readonly string[]).includes(candidate)
    ? (candidate as SparkThinkingLevel)
    : null;
}

function firstVisibleElement(selector: string): HTMLElement | null {
  const elements = [...document.querySelectorAll<HTMLElement>(selector)];
  return elements.find((element) => element.getClientRects().length > 0) ?? elements[0] ?? null;
}

function focusSurface(selector: string): boolean {
  const target = firstVisibleElement(selector);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  target.focus({ preventScroll: true });
  return true;
}

function showQueueSurface(): boolean {
  const queue = firstVisibleElement("[data-session-queue]");
  if (!queue) return false;
  const details = queue.querySelector("details");
  if (details) details.open = true;
  const target = queue.querySelector<HTMLElement>(".queue-scroll") ?? queue;
  target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  target.focus({ preventScroll: true });
  return true;
}

function showSessionInspector(): boolean {
  const mobileDetails = firstVisibleElement("details.mobile-details");
  if (mobileDetails instanceof HTMLDetailsElement) mobileDetails.open = true;
  return focusSurface("[data-session-inspector-surface]");
}

export function createSlashHandlers(deps: SlashHandlerDeps) {
  const { composer } = deps;

  function clearSlashInput(surface: ComposerSurface) {
    if (surface === "start") {
      composer.startMessage = "";
      composer.startFeedback = null;
    } else {
      composer.message = "";
      composer.sendFeedback = null;
    }
    composer.renewSubmissionId(surface);
  }

  function openModelPickerAfterSlashAction(surface: ComposerSurface) {
    scheduleCockpitActionAfterCurrentEvent(() => {
      if (surface === "start") composer.startModelPickerOpen = true;
      else composer.sessionModelPickerOpen = true;
    });
  }

  function selectSlashSuggestion(
    suggestion: Readonly<{ command: string }>,
    surface: ComposerSurface,
  ) {
    const nextValue = `/${suggestion.command}`;
    if (surface === "start") {
      composer.startMessage = nextValue;
      composer.startSlashDismissedInput = null;
      composer.handleStartMessageChange(nextValue);
      return;
    }

    composer.message = nextValue;
    composer.sessionSlashDismissedInput = null;
    composer.handleSessionMessageChange(nextValue);
  }

  function handleSlashCompletionKeydown(event: KeyboardEvent, surface: ComposerSurface) {
    if (event.isComposing) return;
    const input = surface === "start" ? composer.startMessage : composer.message;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      cockpitSessionSelectionShortcutForInput(input)
    ) {
      event.preventDefault();
      clearSlashInput(surface);
      void goto(deps.getSessionsHref());
      return;
    }
    const suggestions =
      surface === "start" ? deps.getStartSlashSuggestions() : deps.getSessionSlashSuggestions();
    if (suggestions.length === 0) return;

    const activeIndex =
      surface === "start" ? composer.startSlashActiveIndex : composer.sessionSlashActiveIndex;
    const setActiveIndex = (index: number) => {
      if (surface === "start") composer.startSlashActiveIndex = index;
      else composer.sessionSlashActiveIndex = index;
    };

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((activeIndex + direction + suggestions.length) % suggestions.length);
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const suggestion = suggestions[Math.min(activeIndex, suggestions.length - 1)];
      if (suggestion) selectSlashSuggestion(suggestion, surface);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setActiveIndex(0);
      if (surface === "start") composer.startSlashDismissedInput = composer.startMessage;
      else composer.sessionSlashDismissedInput = composer.message;
    }
  }

  async function handleSlashAction(action: SparkActionView, surface: ComposerSurface) {
    if (!deps.isSlashActionEnabled(action, surface)) return;

    if (action.intent === "model.select") {
      clearSlashInput(surface);
      await tick();
      openModelPickerAfterSlashAction(surface);
      return;
    }

    if (action.intent === "thinking.select") {
      const thinkingLevel = thinkingLevelFromAction(action);
      clearSlashInput(surface);
      if (!thinkingLevel) {
        await tick();
        openModelPickerAfterSlashAction(surface);
        return;
      }
      if (surface === "start") {
        composer.startThinkingLevel = thinkingLevel;
        return;
      }
      composer.sessionThinkingLevel = thinkingLevel;
      await deps.submitThinkingSelection();
      return;
    }

    if (action.intent === "settings.inspect" || action.intent === "settings.providers") {
      clearSlashInput(surface);
      await goto(action.intent === "settings.providers" ? "/settings/models" : "/settings");
      return;
    }

    if (action.intent === "session.create") {
      clearSlashInput(surface);
      await goto(`${deps.getSessionsHref()}?new=workspace`);
      return;
    }

    if (action.intent === "session.select") {
      clearSlashInput(surface);
      await goto(deps.getSessionsHref());
      return;
    }

    if (action.intent === "help.commands") {
      clearSlashInput(surface);
      window.dispatchEvent(new CustomEvent(cockpitOpenSearchEvent));
      return;
    }

    if (action.intent === "status.inspect") {
      clearSlashInput(surface);
      await invalidateAll();
      await tick();
      if (!focusSurface("[data-session-status-bar]")) showSessionInspector();
      return;
    }

    if (action.intent === "session.inspect") {
      clearSlashInput(surface);
      await tick();
      showSessionInspector();
      return;
    }

    if (action.intent === "queue.inspect") {
      clearSlashInput(surface);
      await tick();
      showQueueSurface();
      return;
    }

    if (action.intent === "turn.stop") {
      clearSlashInput(surface);
      await tick();
      document.querySelector<HTMLFormElement>("#session-cancel-turn-form")?.requestSubmit();
      return;
    }

    const latestRetryPrompt = deps.getLatestRetryPrompt();
    if (action.intent === "turn.retry" && latestRetryPrompt) {
      clearSlashInput(surface);
      deps.retryConversationTurn(latestRetryPrompt);
    }
  }

  return {
    selectSlashSuggestion,
    handleSlashCompletionKeydown,
    handleSlashAction,
  };
}
