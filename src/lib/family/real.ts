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

/** Shared Firebase app — used by the WebRTC viewer's Firestore signaling. */
export function firebaseApp(): FirebaseApp {
  return app();
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
  /**
   * true → the response body was a genuine Worker verdict
   * ({error:{code,message}} shape) — retrying via the proxy cannot change
   * the answer. false → the failure came from something BETWEEN the browser
   * and the Worker (ISP transparent proxy / Cloudflare edge hiccup serving
   * plain-text or foreign-JSON errors like "404 Not Found" / "forbidden"
   * with an HTTP status) — the same-origin proxy fallback CAN still succeed.
   */
  constructor(
    public code: string,
    message: string,
    public fromWorker = false
  ) {
    super(message);
  }
}

/** Thrown when the TCP/TLS/DNS layer itself fails (fetch/abort). */
class NetworkUnreachable extends RealApiError {
  constructor() {
    super("network", NETWORK_MSG, false);
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
    // Genuine Worker verdict = {error:{code,message}} object. Anything else
    // (ISP/DPI JSON block pages like {"error":"forbidden"}, Cloudflare edge
    // JSON, empty bodies) is platform garbage — mark it NOT fromWorker so
    // callSecure's proxy fallback gets a chance to succeed.
    const genuine =
      !!err && typeof err === "object" && typeof err.code === "string";
    throw new RealApiError(
      genuine ? err!.code! : "internal",
      err?.message ?? `Request failed (HTTP ${res.status}).`,
      genuine
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

  // Transient = network-layer failure OR an HTTP-level response that is NOT
  // a genuine Worker verdict (ISP block pages / Cloudflare edge garbage now
  // also arrive with HTTP statuses, not just as fetch exceptions). Genuine
  // verdicts (401 unauthenticated, 403 permission-denied, 404 unknown
  // endpoint, 429 rate-limit…) are final — the proxy would answer the same.
  const transient = (e: unknown): boolean =>
    e instanceof NetworkUnreachable ||
    (e instanceof RealApiError && !e.fromWorker);

  try {
    return await postJson(direct, token, data, DIRECT_TIMEOUT_MS);
  } catch (e1) {
    if (!transient(e1)) throw e1;
    if (typeof console !== "undefined") console.warn(`[secure] direct call failed (${name}), retrying…`);
  }

  await sleep(600);
  try {
    return await postJson(direct, token, data, DIRECT_TIMEOUT_MS);
  } catch (e2) {
    if (!transient(e2)) throw e2;
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

/* ═══════════════════ realtime parent dashboard (listDevices etc.) ═══════ */

/** One device row from the Worker listDevices endpoint. */
export interface RealDeviceDoc {
  deviceId: string;
  deviceName: string;
  status: string;
  banned: boolean;
  locked: boolean;
  childUid: string | null;
  childName: string | null;
  pairedAtMs: number | null;
  lastSeenAtMs: number | null;
  batteryLevel: number | null;
  isCharging: boolean;
  networkType: string | null;
  appVersion: string | null;
  androidVersion: string | null;
  // v1.4.2 — structured device identity (child heartbeat).
  model: string | null;
  manufacturer: string | null;
  ramTotalMb: number | null;
  ramAvailableMb: number | null;
  storageTotalGb: number | null;
  storageAvailableGb: number | null;
  policyVersion: number | null;
  permissions: Record<string, unknown> | null;
  policy: Record<string, unknown> | null;
  backupPolicy: Record<string, unknown> | null;
}

export interface RealCommandDoc {
  commandId: string;
  deviceId: string;
  type: string;
  status: string;
  result: Record<string, unknown> | null;
  completedAtMs: number | null;
}

/** Live snapshot of every device linked to the signed-in parent. */
export async function realListDevices(
  pendingCommands: { deviceId: string; commandId: string }[] = []
): Promise<{ devices: RealDeviceDoc[]; commands: RealCommandDoc[] }> {
  const data = await callSecure("listDevices", { pendingCommands });
  return {
    devices: (data["devices"] ?? []) as unknown as RealDeviceDoc[],
    commands: (data["commands"] ?? []) as unknown as RealCommandDoc[],
  };
}

/**
 * REAL unpair — Worker-এ parent↔device লিঙ্ক (ownerParentUid + parents/{uid}
 * + children/{uid} linkage) মুছে দেয়। এটা না করলে ৫ সেকেন্ডের realtime poll
 * আবার ডিভাইসটাকে বেঁধে ফেলে (auto-rebind bug)।
 */
export async function realUnpairDevice(deviceId: string): Promise<void> {
  await callSecure("unpairDevice", { deviceId });
}

/** Dispatch a whitelisted command to a paired device. */
export async function realDispatchCommand(
  deviceId: string,
  type: string,
  payload: Record<string, unknown> = {}
): Promise<{ commandId: string; fcmSent: boolean; expiresAtMs: number }> {
  const data = await callSecure("dispatchCommand", { deviceId, type, payload });
  return {
    commandId: String(data["commandId"] ?? ""),
    fcmSent: data["fcmSent"] === true,
    expiresAtMs: Number(data["expiresAt"] ?? 0),
  };
}

/** Request a consent-gated live session (creates session doc + command). */
export async function realRequestSession(
  deviceId: string,
  type: "screen" | "camera" | "audio",
  note?: string
): Promise<{ sessionId: string; commandId: string; expiresAtMs: number }> {
  const data = await callSecure("requestSession", {
    deviceId,
    type,
    ...(note ? { note } : {}),
  });
  return {
    sessionId: String(data["sessionId"] ?? ""),
    commandId: String(data["commandId"] ?? ""),
    expiresAtMs: Number(data["expiresAt"] ?? 0),
  };
}

/** Write a policy patch (child-native shape) — child applies it in realtime. */
export async function realSetPolicy(
  deviceId: string,
  patch: Record<string, unknown>
): Promise<{ version: number }> {
  const data = await callSecure("setPolicy", { deviceId, patch });
  return { version: Number(data["version"] ?? 0) };
}

/** Toggle a cloud-backup category (premium-gated server-side). */
export async function realSetBackupPolicy(
  deviceId: string,
  categories: Record<string, boolean>
): Promise<{ version: number }> {
  const data = await callSecure("backupSetPolicy", { deviceId, categories });
  return { version: Number(data["version"] ?? 0) };
}

/* ═════════════ heavy device collections (deviceData endpoint) ═══════════ */

export interface RealInstalledApp {
  packageName: string;
  appName: string;
  versionName: string;
  isSystem: boolean;
  installedAtMs: number;
}

export interface RealUsageDay {
  date: string;
  totalScreenTimeMinutes: number;
  perApp: Record<string, { appName?: string; minutes?: number }>;
}

export interface RealLocationPoint {
  id: string;
  lat: number;
  lng: number;
  accuracy: number;
  timestampMs: number;
}

export interface RealEmergencyEvent {
  id: string;
  type: string;
  lat: number | null;
  lng: number | null;
  batteryLevel: number | null;
  networkType: string | null;
  acknowledged: boolean;
  createdAtMs: number;
}

export interface RealBackupItem {
  id: string;
  category: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  ivB64: string | null;
  uploadedAtMs: number;
}

export interface RealNotification {
  id: string;
  message: string;
  deliveredAtMs: number | null;
  createdAtMs: number;
}

export interface RealActiveSession {
  sessionId: string;
  type: string;
  state: string;
  startedAtMs: number | null;
  expiresAtMs: number | null;
}

export interface RealDeviceData {
  deviceId: string;
  apps?: RealInstalledApp[];
  usage?: RealUsageDay[];
  locations?: RealLocationPoint[];
  emergencyEvents?: RealEmergencyEvent[];
  backupStats?: Record<string, unknown> | null;
  backupItems?: RealBackupItem[];
  notifications?: RealNotification[];
  sessions?: RealActiveSession[];
}

/**
 * Fetches the heavy per-device collections (apps inventory, usage, location
 * history, SOS events, backup items, notifications, active sessions). The
 * dashboard calls this on view-open + every 60s — NOT in the 5s poll.
 */
export async function realDeviceData(
  deviceId: string,
  sections: string[]
): Promise<RealDeviceData> {
  const data = await callSecure("deviceData", { deviceId, sections });
  return data as unknown as RealDeviceData;
}

/* ═════════════════ real backup download (presigned URL + DEK) ═════════ */

/** Presigned GET URL + envelope metadata for one uploaded backup item. */
export async function realBackupGetDownloadUrl(
  deviceId: string,
  itemId: string
): Promise<{ url: string; ivB64: string | null; mimeType: string; fileName: string }> {
  const data = await callSecure("backupGetDownloadUrl", { deviceId, itemId });
  return {
    url: String(data["url"] ?? ""),
    ivB64: (data["ivB64"] as string | null) ?? null,
    mimeType: String(data["mimeType"] ?? "application/octet-stream"),
    fileName: String(data["fileName"] ?? itemId),
  };
}

/** The child's backup DEK (escrow-unwrapped server-side, premium-gated). */
export async function realBackupGetKey(
  childUid: string
): Promise<{ keyB64: string; keyVersion?: number }> {
  const data = await callSecure("backupGetKey", { childUid });
  return { keyB64: String(data["keyB64"] ?? ""), keyVersion: Number(data["keyVersion"] ?? 1) };
}
