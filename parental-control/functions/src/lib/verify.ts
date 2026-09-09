/**
 * verify.ts — authentication / authorization / abuse-control primitives.
 *
 * Every callable composes these:
 *   requireSignedIn(request)  → uid or throw "unauthenticated"
 *   assertAppCheck(request)   → soft→hard App Check rollout (ENFORCE_APP_CHECK)
 *   requireParent(deviceId, request) → { uid } with pairing-link verification
 *   requireDeviceId / requireString / optionalString → strict payload shaping
 *   enforceRateLimit(key, opts, msg) → Firestore sliding-window ledger
 *   db()                      → lazy Admin Firestore handle
 *
 * SECURITY MODEL
 *  - Identity comes ONLY from the verified Firebase ID token (request.auth).
 *    Nothing here ever trusts client-supplied uids.
 *  - Parent authorization = devices/{deviceId}/parents/{uid} exists — the
 *    ONLY artifact confirmPairing writes for the link (v2 pairing contract).
 *  - App Check starts SOFT (log-only) so debug builds and first deploys work;
 *    set env ENFORCE_APP_CHECK=1 (functions config / .env) after allowlisting
 *    the debug token / Play Integrity to flip every callable to HARD fail.
 */

import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { PAIRING_CODE_ALPHABET } from "./constants";

/* ───────────────────────────── firestore ───────────────────────────────── */

let firestoreRef: Firestore | null = null;

/** Lazy Admin Firestore handle (index.ts initializes the app once). */
export function db(): Firestore {
  if (!firestoreRef) firestoreRef = getFirestore();
  return firestoreRef;
}

/* ───────────────────────────── identity ────────────────────────────────── */

/** Returns the caller's uid or throws unauthenticated. */
export function requireSignedIn(request: CallableRequest<unknown>): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError(
      "unauthenticated",
      "Sign in required. This request has no verified identity."
    );
  }
  return uid;
}

/**
 * App Check gate. SOFT by default: missing tokens are logged, not rejected,
 * so debug builds work before the debug token is allowlisted. Flip to hard
 * by setting ENFORCE_APP_CHECK=1 in the functions environment.
 */
export function assertAppCheck(request: CallableRequest<unknown>): void {
  if (request.app) return; // valid attested app instance
  if (process.env.ENFORCE_APP_CHECK === "1") {
    throw new HttpsError(
      "failed-precondition",
      "App Check verification failed. Update the app and try again."
    );
  }
  console.log(
    JSON.stringify({
      severity: "WARNING",
      message: "appcheck_token_missing_soft_mode",
      uid: request.auth?.uid ?? null,
    })
  );
}

/** Canonical device UUID (what the Android app stores — random UUID v4). */
const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates and returns a canonical deviceId. */
export function requireDeviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) {
    throw new HttpsError(
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
  request: CallableRequest<unknown>
): Promise<{ uid: string }> {
  const uid = requireSignedIn(request);
  assertAppCheck(request);

  // A device identity must never use parent-only callables.
  const token = (request.auth?.token ?? {}) as Record<string, unknown>;
  if (token["deviceRole"] === "childDevice") {
    throw new HttpsError(
      "permission-denied",
      "Device identities cannot call parent operations."
    );
  }

  const link = await db().doc(`devices/${deviceId}/parents/${uid}`).get();
  if (!link.exists) {
    throw new HttpsError(
      "permission-denied",
      "You are not a paired parent of this device."
    );
  }
  return { uid };
}

/* ───────────────────────── payload validation ──────────────────────────── */

/** Control chars are never allowed in client strings. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Required string, trimmed, non-empty, ≤ maxLen. */
export function requireString(value: unknown, name: string, maxLen: number): string {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `Field "${name}" is required.`);
  }
  const v = value.trim();
  if (v.length === 0 || v.length > maxLen || CONTROL_RE.test(v)) {
    throw new HttpsError(
      "invalid-argument",
      `Field "${name}" must be 1-${maxLen} printable characters.`
    );
  }
  return v;
}

/** Required pairing code: exact length, uppercase 32-symbol alphabet. */
export function requirePairingCode(value: unknown): string {
  const v = requireString(value, "code", 32);
  if (
    v.length !== 8 ||
    [...v].some((ch) => !PAIRING_CODE_ALPHABET.includes(ch))
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Field \"code\" must be the 8-character code shown on the parent dashboard."
    );
  }
  return v;
}

/** Optional string, trimmed; undefined when absent/blank. */
export function optionalString(
  value: unknown,
  name: string,
  maxLen: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `Field "${name}" must be a string.`);
  }
  const v = value.trim();
  if (v.length === 0) return undefined;
  if (v.length > maxLen || CONTROL_RE.test(v)) {
    throw new HttpsError(
      "invalid-argument",
      `Field "${name}" must be at most ${maxLen} printable characters.`
    );
  }
  return v;
}

/* ───────────────────────── rate limiting ───────────────────────────────── */

interface RateLimitOpts {
  max: number;
  windowMs: number;
}

/**
 * Firestore sliding-window rate limiter (defense in depth — pairs with the
 * per-callable limits). One doc per key: rateLimits/{sha256(key)} holds the
 * timestamps of hits inside the current window. Race conditions can let a
 * few extra hits through under heavy concurrency, which is acceptable for
 * abuse control (never a security boundary on its own).
 */
export async function enforceRateLimit(
  key: string,
  opts: RateLimitOpts,
  userMessage: string
): Promise<void> {
  const { createHash } = await import("node:crypto");
  const docId = createHash("sha256").update(key).digest("hex").slice(0, 48);
  const ref = db().doc(`rateLimits/${docId}`);
  const now = Date.now();
  const windowStart = Timestamp.fromMillis(now - opts.windowMs);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() ?? {};
    const hits = Array.isArray(data["hits"])
      ? (data["hits"] as Timestamp[]).filter(
          (t) => t && typeof t.toMillis === "function" && t.toMillis() > windowStart.toMillis()
        )
      : [];

    if (hits.length >= opts.max) {
      throw new HttpsError("resource-exhausted", userMessage);
    }

    hits.push(Timestamp.fromMillis(now));
    tx.set(
      ref,
      {
        keyPrefix: key.slice(0, 64), // debuggability, never the raw key
        hits,
        updatedAt: Timestamp.fromMillis(now),
      },
      { merge: true }
    );
  });
}
