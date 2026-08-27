import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  UPSTOX_API_KEY,
  UPSTOX_API_SECRET,
  UPSTOX_REDIRECT_URI,
} from "../config.js";

const TOKEN_FILE = path.join(DATA_DIR, "upstox-token.json");
const AUTHORIZE_URL = "https://api.upstox.com/v2/login/authorization/dialog";
const TOKEN_URL = "https://api.upstox.com/v2/login/authorization/token";

// Upstox access tokens are always valid until 3:30 AM the day after they
// were issued, regardless of issue time — there is no refresh token, so a
// fresh login is required once a day before market hours.
function nextExpiryFromNow() {
  const now = new Date();
  const expiry = new Date(now);
  expiry.setHours(3, 30, 0, 0);
  if (expiry <= now) expiry.setDate(expiry.getDate() + 1);
  return expiry.toISOString();
}

async function readTokenFile() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function writeTokenFile(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(data, null, 2));
}

export function isUpstoxConfigured() {
  return Boolean(UPSTOX_API_KEY && UPSTOX_API_SECRET);
}

export function buildAuthorizationUrl(state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: UPSTOX_API_KEY,
    redirect_uri: UPSTOX_REDIRECT_URI,
  });
  if (state) params.set("state", state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    code,
    client_id: UPSTOX_API_KEY,
    client_secret: UPSTOX_API_SECRET,
    redirect_uri: UPSTOX_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.message || "Upstox token exchange failed");
  }

  await writeTokenFile({
    accessToken: data.access_token,
    userName: data.user_name || null,
    obtainedAt: new Date().toISOString(),
    expiresAt: nextExpiryFromNow(),
  });

  return data;
}

/**
 * Returns { connected: boolean, expiresAt, userName } — never throws.
 * `connected` is false once past 3:30 AM even if a token file exists, since
 * Upstox invalidates it server-side at that point regardless.
 */
export async function getUpstoxStatus() {
  if (!isUpstoxConfigured()) {
    return { configured: false, connected: false, expiresAt: null, userName: null };
  }
  const token = await readTokenFile();
  if (!token) return { configured: true, connected: false, expiresAt: null, userName: null };

  const connected = new Date(token.expiresAt).getTime() > Date.now();
  return {
    configured: true,
    connected,
    expiresAt: token.expiresAt,
    userName: token.userName,
  };
}

export async function getAccessToken() {
  const token = await readTokenFile();
  if (!token) return null;
  if (new Date(token.expiresAt).getTime() <= Date.now()) return null;
  return token.accessToken;
}
