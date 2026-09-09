/**
 * sendParentNotification.ts — callable: parent sends a message/notification
 * to the paired child device.
 *
 *   requireParent → App Check → rate limit (60/hour) →
 *   create devices/{deviceId}/notifications/{id}
 *     { notificationId, type: PARENT_MESSAGE, category, title, body,
 *       sentBy, createdAt, read: false, deliveredAt: null }
 *   → FCM data push to the device token
 *   → audit NOTIFICATION_SENT
 *
 * Rules: notifications are READ-ONLY for clients (device + parent can read;
 * nobody writes them directly — only this Admin-SDK path). Read receipts are
 * reported by the device via commandResults if the product needs them.
 */

import { onCall } from "firebase-functions/v2/https";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import {
  assertAppCheck,
  db,
  enforceRateLimit,
  optionalString,
  requireDeviceId,
  requireParent,
  requireString,
} from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { NOTIFICATION_RATE_LIMIT, REGION } from "../lib/constants";

export const sendParentNotification = onCall(
  { region: REGION, timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const data = (request.data ?? {}) as Record<string, unknown>;

    const deviceId = requireDeviceId(data["deviceId"]);
    const { uid } = await requireParent(deviceId, request);
    assertAppCheck(request);

    await enforceRateLimit(
      `notify:${uid}`,
      NOTIFICATION_RATE_LIMIT,
      "Notification rate limit exceeded (60/hour)."
    );

    const title = requireString(data["title"], "title", 100);
    const body = requireString(data["body"], "body", 500);
    const category = optionalString(data["category"], "category", 40) ?? "PARENT_MESSAGE";

    const notificationId = randomUUID();
    await db().doc(`devices/${deviceId}/notifications/${notificationId}`).set({
      notificationId,
      deviceId,
      type: "PARENT_MESSAGE",
      category,
      title,
      body,
      sentBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      read: false,
      deliveredAt: null,
    });

    // FCM data push (device renders it with its own consent-aware UI).
    const deviceSnap = await db().doc(`devices/${deviceId}`).get();
    const token = deviceSnap.get("fcmToken");
    let fcmSent = false;
    if (typeof token === "string" && token.length > 0) {
      try {
        await getMessaging().send({
          token,
          data: {
            kind: "NOTIFICATION",
            notificationId,
            title,
            body,
            category,
          },
          android: { priority: "high", collapseKey: "PARENT_MESSAGE" },
        });
        fcmSent = true;
        await db()
          .doc(`devices/${deviceId}/notifications/${notificationId}`)
          .update({ deliveredAt: FieldValue.serverTimestamp() });
      } catch (err) {
        console.error(
          JSON.stringify({
            severity: "ERROR",
            message: "notification_fcm_failed",
            deviceId,
            notificationId,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    await writeAudit({
      functionName: "sendParentNotification",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "NOTIFICATION_SENT",
      result: "ALLOWED",
      details: { notificationId, category, fcmSent },
    });

    return { notificationId, fcmSent };
  }
);
