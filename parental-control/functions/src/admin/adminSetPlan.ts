/**
 * adminSetPlan.ts — callable: DEVELOPER ADMIN sets a user's plan (v1.4.0).
 *
 * Free/Premium system:
 *   - free    → basic features (overview, devices, location, apps,
 *               screen time, restrictions, bedtime, notifications, SOS)
 *   - premium → ALL features (adds device control, screen sharing,
 *               camera/audio/video sessions, cloud backup)
 *
 * Authorization = `admin: true` custom claim (Admin SDK only) + App Check +
 * rate limit + strict payload. The plan is written to users/{uid}.plan where
 * dispatchCommand / requestSession / backup callables read it — a single
 * source of truth enforced server-side. Every call is audited.
 *
 * Payload (strict): { targetUid: string, plan: "free" | "premium" }
 */

import {onCall} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {FieldValue} from "firebase-admin/firestore";
import {
  assertAppCheck,
  db,
  enforceRateLimit,
  requireSignedIn,
} from "../lib/verify";
import {writeAudit} from "../lib/audit";
import {ADMIN_RATE_LIMIT, REGION} from "../lib/constants";

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

export const adminSetPlan = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB"},
  async (request) => {
    const data = (request.data ?? {}) as Record<string, unknown>;
    const adminUid = requireAdmin(request);

    await enforceRateLimit(
      `admin:${adminUid}`,
      ADMIN_RATE_LIMIT,
      "Admin action rate limit exceeded. Wait a moment."
    );

    const targetUid = data["targetUid"];
    if (typeof targetUid !== "string" || targetUid.length < 8 || targetUid.length > 128) {
      throw new HttpsError("invalid-argument", 'Field "targetUid" is malformed.');
    }
    const plan = data["plan"];
    if (plan !== "free" && plan !== "premium") {
      throw new HttpsError("invalid-argument", 'Field "plan" must be "free" or "premium".');
    }

    // Admin accounts never get demoted/self-targeted through this path.
    if (targetUid === adminUid) {
      await writeAudit({
        functionName: "adminSetPlan",
        actorUid: adminUid,
        actorType: "ADMIN",
        action: "ADMIN_SET_PLAN",
        result: "DENIED",
        details: {reason: "self_target"},
      });
      throw new HttpsError("permission-denied", "You cannot change your own plan.");
    }

    const ref = db().doc(`users/${targetUid}`);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Target user does not exist.");
    }
    if (snap.get("role") === "admin") {
      await writeAudit({
        functionName: "adminSetPlan",
        actorUid: adminUid,
        actorType: "ADMIN",
        action: "ADMIN_SET_PLAN",
        result: "DENIED",
        details: {reason: "admin_target", targetUid},
      });
      throw new HttpsError("permission-denied", "Admin accounts cannot be re-planned.");
    }

    await ref.set(
      {
        plan,
        planUpdatedAt: FieldValue.serverTimestamp(),
        planUpdatedBy: adminUid,
      },
      {merge: true}
    );

    await writeAudit({
      functionName: "adminSetPlan",
      actorUid: adminUid,
      actorType: "ADMIN",
      action: "ADMIN_SET_PLAN",
      result: "ALLOWED",
      details: {targetUid, plan},
    });

    return {ok: true, targetUid, plan};
  }
);
