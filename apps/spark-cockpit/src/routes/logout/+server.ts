import { redirect, type RequestHandler } from "@sveltejs/kit";
import {
  hashSecret,
  sessionCookieName,
  sessionRefreshCookieName,
  workspaceSessionCookieName,
  workspaceSessionRefreshCookieName,
} from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";

export const POST: RequestHandler = ({ cookies }) => {
  const sessionToken = cookies.get(sessionCookieName);
  const refreshToken = cookies.get(sessionRefreshCookieName);
  const workspaceSessionToken = cookies.get(workspaceSessionCookieName);
  const workspaceRefreshToken = cookies.get(workspaceSessionRefreshCookieName);
  const now = new Date().toISOString();

  const hashes = [sessionToken, refreshToken, workspaceSessionToken, workspaceRefreshToken]
    .filter((value): value is string => Boolean(value))
    .map((value) => hashSecret(value));

  if (hashes.length > 0) {
    const db = getDatabase();
    for (const hash of hashes) {
      db.prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE (token_hash = ? OR refresh_token_hash = ?) AND revoked_at IS NULL`,
      ).run(now, hash, hash);
    }
  }

  cookies.delete(sessionCookieName, { path: "/" });
  cookies.delete(sessionRefreshCookieName, { path: "/" });
  cookies.delete(workspaceSessionCookieName, { path: "/" });
  cookies.delete(workspaceSessionRefreshCookieName, { path: "/" });
  redirect(303, "/");
};
