"use client";
/**
 * real.ts — REAL-mode bridge: Firebase Auth + Cloudflare Worker secure API.
 *
 * ZERO-COST architecture (Spark plan — no Cloud Functions):
 *   - Identity: Firebase Auth (Email/Password, FREE) → ID token
 *   - Privileged ops: HTTPS POST {NEXT_PUBLIC_SECURE_API_BASE}/api/secure/<name>
 *     with Authorization: Bearer <ID token> — the Cloudflare Worker verifies
 *     the token with the Admin SDK and enforces pairing/ban/plan gates.
 *   - The Worker URL is PUBLIC config (no secret in the client, ever).
 *
 * Demo mode (NEXT_PUBLIC_FIREBASE_* / NEXT_PUBLIC_SECURE_API_BASE unset)
 * keeps using the local scrypt auth + simulated engine — both modes coexist.
 */

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  type Auth,
  type User,
} from "firebase/auth";

export const FIREBASE_CLIENT_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

/**
 * Build-time-inlined env reader.
 *
 * ⚠️ CRITICAL: Next.js/Turbopack inlines ONLY literal `process.env.NEXT_PUBLIC_X`
 * expressions into the client bundle — dynamic `process.env[key]` lookups are NOT
 * replaced, so they silently return undefined in the browser and the dashboard
 * would ALWAYS run in demo mode even with env vars set on Vercel. Hence this
 * explicit literal map (all NEXT_PUBLIC_* keys used by the client).
 */
function readEnv(key: string): string | undefined {
  const map: Record<string, string | undefined> = {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_SECURE_API_BASE: process.env.NEXT_PUBLIC_SECURE_API_BASE,
  };
  return map[key];
}

/** True when the real backend is configured for THIS deployment. */
export function isRealMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    FIREBASE_CLIENT_ENV_KEYS.every((k) => Boolean(readEnv(k))) &&
    Boolean(readEnv("NEXT_PUBLIC_SECURE_API_BASE"))
  );
}

function app(): FirebaseApp {
  return (
    getApps().find((a) => a.name === "family") ??
    initializeApp(
      {
        apiKey: readEnv("NEXT_PUBLIC_FIREBASE_API_KEY")!,
        authDomain: readEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
        projectId: readEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID")!,
        messagingSenderId: readEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
        appId: readEnv("NEXT_PUBLIC_FIREBASE_APP_ID")!,
      },
      "family"
    )
  );
}

function auth(): Auth {
  return getAuth(app());
}

/**
 * Firebase Auth session observer — browser-এ Firebase নিজেই সেশন পারসিস্ট করে
 * (default: browserLocalPersistence), কিন্তু UI state (zustand) রিফ্রেশে মুছে
 * যায়। এই observer দিয়ে রিফ্রেশের পর সেশন রিস্টোর করা হয়।
 * Returns unsubscribe function.
 */
export function observeAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth(), cb);
}

function apiBase(): string {
  return (readEnv("NEXT_PUBLIC_SECURE_API_BASE") ?? "").trim().replace(/\/$/, "");
}

/** Current user's fresh ID token (or null when signed out). */
export async function currentIdToken(): Promise<string | null> {
  const u = auth().currentUser;
  if (!u) return null;
  try {
    return await u.getIdToken(false);
  } catch {
    // Token refresh hits securetoken.googleapis.com — network failure there
    // must NOT leak as a raw FirebaseError (it would bypass error mapping).
    throw new RealApiError(
      "network",
      "Session token refresh failed — check your internet connection."
    );
  }
}

const NETWORK_MSG =
  "Server unreachable. Check your internet and try again.";

export class RealApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Thrown when the TCP/TLS/DNS layer itself fails (fetch/abort). */
class NetworkUnreachable extends RealApiError {
  constructor() {
    super("network", NETWORK_MSG);
  }
}

const DIRECT_TIMEOUT_MS = 15_000;
const PROXY_TIMEOUT_MS = 25_000;

