import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AskConfig, AskConfigStore } from "./schema.ts";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions");
const CONFIG_FILE = join(CONFIG_DIR, "pi-ask.json");

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
      writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    },
  };
}

export function getDefaultConfig(): AskConfig {
  return { schemaVersion: 1 };
}

function migrateConfig(raw: unknown): AskConfig {
  const config = raw as Partial<AskConfig>;
  return {
    schemaVersion: typeof config.schemaVersion === "number" ? config.schemaVersion : 1,
  };
}
