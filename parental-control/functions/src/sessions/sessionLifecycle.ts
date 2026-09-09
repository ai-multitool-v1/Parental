/**
 * sessionLifecycle.ts — session state machine guardians.
 *
 * Components:
 *   onSessionUpdate (Firestore trigger on devices/{deviceId}/sessions/{sid})
 *     → writes a SESSION_STATE_CHANGED audit entry for every state
 *       transition, including who consented and the permission state at the
 *       time. Sessions are written ONLY by the Admin SDK (rules: client
 *       write=false), so every transition here originates from our functions.
 *
 *   cleanupSessions (scheduled every 10 minutes)
 *     → sessions stuck in REQUESTED/ACTIVE past expiresAt:
 *         REQUESTED → EXPIRED   (consent never given in time)
 *         ACTIVE    → ENDED     (auto-expired; consent.revokedAt stamped)
 *
 *   applySessionCommandResult (called by commands/onCommandResult)
 *     → the ONLY path from a device decision into session state:
 *         REQUEST_*_SESSION + consent GRANTED → ACTIVE (starts clock)
 *         REQUEST_*_SESSION + consent DENIED  → DENIED  (terminal)
 *         STOP_*_SESSION                      → ENDED   (reason recorded)
 *
 * PRIVACY: session documents carry state and (optionally) WebRTC signaling
 * metadata. No media (video/audio/screen frames) EVER passes through
 * Firebase — media is direct peer-to-peer, DTLS-encrypted, consent-gated.
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { clampDurationMs } from "../lib/commands";
import { REGION } from "../lib/constants";

/* ------------------------------------------------------------------ */
/* Trigger: audit every state transition                               */
/* ------------------------------------------------------------------ */

export const onSessionUpdate = onDocumentWritten(
  { region: REGION, document: "devices/{deviceId}/sessions/{sessionId}" },
  async (event) => {
    const params = event.params as { deviceId?: string; sessionId?: string };
    if (!params.deviceId || !params.sessionId) return;

    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // deletion is handled by retention purge

    const from = before?.["state"] ?? null;
    const to = after["state"] ?? null;
    if (from === to) return; // non-state field update — nothing to audit

    await writeAudit({
      functionName: "onSessionUpdate",
      actorUid: after["requestedBy"] ?? "system",
      actorType: "SYSTEM",
      deviceId: params.deviceId,
      action: "SESSION_STATE_CHANGED",
      result: "INFO",
      details: {
        sessionId: params.sessionId,
        type: after["type"] ?? null,
        from,
        to,
        consent: after["consent"] ?? null,
        permissionState: after["permissionState"] ?? null,
      },
    });
  }
);

/* ------------------------------------------------------------------ */
/* Scheduled cleanup                                                   */
/* ------------------------------------------------------------------ */

const MAX_SESSIONS_PER_RUN = 500;

export const cleanupSessions = onSchedule(
  {
    schedule: "every 10 minutes",
    region: REGION,
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const now = Timestamp.now();

    // Needs composite index: sessions(state ASC, expiresAt ASC), COLLECTION_GROUP.
    // NOTE: SCREEN sessions are set to expiresAt=null once ACTIVE (no-timer
    // product rule) and therefore never match this range query — they can
    // only end via STOP_*_SESSION commands or the child's Stop action.
    const stale = await db()
      .collectionGroup("sessions")
      .where("state", "in", ["REQUESTED", "ACTIVE"])
      .where("expiresAt", "<", now)
      .limit(MAX_SESSIONS_PER_RUN)
      .get();

    if (stale.empty) return;

    let expired = 0;
    let autoEnded = 0;
    const writer = db().bulkWriter();
    stale.forEach((doc) => {
      const state = doc.get("state");
      if (state === "REQUESTED") {
        expired++;
        writer.update(doc.ref, {
          state: "EXPIRED",
          endedAt: now,
          endReason: "REQUEST_TIMEOUT",
        });
      } else {
        autoEnded++;
        writer.update(doc.ref, {
          state: "ENDED",
          endedAt: now,
          endReason: "AUTO_EXPIRED",
          "consent.revokedAt": now,
        });
      }
    });
    await writer.close();

    await writeAudit({
      functionName: "cleanupSessions",
      actorUid: "system",
      actorType: "SYSTEM",
      action: "SESSIONS_CLEANUP",
      result: "INFO",
      details: { expiredRequests: expired, autoEnded: autoEnded },
    });
  }
);

