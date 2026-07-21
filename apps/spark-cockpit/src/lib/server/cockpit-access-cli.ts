import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createCockpitAccessToken,
  listCockpitAccessTokens,
  revokeCockpitAccessToken,
  type CockpitAccessTokenSummary,
} from "@zendev-lab/spark-cockpit-coordination/cockpit-access";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-cockpit-db";

export type CockpitAccessOperation = "create" | "list" | "revoke";

export interface CockpitAccessCliCommand {
  operation: string;
  databasePath?: string;
  label?: string;
  tokenId?: string;
  json?: boolean;
}

export interface CockpitAccessCreateResult {
  plane: "cockpit";
  resource: "access";
  operation: "create";
  status: "created";
  tokenId: string;
  token: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  loginPath: "/login";
  text: string;
}

export interface CockpitAccessListResult {
  plane: "cockpit";
  resource: "access";
  operation: "list";
  status: "ok";
  tokens: CockpitAccessTokenSummary[];
  text: string;
}

export interface CockpitAccessRevokeResult {
  plane: "cockpit";
  resource: "access";
  operation: "revoke";
  status: "revoked" | "not_found";
  tokenId: string;
  text: string;
}

export type CockpitAccessCliResult =
  | CockpitAccessCreateResult
  | CockpitAccessListResult
  | CockpitAccessRevokeResult;

export async function handleCockpitAccessCliCommand(
  command: CockpitAccessCliCommand,
): Promise<CockpitAccessCliResult> {
  const operation = command.operation as CockpitAccessOperation;
  if (operation !== "create" && operation !== "list" && operation !== "revoke") {
    throw new Error(
      `unknown spark cockpit access operation: ${command.operation}. Use create, list, or revoke.`,
    );
  }
  if (operation === "revoke" && !command.tokenId?.trim()) {
    throw new Error("spark cockpit access revoke requires --id <token-id>");
  }

  const databasePath = resolve(command.databasePath?.trim() || defaultDatabasePath());
  const db = openDatabase({ path: databasePath });
  try {
    migrate(db);
    switch (operation) {
      case "create":
        return createAccess(db, command.label);
      case "list":
        return listAccess(db);
      case "revoke":
        return revokeAccess(db, command.tokenId!.trim());
      default: {
        const _exhaustive: never = operation;
        void _exhaustive;
        throw new Error(`unhandled spark cockpit access operation: ${command.operation}`);
      }
    }
  } finally {
    db.close();
  }
}

function createAccess(db: DatabaseSync, label?: string): CockpitAccessCreateResult {
  const created = createCockpitAccessToken(db, {
    label: label?.trim() || "Cockpit browser access",
  });
  return {
    plane: "cockpit",
    resource: "access",
    operation: "create",
    status: "created",
    tokenId: created.id,
    token: created.token,
    label: label?.trim() || "Cockpit browser access",
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    loginPath: "/login",
    text:
      `Cockpit access key created (shown once)\n` +
      `  token     ${created.token}\n` +
      `  expires   ${created.expiresAt}\n` +
      `  login     /login\n` +
      `  id        ${created.id}\n`,
  };
}

function listAccess(db: DatabaseSync): CockpitAccessListResult {
  const tokens = listCockpitAccessTokens(db);
  const lines =
    tokens.length === 0
      ? "no Cockpit access tokens.\n"
      : tokens
          .map((token) => {
            const state = token.revokedAt ? "revoked" : token.usedAt ? "used" : "active";
            return `  ${token.id}  ${state}  expires ${token.expiresAt}${token.label ? `  ${token.label}` : ""}`;
          })
          .join("\n") + "\n";
  return {
    plane: "cockpit",
    resource: "access",
    operation: "list",
    status: "ok",
    tokens,
    text: lines,
  };
}

function revokeAccess(db: DatabaseSync, tokenId: string): CockpitAccessRevokeResult {
  const revoked = revokeCockpitAccessToken(db, { tokenId });
  return {
    plane: "cockpit",
    resource: "access",
    operation: "revoke",
    status: revoked ? "revoked" : "not_found",
    tokenId,
    text: revoked
      ? `revoked Cockpit access token ${tokenId}\n`
      : `Cockpit access token ${tokenId} was not active\n`,
  };
}
