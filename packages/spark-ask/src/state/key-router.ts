import type { AskAction } from "./reducer.ts";

/**
 * Context-aware keymap. Each context has its own set of bindings.
 */

export type KeyBinding = string | string[];

export interface Keymap {
  global: Record<string, KeyBinding>;
  main: Record<string, KeyBinding>;
  editor: Record<string, KeyBinding>;
  noteEditor: Record<string, KeyBinding>;
  submitTab: Record<string, KeyBinding>;
  settingsModal: Record<string, KeyBinding>;
}

export const DEFAULT_KEYMAP: Keymap = {
  global: {
    dismiss: ["ctrl+c"],
    settings: ["?"],
  },
  main: {
    confirm: ["enter"],
    cancel: ["esc"],
    toggle: ["space"],
    toggleQuestionType: ["t"],
    nextTab: ["tab", "right"],
    previousTab: ["shift+tab", "left"],
    nextOption: ["down"],
    previousOption: ["up"],
    optionNote: ["n"],
    questionNote: ["shift+n"],
    jumpSubmit: ["ctrl+s"],
  },
  editor: {
    submit: ["enter"],
    close: ["esc"],
    nextTabWhenEmpty: ["tab", "right"],
    previousTabWhenEmpty: ["shift+tab", "left"],
    nextOptionWhenEmpty: ["down"],
    previousOptionWhenEmpty: ["up"],
  },
  noteEditor: {
    save: ["enter"],
    close: ["esc"],
    nextTabWhenEmpty: ["tab", "right"],
    previousTabWhenEmpty: ["shift+tab", "left"],
    nextOptionWhenEmpty: ["down"],
    previousOptionWhenEmpty: ["up"],
  },
  submitTab: {
    submit: ["enter", "1"],
    elaborate: ["2"],
    cancel: ["esc", "ctrl+c", "3"],
    nextOption: ["down"],
    previousOption: ["up"],
  },
  settingsModal: {
    close: ["esc", "ctrl+c", "?"],
    nextOption: ["down"],
    previousOption: ["up"],
    toggle: ["enter", "space"],
  },
};

export interface KeyRouteResult {
  action: AskAction | null;
  consumed: boolean;
}

/**
 * Determine the active keymap context based on state.
 */
export type KeymapContext = "main" | "editor" | "noteEditor" | "submitTab" | "settingsModal";

export function getKeymapContext(
  settingsOpen: boolean,
  inputMode: boolean,
  notesVisible: boolean,
  isSubmit: boolean,
): KeymapContext {
  if (settingsOpen) return "settingsModal";
  if (notesVisible) return "noteEditor";
  if (inputMode) return "editor";
  if (isSubmit) return "submitTab";
  return "main";
}

/**
 * Route a key event to an AskAction based on the active context.
 */
export function routeKey(
  keyData: string,
  context: KeymapContext,
  keymap: Keymap,
  _inputBuffer: string,
): KeyRouteResult {
  // Global actions are always checked first
  const globalMap = keymap.global;
  for (const [actionName, bindings] of Object.entries(globalMap)) {
    if (matchesKey(keyData, bindings)) {
      const action = routeGlobalAction(actionName);
      if (action) return { action, consumed: true };
    }
  }

  // Number shortcuts (1-9) work in main and submitTab contexts
  if (context === "main" || context === "submitTab") {
    const num = parseInt(keyData, 10);
    if (num >= 1 && num <= 9) {
      return { action: { kind: "apply_number_shortcut", index: num - 1 }, consumed: true };
    }
  }

  // Context-specific bindings
  const contextMap = getContextMap(keymap, context);
  if (!contextMap) return { action: null, consumed: false };

  for (const [actionName, bindings] of Object.entries(contextMap)) {
    if (matchesKey(keyData, bindings)) {
      const action = routeContextAction(actionName, context);
      if (action) return { action, consumed: true };
    }
  }

  return { action: null, consumed: false };
}

