import "server-only";
/**
 * core.ts — ZERO-COST backend core (Spark-plan port of Cloud Functions v2).
 *
 * WHY THIS EXISTS
 *   Cloud Functions / Secret Manager / Cloud Scheduler require the Blaze
 *   plan. This module runs the SAME privileged logic inside Next.js API
 *   routes (deployable free on Vercel Hobby) with the SAME security model:
 *
 *     - Identity comes ONLY from a verified Firebase ID token
 *       (Authorization: Bearer). Clients can never self-assert uid/claims.
 *     - Device identity = custom claims { deviceRole:"childDevice",
 *       deviceId } — set ONLY by confirmPairing via the Admin SDK.
 *     - Parent authorization = devices/{deviceId}/parents/{uid} link doc,
 *       written ONLY by confirmPairing.
 *     - Credentials live in server env vars (Vercel encrypted env), never
 *       in client bundles (nothing here is NEXT_PUBLIC_*).
 *     - Firestore rules still gate ALL direct client access; this layer
 *       uses the Admin SDK which bypasses rules by design (server-authority).
 *
 * Trigger→endpoint mapping (functions → here):
 *   onCommandResult / onSessionUpdate  → commandResultHandler (explicit call
 *     from the device after writing the result doc — same state machine)
 *   cleanupExpired/cleanupSessions/retentionPurge/escalationCheck → sweep
 *     (Vercel Cron daily via CRON_SECRET + lazy call from dashboard).
 *   onParentLogin (blocking) → login route applies ban/lockout checks.
 */

import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore } from "firebase-admin/firestore";
import { getAuth, Auth } from "firebase-admin/auth";
import { getMessaging, Messaging } from "firebase-admin/messaging";
import { getAppCheck } from "firebase-admin/app-check";
import { createHash } from "node:crypto";
import { PAIRING_CODE_ALPHABET } from "./constants";

/* ───────────────────────────── admin app init ───────────────────────────── */

let cachedApp: App | null = null;

function serviceAccount():
  | { projectId: string; clientEmail: string; privateKey: string }
  | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    try {
      const j = JSON.parse(rawJson) as Record<string, string>;
      if (j.project_id && j.client_email && j.private_key) {
        return {
          projectId: j.project_id,
          clientEmail: j.client_email,
          privateKey: j.private_key.replace(/\\n/g, "\n"),
        };
      }
    } catch {
      /* fall through to individual vars */
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

/** True when the privileged API can run (service account configured). */
export function isSecureBackendConfigured(): boolean {
  return serviceAccount() !== null;
}

function app(): App {
  if (cachedApp) return cachedApp;
  const sa = serviceAccount();
  if (!sa) {
    throw new ApiError(
      "unavailable",
      "Secure backend is not configured on this deployment."
    );
  }
  cachedApp =
    getApps().find((a) => a.name === "secure-api") ??
    initializeApp(
      {
        credential: cert({
          projectId: sa.projectId,
          clientEmail: sa.clientEmail,
          privateKey: sa.privateKey,
        }),
      },
      "secure-api"
    );
  return cachedApp;
}

export function db(): Firestore {
  return getFirestore(app());
}
export function auth(): Auth {
  return getAuth(app());
}
export function messaging(): Messaging {
  return getMessaging(app());
}

/* ───────────────────────────── error contract ───────────────────────────── */

export type ApiErrorCode =
  | "unauthenticated"
  | "permission-denied"
  | "invalid-argument"
  | "not-found"
  | "failed-precondition"
  | "resource-exhausted"
  | "already-exists"
  | "unavailable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  "permission-denied": 403,
  "invalid-argument": 400,
  "not-found": 404,
  "failed-precondition": 400,
  "resource-exhausted": 429,
  "already-exists": 409,
  unavailable: 503,
  internal: 500,
};

/** Mirrors functions' HttpsError so handler code ports 1:1. */
export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message: string) {
    super(message);
  }
  status(): number {
    return STATUS[this.code];
  }
}

/* ───────────────────────────── caller identity ──────────────────────────── */

export interface Caller {
  uid: string;
  token: Record<string, unknown>;
  kind: "parent" | "device";
  deviceId?: string;
  appChecked: boolean;
}

async function verifyAppCheckHeader(value: string | null): Promise<boolean> {
  if (!value) return false;
  try {
    await getAppCheck(app()).verifyToken(value);
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "appcheck_verify_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return false;
  }
}

/**
 * Verifies the Bearer ID token and resolves the caller's role. Parent
 * callers get a lazily-provisioned users/{uid} profile (role=parent) —
 * replaces the onParentLogin blocking-function profile creation that Blaze
 * deployments use. Banned parents/devices are refused here (dispatcher gate).
 */
export async function verifyCaller(req: Request): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const tokenStr = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!tokenStr) {
    throw new ApiError(
      "unauthenticated",
      "Sign in required. This request has no verified identity."
    );
  }

  let decoded: Record<string, unknown>;
  try {
    const res = await auth().verifyIdToken(tokenStr, true);
    decoded = res as unknown as Record<string, unknown>;
  } catch (err) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "id_token_verify_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    throw new ApiError(
      "unauthenticated",
      "Session expired or invalid. Please sign in again."
    );
  }

  const uid = String(decoded["uid"] ?? decoded["user_id"] ?? "");
  if (!uid) throw new ApiError("unauthenticated", "Token has no subject.");

  const appChecked = await verifyAppCheckHeader(
    req.headers.get("x-firebase-appcheck")
  );

  const deviceRole = decoded["deviceRole"];
  const deviceIdClaim = decoded["deviceId"];

  if (deviceRole === "childDevice" && typeof deviceIdClaim === "string") {
    // Device identity: verify the device is not banned.
    const devSnap = await db().doc(`devices/${deviceIdClaim}`).get();
    if (devSnap.exists && devSnap.get("banned") === true) {
      throw new ApiError(
        "permission-denied",
        "This device is suspended by the platform administrator."
      );
    }
    return {
      uid,
      token: decoded,
      kind: "device",
      deviceId: deviceIdClaim,
      appChecked,
    };
  }

  // Parent path: profile lazy-provision + ban gate (single read).
  const ref = db().doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(
      {
        role: "parent",
        plan: "free",
        createdAt: Timestamp.now(),
        lastSeenAt: Timestamp.now(),
      },
      { merge: true }
    );
    return { uid, token: decoded, kind: "parent", appChecked };
  }
  if (snap.get("banned") === true) {
    throw new ApiError(
      "permission-denied",
      "This account is suspended. Contact support to appeal."
    );
  }
  return { uid, token: decoded, kind: "parent", appChecked };
}

