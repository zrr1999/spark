import { redirect, type RequestHandler } from "@sveltejs/kit";
import { hashSecret, sessionCookieName } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";

export const POST: RequestHandler = ({ cookies }) => {
  const sessionToken = cookies.get(sessionCookieName);

  if (sessionToken) {
    getDatabase()
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), hashSecret(sessionToken));
  }

  cookies.delete(sessionCookieName, { path: "/" });
  redirect(303, "/");
};
