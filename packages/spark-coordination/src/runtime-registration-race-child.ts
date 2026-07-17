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
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(message.databasePath);
    // Install the busy handler before WAL setup because concurrent connections
    // may need to wait while SQLite reads or changes the journal mode.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
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
    db?.close();
    process.disconnect?.();
  }
});

process.send?.({ ready: true });