/** One POST with timeout; network-layer failures become NetworkUnreachable. */
async function postJson(
  url: string,
  token: string,
  data: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // TypeError: Failed to fetch / abort — DNS, SNI-block, TLS, offline.
    throw new NetworkUnreachable();
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Reached the edge but body wasn't JSON (HTML error page etc.).
    throw new NetworkUnreachable();
  }
  if (!res.ok || body["ok"] !== true) {
    const err = body["error"] as { code?: string; message?: string } | undefined;
    throw new RealApiError(
      err?.code ?? "internal",
      err?.message ?? `Request failed (HTTP ${res.status}).`
    );
  }
  return (body["data"] ?? {}) as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the trusted Worker: POST /api/secure/<name>.
 * Throws RealApiError(code, message) on every failure path.
 *
 * Resilience chain (some ISPs — notably in Bangladesh — block/throttle
 * `*.workers.dev`, so a single direct attempt is NOT enough):
 *   1. direct Worker call
 *   2. +600ms direct retry (transient mobile-data blip)
 *   3. same-origin proxy /api/secure/<name> (Vercel function → Worker,
 *      server-to-server, unaffected by the user's ISP)
 */
export async function callSecure(
  name: string,
  data: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const token = await currentIdToken();
  if (!token) throw new RealApiError("unauthenticated", "Sign in first.");

  const direct = `${apiBase()}/api/secure/${name}`;
  const proxy = `/api/secure/${name}`;

  try {
    return await postJson(direct, token, data, DIRECT_TIMEOUT_MS);
  } catch (e1) {
    if (!(e1 instanceof NetworkUnreachable)) throw e1;
    if (typeof console !== "undefined") console.warn(`[secure] direct call failed (${name}), retrying…`);
  }

  await sleep(600);
  try {
    return await postJson(direct, token, data, DIRECT_TIMEOUT_MS);
  } catch (e2) {
    if (!(e2 instanceof NetworkUnreachable)) throw e2;
    if (typeof console !== "undefined") console.warn(`[secure] direct retry failed (${name}), trying same-origin proxy…`);
  }

  return postJson(proxy, token, data, PROXY_TIMEOUT_MS);
}

/* ───────────────────────────── auth mapping ─────────────────────────────── */

export interface RealProfile {
  uid: string;
  email: string;
  name: string;
  plan: "free" | "premium";
  banned: boolean;
  admin: boolean;
}

function mapAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/user-not-found":
      return "no_account";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "wrong_password";
    case "auth/too-many-requests":
      return "locked";
    case "auth/email-already-in-use":
      return "exists";
    case "auth/weak-password":
      return "weak_password";
    case "auth/invalid-email":
      return "invalid_email";
    default:
      return "network";
  }
}

/** Real signup: Firebase Auth + lazy profile provisioning on the Worker. */
export async function realSignup(
  name: string,
  email: string,
  password: string
): Promise<{ result: string; profile?: RealProfile }> {
  try {
    const cred = await createUserWithEmailAndPassword(auth(), email.trim(), password);
    const profile = await fetchProfile(cred.user, name.trim());
    return { result: "ok", profile };
  } catch (err) {
    return { result: mapAuthError(err) };
  }
}

/** Real login: Firebase Auth + profile/ban check on the Worker. */
export async function realLogin(
  email: string,
  password: string
): Promise<{ result: string; profile?: RealProfile }> {
  try {
    const cred = await signInWithEmailAndPassword(auth(), email.trim(), password);
    const profile = await fetchProfile(cred.user);
    if (profile.banned) return { result: "banned" };
    return { result: "ok", profile };
  } catch (err) {
    return { result: mapAuthError(err) };
  }
}

/** Real logout. */
export async function realLogout(): Promise<void> {
  try {
    await fbSignOut(auth());
  } catch {
    /* best-effort */
  }
}

export async function fetchProfile(user: User, fallbackName?: string): Promise<RealProfile> {
  // `profile` also lazily provisions users/{uid} on the server (role=parent).
  const data = await callSecure("profile");
  return {
    uid: (data["uid"] as string) ?? user.uid,
    email: user.email ?? "",
    name: fallbackName ?? user.displayName ?? (user.email ?? "").split("@")[0],
    plan: (data["plan"] as "free" | "premium") ?? "free",
    banned: data["banned"] === true,
    admin: data["admin"] === true,
  };
}

/** Real pairing code from the trusted backend (5-min TTL, single-use). */
export async function realGeneratePairingCode(): Promise<{
  code: string;
  expiresAt: number;
}> {
  const data = await callSecure("generatePairingCode");
  return {
    code: String(data["code"] ?? ""),
    expiresAt: Number(data["expiresAt"] ?? Date.now() + 5 * 60_000),
  };
}
