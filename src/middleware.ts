import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isPasswordLoginEnabled, verifyAuthToken } from "../lib/auth";

/**
 * Passwort-Login fuer das gesamte Frontend + die API.
 * Aktiv, sobald BOOKSCOUT_PASSWORD gesetzt ist. Wenn nicht, ist die Seite
 * wie bisher ungeschuetzt oeffentlich zugaenglich.
 *
 * ENV:
 *   BOOKSCOUT_PASSWORD  (zwingend fuer Auth-Aktivierung)
 */
export async function middleware(req: NextRequest) {
  if (!isPasswordLoginEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const session = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (await verifyAuthToken(session)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Nicht angemeldet." }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${req.nextUrl.pathname}${req.nextUrl.search}`);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Alles schuetzen ausser statische Next-Assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

function isPublicPath(pathname: string) {
  return pathname === "/login" || pathname.startsWith("/api/auth/");
}
