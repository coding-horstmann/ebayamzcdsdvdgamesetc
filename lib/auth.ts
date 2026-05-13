export const AUTH_COOKIE_NAME = "mediascout_session";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const TOKEN_PAYLOAD = "mediascout-auth-session-v1";

export function getAuthPassword() {
  const password = process.env.MEDIASCOUT_PASSWORD ?? process.env.BOOKSCOUT_PASSWORD;
  return password && password.length > 0 ? password : null;
}

export function isPasswordLoginEnabled() {
  return getAuthPassword() !== null;
}

export function verifySubmittedPassword(submitted: unknown) {
  const password = getAuthPassword();
  return typeof submitted === "string" && password !== null && timingSafeEqual(submitted, password);
}

export async function createAuthToken() {
  const password = getAuthPassword();
  if (!password) return null;

  const signature = await signPayload(TOKEN_PAYLOAD, password);
  return `v1.${signature}`;
}

export async function verifyAuthToken(token: string | null | undefined) {
  const expected = await createAuthToken();
  return typeof token === "string" && expected !== null && timingSafeEqual(token, expected);
}

async function signPayload(payload: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return toHex(signature);
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  let diff = a.length === b.length ? 0 : 1;
  const maxLength = Math.max(a.length, b.length);

  for (let i = 0; i < maxLength; i += 1) {
    const aCode = i < a.length ? a.charCodeAt(i) : 0;
    const bCode = i < b.length ? b.charCodeAt(i) : 0;
    diff |= aCode ^ bCode;
  }

  return diff === 0;
}
