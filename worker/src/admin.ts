/**
 * admin.ts — firebase-admin on Workers (nodejs_compat) + caller identity.
 *
 * IMPORTANT: Firestore runs with preferRest:true — gRPC does not work inside
 * the Workers runtime; every Admin read/write goes over the HTTPS REST API
 * (still the Admin SDK: bypasses firestore.rules by design, server-authority).
 *
 * IDENTITY (same contract as the functions port):
 *   - Bearer Firebase ID token verified against Google's public certs
 *     (checkRevoked=true → banned users' revoked tokens die immediately).
 *   - Device identity = custom claims { deviceRole:"childDevice", deviceId }
 *     set ONLY by confirmPairing.
 *   - Parent callers get a lazily-provisioned users/{uid} profile and a
 *     ban gate on every request (replaces the onParentLogin blocking fn).
 *   - App Check token arrives in x-firebase-appcheck; SOFT by default.
 */

import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp } from "firebase-admin/firestore";
import { getAuth, Auth } from "firebase-admin/auth";
import { getMessaging, Messaging } from "firebase-admin/messaging";
import { getAppCheck, AppCheck } from "firebase-admin/app-check";
import process from "node:process";
import { ApiError } from "./http";
import type { Env } from "./env";

export interface Caller {
  uid: string;
  token: Record<string, unknown>;
  kind: "parent" | "device";
  deviceId?: string;
  appChecked: boolean;
}

let cachedApp: App | null = null;
let firestoreReady = false;

interface SaJson {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

function app(): App {
  if (cachedApp) return cachedApp;
  let sa: SaJson | null = null;
  try {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "") as SaJson;
  } catch {
    sa = null;
  }
  if (!sa?.project_id || !sa.client_email || !sa.private_key) {
    throw new ApiError(
      "unavailable",
      "Server is not configured (missing service account)."
    );
  }
  cachedApp =
    getApps().find((a) => a.name === "worker") ??
    initializeApp(
      {
        credential: cert({
          projectId: sa.project_id,
          clientEmail: sa.client_email,
          privateKey: sa.private_key.replace(/\\n/g, "\n"),
        }),
        projectId: sa.project_id,
      },
      "worker"
    );
  return cachedApp;
}

function fdb(): Firestore {
  const f = getFirestore(app());
  if (!firestoreReady) {
    // gRPC is unavailable on workerd — force the HTTPS REST transport.
    f.settings({ preferRest: true });
    firestoreReady = true;
  }
  return f;
}

export function db(): Firestore {
  return fdb();
}
export function auth(): Auth {
  return getAuth(app());
}
export function messaging(): Messaging {
  return getMessaging(app());
}
export function appCheck(): AppCheck {
  return getAppCheck(app());
}

/**
 * Public, non-secret facts about the configured service account.
 * A Firebase project_id / service-account email are embedded in every ID
 * token anyway (iss/aud) — exposing them on the health endpoint is safe and
 * makes misconfigured-deployments instantly diagnosable (audience mismatch
 * is the #1 "sign in expired" cause).
 */
export function saInfo(): { project: string | null; client: string | null } {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "") as SaJson;
    return {
      project: sa.project_id ?? null,
      client: sa.client_email ?? null,
    };
  } catch {
    return { project: null, client: null };
  }
}

/**
 * Maps a verifyIdToken failure to a short diagnostic reason (safe to expose —
 * no secrets, just the failure class). This is what turns "sign in expired"
 * into a fixable diagnosis on the client side.
 */
export function classifyVerifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/audience|aud\b|issuer|iss\b/i.test(msg)) return "project_mismatch";
  if (/expired/i.test(msg)) return "token_expired";
  if (/too early|not yet|iat/i.test(msg)) return "clock_skew";
  if (/signature|malformed|parse/i.test(msg)) return "invalid_token";
  if (/revoked|disabled|stale|validAfter/i.test(msg)) return "revoked_or_disabled";
  if (/permission|denied|403/i.test(msg)) return "service_account_permission";
  if (/fetch|network|timeout|unreachable/i.test(msg)) return "upstream_unreachable";
  if (/user|subject|sub\b/i.test(msg)) return "user_lookup_failed";
  return "unknown";
}

/**
 * Copies Worker bindings into process.env (nodejs_compat exposes secrets
 * there, but we bind explicitly so both fetch + cron paths are identical).
 */
export function bindEnv(env: Env): void {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON ??= env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.BACKUP_KEK ??= env.BACKUP_KEK ?? "";
  process.env.ENFORCE_APP_CHECK ??= env.ENFORCE_APP_CHECK ?? "0";
}

export { Timestamp };

/* ─────────────── App Check gate (soft by default) ─────────────────────── */

/**
 * App Check gate. SOFT by default: missing tokens are logged, not rejected.
 * Set ENFORCE_APP_CHECK="1" (wrangler var) after allowlisting Play Integrity.
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

/* ───────────────────────────── caller identity ──────────────────────────── */

async function verifyAppCheckHeader(value: string | null): Promise<boolean> {
  if (!value) return false;
  try {
    await appCheck().verifyToken(value);
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
    const reason = classifyVerifyError(err);
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "id_token_verify_failed",
        reason,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    // The `reason` suffix is a diagnostic class (never a secret) — it lets a
    // curl test pinpoint a misconfigured deployment instead of a generic 401.
    throw new ApiError(
      "unauthenticated",
      `Session expired or invalid. Please sign in again. (reason: ${reason})`
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

  // Parent path: lazy profile provisioning + ban gate (single read).
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
