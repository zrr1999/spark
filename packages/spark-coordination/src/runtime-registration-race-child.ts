import { DatabaseSync } from "node:sqlite";
import {
  registerRuntimeWorkspace,
  RuntimeWorkspaceOwnerConflictError,
} from "./runtime-registration.ts";

interface RaceRegistrationInput {
  databasePath: string;
  runtimeId: string;
  runtimeToken: string;
  localWorkspaceKey: string;
}

process.on("message", (message: RaceRegistrationInput) => {
  const db = new DatabaseSync(message.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    registerRuntimeWorkspace(
      db,
      message.runtimeId,
      {
        workspaceRegistration: {
          localWorkspaceKey: message.localWorkspaceKey,
          displayName: message.localWorkspaceKey,
          workspaceSlug: "shared-race-workspace",
        },
      },
      message.runtimeToken,
    );
    process.send?.({ ok: true });
  } catch (error) {
    process.send?.({
      ok: false,
      reasonCode:
        error instanceof RuntimeWorkspaceOwnerConflictError
          ? error.reasonCode
          : "UNEXPECTED_REGISTRATION_ERROR",
    });
  } finally {
    db.close();
    process.disconnect?.();
  }
});

process.send?.({ ready: true });
