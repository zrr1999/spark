import type { AskConfig } from "./schema.ts";

export interface AskConfigStore {
  load(): AskConfig;
  save(config: AskConfig): void;
}

/** Resolve config file path from home directory. */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions");
const CONFIG_FILE = join(CONFIG_DIR, "spark-ask.json");

export function createAskConfigStore(): AskConfigStore {
  return {
    load() {
      if (!existsSync(CONFIG_FILE)) return getDefaultConfig();
      try {
        const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        return migrateConfig(raw);
      } catch {
        return getDefaultConfig();
      }
    },
    save(config: AskConfig) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
    },
  };
}

export function getDefaultConfig(): AskConfig {
  return {
    schemaVersion: 1,
    behaviour: {
      autoSubmitWhenAnsweredWithoutNotes: false,
      confirmDismissWhenDirty: true,
      showFooterHints: true,
      presentSingleAsMulti: false,
    },
    keymaps: {
      global: { dismiss: ["ctrl+c"], settings: ["?"] },
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
    },
    notifications: {
      enabled: false,
    },
  };
}

function migrateConfig(raw: unknown): AskConfig {
  const config = raw as Partial<AskConfig>;
  const defaults = getDefaultConfig();

  // Ensure schema version
  if (typeof config.schemaVersion !== "number") {
    config.schemaVersion = defaults.schemaVersion;
  }

  // Merge behaviour defaults
  config.behaviour = { ...defaults.behaviour, ...config.behaviour };
  // Merge keymaps defaults (deep merge)
  config.keymaps = {
    ...defaults.keymaps,
    ...config.keymaps,
  };

  return config as AskConfig;
}