/* ------------------------------------------------------------------ */
/* Consent outcome application (called from onCommandResult)           */
/* ------------------------------------------------------------------ */

/**
 * Applies a device-reported consent outcome to a session document.
 * `result` is the commandResult.result payload; expected keys:
 *   consent         : "GRANTED" | "DENIED" | "UNANSWERED"
 *   durationSeconds?: number        (ACTIVE cap, clamped to ≤ 1 hour)
 *   permissionState?: object        (permission snapshot at consent time)
 *   stoppedBy      ?: "CHILD" | "PARENT"
 */
export async function applySessionCommandResult(
  deviceId: string,
  sessionId: string,
  commandType: string,
  result: Record<string, unknown>
): Promise<void> {
  const sessionRef = db().doc(`devices/${deviceId}/sessions/${sessionId}`);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "session_result_unknown_session",
        deviceId,
        sessionId,
        commandType,
      })
    );
    return;
  }

  const serverNow = FieldValue.serverTimestamp();

  if (commandType.startsWith("REQUEST_") && commandType.endsWith("_SESSION")) {
    const consent =
      result["consent"] === "GRANTED"
        ? "GRANTED"
        : result["consent"] === "DENIED"
          ? "DENIED"
          : "UNANSWERED";

    if (consent === "GRANTED") {
      // Consent given ON THE DEVICE UI → session becomes ACTIVE.
      // PRODUCT RULE: SCREEN sessions have NO duration cap — the child
      // approved with visible consent (+ the system cast indicator) and the
      // session runs until the parent or child stops it. CAMERA/AUDIO keep
      // the hard server-side cap as a privacy backstop.
      const sessionType = (sessionSnap.get("type") as string) ?? "CAMERA";
      if (sessionType === "SCREEN") {
        // expiresAt: null → cleanupSessions' `expiresAt < now` query can
        // never match, so the screen share is never auto-expired.
        await sessionRef.update({
          state: "ACTIVE",
          startedAt: serverNow,
          expiresAt: null,
          "consent.granted": true,
          "consent.grantedAt": serverNow,
          permissionState: result["permissionState"] ?? null,
        });
      } else {
        // CAMERA/AUDIO: ACTIVE cap, clamped server-side; overstay ends via
        // cleanupSessions.
        const durationMs = clampDurationMs(result["durationSeconds"]);
        await sessionRef.update({
          state: "ACTIVE",
          startedAt: serverNow,
          expiresAt: Timestamp.fromMillis(Date.now() + durationMs),
          "consent.granted": true,
          "consent.grantedAt": serverNow,
          permissionState: result["permissionState"] ?? null,
        });
      }
    } else if (consent === "DENIED") {
      // Consent refused ON THE DEVICE UI → terminal; parent sees DENIED.
      await sessionRef.update({
        state: "DENIED",
        endedAt: serverNow,
        endReason: "CHILD_DENIED",
        "consent.granted": false,
        "consent.deniedAt": serverNow,
      });
    } else {
      await sessionRef.update({
        "consent.granted": null,
        permissionState: result["permissionState"] ?? null,
      });
    }
    return;
  }

  if (commandType.startsWith("STOP_")) {
    await sessionRef.update({
      state: "ENDED",
      endedAt: serverNow,
      endReason:
        result["stoppedBy"] === "CHILD" ? "CHILD_STOPPED" : "PARENT_STOPPED",
      "consent.revokedAt": serverNow,
    });
  }
}
