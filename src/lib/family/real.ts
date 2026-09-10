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

function readEnv(key: string): string | undefined {
  try {
    return (process.env as unknown as Record<string, string | undefined>)[key];
  } catch {
    return undefined;
  }
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

function apiBase(): string {
  return (readEnv("NEXT_PUBLIC_SECURE_API_BASE") ?? "").trim().replace(/\/$/, "");
}

/** Current user's fresh ID token (or null when signed out). */
export async function currentIdToken(): Promise<string | null> {
  const u = auth().currentUser;
  if (!u) return null;
  return u.getIdToken(false);
}

/**
 * Calls the trusted Worker: POST /api/secure/<name>.
 * Throws RealApiError(code, message) on server-defined errors.
 */
export async function callSecure(
  name: string,
  data: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const token = await currentIdToken();
  if (!token) throw new RealApiError("unauthenticated", "Sign in first.");
  const res = await fetch(`${apiBase()}/api/secure/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new RealApiError("network", "Server unreachable. Try again.");
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

export class RealApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
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

async function fetchProfile(user: User, fallbackName?: string): Promise<RealProfile> {
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
