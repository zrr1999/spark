import { redirect, type RequestHandler } from "@sveltejs/kit";
import { hashSecret, sessionCookieName, sessionRefreshCookieName } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";

export const POST: RequestHandler = ({ cookies }) => {
  const sessionToken = cookies.get(sessionCookieName);
  const refreshToken = cookies.get(sessionRefreshCookieName);

  if (sessionToken || refreshToken) {
    getDatabase()
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE (token_hash = ? OR refresh_token_hash = ?) AND revoked_at IS NULL`,
      )
      .run(
        new Date().toISOString(),
        sessionToken ? hashSecret(sessionToken) : "",
        refreshToken ? hashSecret(refreshToken) : "",
      );
  }

  cookies.delete(sessionCookieName, { path: "/" });
  cookies.delete(sessionRefreshCookieName, { path: "/" });
  redirect(303, "/");
};
