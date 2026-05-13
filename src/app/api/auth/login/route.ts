import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  createAuthToken,
  isPasswordLoginEnabled,
  verifySubmittedPassword,
} from "../../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginBody = {
  password?: unknown;
};

export async function POST(req: NextRequest) {
  if (!isPasswordLoginEnabled()) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Bitte Passwort eingeben." }, { status: 400 });
  }

  if (!verifySubmittedPassword(body.password)) {
    return NextResponse.json({ ok: false, error: "Passwort stimmt nicht." }, { status: 401 });
  }

  const token = await createAuthToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Login ist nicht konfiguriert." }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(req),
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });

  return res;
}

function isHttpsRequest(req: NextRequest) {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return req.nextUrl.protocol === "https:" || forwardedProto === "https";
}
