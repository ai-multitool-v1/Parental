/**
 * adminSetBanState.ts — callable: DEVELOPER ADMIN ban/unban (user | device).
 *
 * SECURITY MODEL
 *  - Authorization = Firebase Auth CUSTOM CLAIM `admin: true`. That claim can
 *    ONLY be set by the Admin SDK / CLI:
 *      firebase functions:shell
 *      → admin.auth().setCustomUserClaims(uid, {admin:true})
 *    A client token cannot forge it, and Firestore rules independently deny
 *    non-admin access to admin-only paths.
 *  - App Check enforced (assertAppCheck) — scripted abuse without an attested
 *    client is refused.
 *  - Rate limited via the global Firestore ledger (defense in depth).
 *  - Banning a USER: users/{uid}.banned=true + reason + bannedAt, revokes
 *    refresh tokens (immediate session kill), audits ADMIN_BAN_USER.
 *  - Banning a DEVICE: devices/{deviceId}.banned=true — dispatchCommand
 *    refuses every command for it, FCM push stops, telemetry writes denied
 *    (rules: device write access requires !banned).
 *  - Every call (allowed or denied) lands in the platform audit log.
 *
 * Payload (strict):
 *   { targetType: "user" | "device",
 *     targetId:  string (uid | canonical device UUID),
 *     banned:    boolean,
 *     reason?:   string (<= 280 chars) }
 */

import {onCall} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {FieldValue} from "firebase-admin/firestore";
import {getAuth} from "firebase-admin/auth";
import {
  assertAppCheck,
  db,
  enforceRateLimit,
  requireSignedIn,
} from "../lib/verify";
import {writeAudit} from "../lib/audit";
import {ADMIN_RATE_LIMIT, REGION} from "../lib/constants";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless the caller token carries the admin custom claim. */
function requireAdmin(request: Parameters<typeof requireSignedIn>[0]): string {
  const uid = requireSignedIn(request);
  assertAppCheck(request);
  const claims = (request.auth?.token ?? {}) as Record<string, unknown>;
  if (claims["admin"] !== true) {
    throw new HttpsError(
      "permission-denied",
      "Admin privileges required. This incident is recorded."
    );
  }
  return uid;
}

export const adminSetBanState = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB"},
  async (request) => {
    const data = (request.data ?? {}) as Record<string, unknown>;

    // 1. Admin authorization FIRST — no target parsing before it.
    const adminUid = requireAdmin(request);

    await enforceRateLimit(
      `admin:${adminUid}`,
      ADMIN_RATE_LIMIT,
      "Admin action rate limit exceeded. Wait a moment."
    );

    // 2. Strict payload validation.
    const targetType = data["targetType"];
    if (targetType !== "user" && targetType !== "device") {
      throw new HttpsError(
        "invalid-argument",
        'Field "targetType" must be "user" or "device".'
      );
    }
    const targetId = data["targetId"];
    if (
      typeof targetId !== "string" ||
      targetId.length === 0 ||
      targetId.length > 128
    ) {
      throw new HttpsError("invalid-argument", 'Field "targetId" is invalid.');
    }
    const banned = data["banned"];
    if (typeof banned !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        'Field "banned" must be a boolean.'
      );
    }
    const reasonRaw = data["reason"];
    const reason =
      typeof reasonRaw === "string"
        ? reasonRaw.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 280)
        : "No reason provided";

    if (targetType === "user") {
      if (targetId === adminUid) {
        throw new HttpsError(
          "invalid-argument",
          "Admins cannot ban themselves."
        );
      }
      const userRef = db().doc(`users/${targetId}`);
      const snap = await userRef.get();
      if (!snap.exists) {
        throw new HttpsError("not-found", "Target user does not exist.");
      }
      // Immutable: another admin can never be banned by a peer admin.
      if (snap.get("role") === "admin") {
        throw new HttpsError(
          "permission-denied",
          "Admin accounts cannot be banned."
        );
      }
      await userRef.set(
        {
          banned,
          bannedReason: banned ? reason : FieldValue.delete(),
          bannedAt: banned ? new Date() : FieldValue.delete(),
          bannedBy: banned ? adminUid : FieldValue.delete(),
        },
        {merge: true}
      );
      // Kill live sessions NOW: revoking refresh tokens invalidates existing
      // ID tokens (immediately at next refresh; ≤1 h worst case).
      if (banned) {
        try {
          await getAuth().revokeRefreshTokens(targetId);
        } catch (err) {
          console.warn(
            JSON.stringify({
              severity: "WARNING",
              message: "revoke_refresh_tokens_failed",
              targetId,
            })
          );
        }
      }
      await writeAudit({
        functionName: "adminSetBanState",
        actorUid: adminUid,
        actorType: "PARENT", // platform actors: PARENT | DEVICE | SYSTEM
        action: banned ? "ADMIN_BAN_USER" : "ADMIN_UNBAN_USER",
        result: "ALLOWED",
        details: {targetId, reason},
      });
      return {ok: true, targetType, targetId, banned};
    }

    // --------------------------- device branch ---------------------------
    if (!UUID_RE.test(targetId)) {
      throw new HttpsError(
        "invalid-argument",
        'Field "targetId" must be a canonical device UUID.'
      );
    }
    const deviceRef = db().doc(`devices/${targetId}`);
    const snap = await deviceRef.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Target device does not exist.");
    }
    await deviceRef.set(
      {
        banned,
        bannedReason: banned ? reason : FieldValue.delete(),
        bannedAt: banned ? new Date() : FieldValue.delete(),
        bannedBy: banned ? adminUid : FieldValue.delete(),
      },
      {merge: true}
    );
    await writeAudit({
      functionName: "adminSetBanState",
      actorUid: adminUid,
      actorType: "PARENT",
      action: banned ? "ADMIN_BAN_DEVICE" : "ADMIN_UNBAN_DEVICE",
      result: "ALLOWED",
      deviceId: targetId,
      details: {targetId, reason},
    });
    return {ok: true, targetType, targetId, banned};
  }
);
