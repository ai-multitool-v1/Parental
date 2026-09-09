/**
 * onSosCreated.ts — Firestore trigger on devices/{deviceId}/emergencyEvents.
 *
 * When the paired device creates an SOS / SAFETY_CHECK_FAIL event:
 *   1. Creates the denormalized top-level emergencyAlerts/{eventId} view:
 *        { eventId, deviceId, deviceName, type, message, location,
 *          parentUids, acknowledged: false, reminderCount: 0, ... }
 *   2. Sends a HIGH-priority FCM notification to EVERY paired parent's
 *      registered tokens (web dashboard instances).
 *   3. Audits EMERGENCY_SOS.
 *
 * escalationCheck (scheduled) then reminds unacknowledged alerts.
 *
 * ⚠ SAFETY STATEMENT (must remain in every artifact): the SOS feature is an
 * IN-FAMILY alert channel. It is NOT a replacement for emergency services.
 * The dashboard and notification copy must always show local emergency
 * numbers (911/112/999/…).
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { getFcmTokensForUser, pruneFcmTokensForUser } from "../lib/users";
import { REGION } from "../lib/constants";

export const onSosCreated = onDocumentCreated(
  { region: REGION, document: "devices/{deviceId}/emergencyEvents/{eventId}" },
  async (event) => {
    const params = event.params as { deviceId?: string; eventId?: string };
    const deviceId = params.deviceId;
    const eventId = params.eventId;
    const snap = event.data;
    if (!deviceId || !eventId || !snap) return;

    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const type = data["type"] === "SAFETY_CHECK_FAIL" ? "SAFETY_CHECK_FAIL" : "SOS";
    const message =
      typeof data["message"] === "string" ? data["message"].slice(0, 500) : "";

    const deviceSnap = await db().doc(`devices/${deviceId}`).get();
    const deviceName = (deviceSnap.get("deviceName") as string) ?? deviceId;

    const parentsSnap = await db()
      .collection(`devices/${deviceId}/parents`)
      .get();
    const parentUids = parentsSnap.docs.map((d) => d.id);

    /* ---------- 1. denormalized alert view for dashboards ---------- */
    await db().doc(`emergencyAlerts/${eventId}`).set({
      eventId,
      deviceId,
      deviceName,
      type,
      message,
      location: data["location"] ?? null, // as reported by the device
      parentUids,
      createdAt: FieldValue.serverTimestamp(),
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      reminderCount: 0,
      lastRemindedAt: null,
    });

    /* ---------- 2. high-priority push to all parents --------------- */
    for (const parentUid of parentUids) {
      const tokens = await getFcmTokensForUser(parentUid);
      const invalidTokens: string[] = [];
      for (const token of tokens) {
        try {
          await getMessaging().send({
            token,
            notification: {
              title: `SOS from ${deviceName}`,
              body:
                message ||
                "Your child triggered an SOS. Open the dashboard and acknowledge it. " +
                  "For real emergencies call your local emergency number.",
            },
            data: {
              kind: "SOS",
              eventId,
              deviceId,
              deviceName,
              type,
            },
            android: { priority: "high" },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("registration-token-not-registered")) {
            invalidTokens.push(token);
          } else {
            console.error(
              JSON.stringify({
                severity: "ERROR",
                message: "sos_fcm_failed",
                parentUid,
                eventId,
                error: msg,
              })
            );
          }
        }
      }
      await pruneFcmTokensForUser(parentUid, invalidTokens);
    }

    /* ---------- 3. audit ------------------------------------------- */
    await writeAudit({
      functionName: "onSosCreated",
      actorUid: `device:${deviceId}`,
      actorType: "DEVICE",
      deviceId,
      action: "EMERGENCY_SOS",
      result: "INFO",
      details: { eventId, type, parentsNotified: parentUids.length },
    });
  }
);
