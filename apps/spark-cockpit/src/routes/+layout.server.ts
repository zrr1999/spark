import { getDictionary, localeCookieName, resolveRequestLocale } from "$lib/i18n";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ cookies, request, url }) => {
  const requestedLocale = url.searchParams.get("lang");
  const locale = resolveRequestLocale({
    requestedLocale,
    cookieLocale: cookies.get(localeCookieName),
    acceptLanguage: request.headers.get("accept-language"),
  });

  // Only persist an explicit language choice. Do not seed the cookie from
  // Accept-Language — otherwise a one-off English probe pins the UI forever.
  if (requestedLocale) {
    cookies.set(localeCookieName, locale, {
      path: "/",
      sameSite: "lax",
      secure: false,
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return {
    locale,
    messages: getDictionary(locale),
  };
};