function getContextMap(
  keymap: Keymap,
  context: KeymapContext,
): Record<string, KeyBinding> | undefined {
  switch (context) {
    case "main":
      return keymap.main;
    case "editor":
      return keymap.editor;
    case "noteEditor":
      return keymap.noteEditor;
    case "submitTab":
      return keymap.submitTab;
    case "settingsModal":
      return keymap.settingsModal;
  }
}

function matchesKey(data: string, binding: KeyBinding): boolean {
  const normalized = normalizeKey(data);
  if (typeof binding === "string") return normalized === normalizeKey(binding);
  return binding.some((b) => normalized === normalizeKey(b));
}

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/escape/g, "esc")
    .replace(/return/g, "enter")
    .replace(/control\+/g, "ctrl+")
    .trim();
}

function routeGlobalAction(name: string): AskAction | null {
  switch (name) {
    case "dismiss":
      return { kind: "cancel" };
    case "settings":
      return { kind: "open_settings" };
    default:
      return null;
  }
}

function routeContextAction(name: string, context: KeymapContext): AskAction | null {
  switch (context) {
    case "main":
      return routeMainAction(name);
    case "editor":
      return routeEditorAction(name);
    case "noteEditor":
      return routeNoteEditorAction(name);
    case "submitTab":
      return routeSubmitTabAction(name);
    case "settingsModal":
      return routeSettingsAction(name);
  }
}

function routeMainAction(name: string): AskAction | null {
  switch (name) {
    case "confirm":
      return { kind: "select_option" };
    case "cancel":
      return { kind: "cancel" };
    case "toggle":
      return { kind: "toggle_multi_option" };
    case "toggleQuestionType":
      return { kind: "toggle_question_type" };
    case "nextTab":
      return { kind: "move_tab", direction: 1 };
    case "previousTab":
      return { kind: "move_tab", direction: -1 };
    case "nextOption":
      return { kind: "move_option", direction: 1 };
    case "previousOption":
      return { kind: "move_option", direction: -1 };
    case "optionNote":
      // This needs the questionId - the caller must handle this
      return null;
    case "questionNote":
      return null;
    case "jumpSubmit":
      return { kind: "move_tab", direction: "submit" };
    default:
      return null;
  }
}

function routeEditorAction(name: string): AskAction | null {
  switch (name) {
    case "submit":
      return { kind: "commit_input" };
    case "close":
      return { kind: "cancel" };
    case "nextTabWhenEmpty":
      return { kind: "move_tab", direction: 1 };
    case "previousTabWhenEmpty":
      return { kind: "move_tab", direction: -1 };
    case "nextOptionWhenEmpty":
      return { kind: "move_option", direction: 1 };
    case "previousOptionWhenEmpty":
      return { kind: "move_option", direction: -1 };
    default:
      return null;
  }
}

function routeNoteEditorAction(name: string): AskAction | null {
  switch (name) {
    case "save":
      return { kind: "commit_notes", questionId: "" }; // questionId filled by controller
    case "close":
      return { kind: "close_notes" };
    case "nextTabWhenEmpty":
      return { kind: "move_tab", direction: 1 };
    case "previousTabWhenEmpty":
      return { kind: "move_tab", direction: -1 };
    case "nextOptionWhenEmpty":
      return { kind: "move_option", direction: 1 };
    case "previousOptionWhenEmpty":
      return { kind: "move_option", direction: -1 };
    default:
      return null;
  }
}

function routeSubmitTabAction(name: string): AskAction | null {
  switch (name) {
    case "submit":
      return { kind: "submit" };
    case "elaborate":
      return { kind: "elaborate" };
    case "cancel":
      return { kind: "cancel" };
    case "nextOption":
      return { kind: "move_submit_choice", direction: 1 };
    case "previousOption":
      return { kind: "move_submit_choice", direction: -1 };
    default:
      return null;
  }
}

function routeSettingsAction(name: string): AskAction | null {
  switch (name) {
    case "close":
      return { kind: "close_settings" };
    case "nextOption":
      return { kind: "move_option", direction: 1 };
    case "previousOption":
      return { kind: "move_option", direction: -1 };
    case "toggle":
      return { kind: "select_option" };
    default:
      return null;
  }
}
