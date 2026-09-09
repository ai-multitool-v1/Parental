/**
 * endSession.ts — callable: the CHILD DEVICE ends an active/requested session.
 *
 * WHY THIS EXISTS (security audit fix):
 *   firestore.rules allow NO client writes to session documents (the consent
 *   state machine is Admin-SDK-only — sessions cannot be forged). But the
 *   child can legitimately stop a session (Stop button / ICE connection
 *   died). Instead of loosening the rules, the device calls THIS callable:
 *
 *   1. requireDevice(request)   → caller must carry the device identity
 *                                  claims { deviceRole: "childDevice",
 *                                  deviceId } — set ONLY by confirmPairing.
 *   2. Session must belong to the caller's own deviceId.
 *   3. Only live states are endable: REQUESTED → EXPIRED (withdraw consent
 *      prompt), ACTIVE → ENDED (CHILD_STOPPED).
 *   4. consent.revokedAt stamped; audit CHILD_SESSION_ENDED (device-local +
 *      platform mirror).
 *
 * The PARENT side continues to end sessions via STOP_*_SESSION commands
 * (dispatchCommand), which flow through the command pipeline.
 */

import {onCall, HttpsError} from "firebase-functions/v2/https";
import {FieldValue} from "firebase-admin/firestore";
import {assertAppCheck, db, enforceRateLimit, requireSignedIn} from "../lib/verify";
import {writeAudit} from "../lib/audit";
import {REGION} from "../lib/constants";

export const endSession = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB"},
  async (request) => {
    const uid = requireSignedIn(request);
    assertAppCheck(request);

    // Device identity ONLY (same claims confirmPairing sets; parents are
    // explicitly rejected — ending is the device's own action).
    const token = request.auth!.token as Record<string, unknown>;
    if (
      token["deviceRole"] !== "childDevice" ||
      typeof token["deviceId"] !== "string"
    ) {
      throw new HttpsError(
        "permission-denied",
        "Only the paired child device may end a session directly. " +
          "Parents should dispatch a STOP_*_SESSION command instead."
      );
    }
    const deviceId = token["deviceId"] as string;

    await enforceRateLimit(
      `end-session:${uid}`,
      {max: 60, windowMs: 60 * 60 * 1000},
      "Too many session-end requests. Please wait."
    );

    const data = (request.data ?? {}) as Record<string, unknown>;
    const sessionId = typeof data["sessionId"] === "string" ? data["sessionId"] : "";
    if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) {
      throw new HttpsError(
        "invalid-argument",
        'Field "sessionId" has an invalid shape.'
      );
    }

    const sessionRef = db().doc(`devices/${deviceId}/sessions/${sessionId}`);
    const snap = await sessionRef.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Unknown session.");
    }

    const state = snap.get("state");
    const serverNow = FieldValue.serverTimestamp();
    if (state === "ACTIVE") {
      await sessionRef.update({
        state: "ENDED",
        endedAt: serverNow,
        endReason: "CHILD_STOPPED",
        "consent.revokedAt": serverNow,
      });
    } else if (state === "REQUESTED") {
      // Child closes the consent prompt without answering → EXPIRED-now.
      await sessionRef.update({
        state: "EXPIRED",
        endedAt: serverNow,
        endReason: "CHILD_DISMISSED",
      });
    } else {
      // Terminal already — idempotent success, nothing to change.
      return {sessionId, state, changed: false};
    }

    await writeAudit({
      functionName: "endSession",
      actorUid: `device:${deviceId}`,
      actorType: "DEVICE",
      deviceId,
      action: "CHILD_SESSION_ENDED",
      result: "INFO",
      details: {sessionId, previousState: state},
    });

    return {sessionId, state: "ENDED", changed: true};
  }
);