/* ───────────────────── identity / authorization gates ───────────────────── */

export function requireSignedIn(caller: Caller): string {
  return caller.uid;
}

/**
 * App Check gate. SOFT by default: missing tokens are logged, not rejected.
 * Set ENFORCE_APP_CHECK=1 after allowlisting Play Integrity / debug tokens.
 */
export function assertAppCheck(caller: Caller): void {
  if (caller.appChecked) return;
  if (process.env.ENFORCE_APP_CHECK === "1") {
    throw new ApiError(
      "failed-precondition",
      "App Check verification failed. Update the app and try again."
    );
  }
  console.log(
    JSON.stringify({
      severity: "WARNING",
      message: "appcheck_token_missing_soft_mode",
      uid: caller.uid,
    })
  );
}

/** Canonical device UUID (what the Android app stores — random UUID v4). */
const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireDeviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) {
    throw new ApiError(
      "invalid-argument",
      'Field "deviceId" must be a canonical device UUID.'
    );
  }
  return value.toLowerCase();
}

/**
 * Parent-of-device gate: signed in + App Check + pairing link exists.
 * The link (devices/{deviceId}/parents/{uid}) is written ONLY by
 * confirmPairing via the Admin SDK — clients cannot forge it.
 */
export async function requireParent(
  deviceId: string,
  caller: Caller
): Promise<{ uid: string }> {
  const uid = requireSignedIn(caller);
  assertAppCheck(caller);

  if (caller.kind === "device") {
    throw new ApiError(
      "permission-denied",
      "Device identities cannot call parent operations."
    );
  }

  const link = await db().doc(`devices/${deviceId}/parents/${uid}`).get();
  if (!link.exists) {
    throw new ApiError(
      "permission-denied",
      "You are not a paired parent of this device."
    );
  }
  return { uid };
}

/** Device-of-record gate: caller claims must address exactly this device. */
export function requireDevice(
  caller: Caller
): { uid: string; deviceId: string } {
  if (caller.kind !== "device" || !caller.deviceId) {
    throw new ApiError(
      "permission-denied",
      "Only the paired child device may perform this operation."
    );
  }
  return { uid: caller.uid, deviceId: caller.deviceId };
}

/* ───────────────────────── payload validation ───────────────────────────── */

/** Control chars are never allowed in client strings. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function requireString(
  value: unknown,
  name: string,
  maxLen: number
): string {
  if (typeof value !== "string") {
    throw new ApiError("invalid-argument", `Field "${name}" is required.`);
  }
  const v = value.trim();
  if (v.length === 0 || v.length > maxLen || CONTROL_RE.test(v)) {
    throw new ApiError(
      "invalid-argument",
      `Field "${name}" must be 1-${maxLen} printable characters.`
    );
  }
  return v;
}

export function requirePairingCode(value: unknown): string {
  const v = requireString(value, "code", 32);
  if (v.length !== 8 || [...v].some((ch) => !PAIRING_CODE_ALPHABET.includes(ch))) {
    throw new ApiError(
      "invalid-argument",
      'Field "code" must be the 8-character code shown on the parent dashboard.'
    );
  }
  return v;
}

export function optionalString(
  value: unknown,
  name: string,
  maxLen: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError("invalid-argument", `Field "${name}" must be a string.`);
  }
  const v = value.trim();
  if (v.length === 0) return undefined;
  if (v.length > maxLen || CONTROL_RE.test(v)) {
    throw new ApiError(
      "invalid-argument",
      `Field "${name}" must be at most ${maxLen} printable characters.`
    );
  }
  return v;
}

/* ───────────────────────── rate limiting ────────────────────────────────── */

interface RateLimitOpts {
  max: number;
  windowMs: number;
}

/**
 * Firestore sliding-window rate limiter (defense in depth). One doc per key:
 * rateLimits/{sha256(key)} holds timestamps of hits inside the window.
 */
export async function enforceRateLimit(
  key: string,
  opts: RateLimitOpts,
  userMessage: string
): Promise<void> {
  const docId = createHash("sha256").update(key).digest("hex").slice(0, 48);
  const ref = db().doc(`rateLimits/${docId}`);
  const now = Date.now();
  const windowStart = Timestamp.fromMillis(now - opts.windowMs);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() ?? {};
    const hits = Array.isArray(data["hits"])
      ? (data["hits"] as Timestamp[]).filter(
          (t) =>
            t &&
            typeof t.toMillis === "function" &&
            t.toMillis() > windowStart.toMillis()
        )
      : [];

    if (hits.length >= opts.max) {
      throw new ApiError("resource-exhausted", userMessage);
    }

    hits.push(Timestamp.fromMillis(now));
    tx.set(
      ref,
      {
        keyPrefix: key.slice(0, 64),
        hits,
        updatedAt: Timestamp.fromMillis(now),
      },
      { merge: true }
    );
  });
}
