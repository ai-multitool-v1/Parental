/**
 * dispatchCommand.ts — callable: parent dispatches a WHITELISTED command.
 *
 * Pipeline (all server-side):
 *   requireParent(deviceId)      → devices/{deviceId}/parents/{uid} must exist
 *   App Check                    → attested client required (soft→hard rollout)
 *   v1.2.0 device-ban check      → devices/{deviceId}.banned must NOT be true
 *                                  (Developer Admin device-ban system)
 *   parent-ban check             → users/{uid}.banned must NOT be true
 *   v1.4.0 plan check            → premium-only commands require users/{uid}.plan == premium
 *   rate limit                   → 30 commands / hour / parent
 *   whitelist                    → type must be in COMMAND_WHITELIST
 *   payload validation           → per-type allowed keys, sizes, types
 *   create command doc           → status=PENDING, expiresAt=+5 min (single-use)
 *   FCM data push                → high priority, TTL-bound
 *   audit COMMAND_DISPATCH
 *
 * Clients CANNOT create commands directly (firestore.rules: create=false for
 * everyone). SESSION REQUESTS (REQUEST_*_SESSION) are refused here — they
 * must go through the requestSession callable so consent state is tracked.
 */

import { onCall } from "firebase-functions/v2/https";
import { HttpsError } from "firebase-functions/v2/https";
import { enforceRateLimit, requireDeviceId, requireParent, db } from "../lib/verify";
// NOTE: requireParent() already enforces App Check internally (see lib/verify.ts).
import { writeAudit } from "../lib/audit";
import {
  createAndDispatchCommand,
  validateCommandPayload,
  validateCommandType,
} from "../lib/commands";
import { COMMAND_RATE_LIMIT, PREMIUM_COMMAND_TYPES, REGION } from "../lib/constants";

export const dispatchCommand = onCall(
  { region: REGION, timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const data = (request.data ?? {}) as Record<string, unknown>;

    const deviceId = requireDeviceId(data["deviceId"]);
    const { uid } = await requireParent(deviceId, request);

    // ---- v1.2.0 Developer-Admin ban enforcement (defense in depth) ----
    // requireParent already validated the pairing link; a banned device or
    // banned parent account must not be able to dispatch anything.
    const [deviceSnap, parentSnap] = await Promise.all([
      db().doc(`devices/${deviceId}`).get(),
      db().doc(`users/${uid}`).get(),
    ]);
    if (deviceSnap.get("banned") === true) {
      await writeAudit({
        functionName: "dispatchCommand",
        actorUid: uid,
        actorType: "PARENT",
        deviceId,
        action: "COMMAND_BLOCKED_DEVICE_BANNED",
        result: "DENIED",
        details: { reason: "device_banned_by_admin" },
      });
      throw new HttpsError(
        "permission-denied",
        "This device is suspended by the platform administrator."
      );
    }
    if (parentSnap.get("banned") === true) {
      await writeAudit({
        functionName: "dispatchCommand",
        actorUid: uid,
        actorType: "PARENT",
        deviceId,
        action: "COMMAND_BLOCKED_PARENT_BANNED",
        result: "DENIED",
        details: { reason: "parent_banned_by_admin" },
      });
      throw new HttpsError(
        "permission-denied",
        "This account is suspended. Contact support to appeal."
      );
    }

    await enforceRateLimit(
      `commands:${uid}`,
      COMMAND_RATE_LIMIT,
      "Command rate limit exceeded (30/hour). Slow down."
    );

    const type = validateCommandType(data["type"]);

    // ---- v1.4.0 Free/Premium plan gate (defense in depth; UI also gates) ----
    // Device control (lock), screen sharing and camera/audio/video sessions
    // are premium-only. Free parents get the basic features (location, apps,
    // screen time, restrictions, bedtime, notifications, SOS).
    if (PREMIUM_COMMAND_TYPES.includes(type) && parentSnap.get("plan") !== "premium") {
      await writeAudit({
        functionName: "dispatchCommand",
        actorUid: uid,
        actorType: "PARENT",
        deviceId,
        action: "COMMAND_BLOCKED_PLAN",
        result: "DENIED",
        details: {reason: "premium_required", commandType: type},
      });
      throw new HttpsError(
        "permission-denied",
        "This control requires a premium plan."
      );
    }

    const payload = validateCommandPayload(type, data["payload"]);

    const { commandId, expiresAt, fcmSent } = await createAndDispatchCommand({
      deviceId,
      createdBy: uid,
      type,
      payload,
    });

    await writeAudit({
      functionName: "dispatchCommand",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "COMMAND_DISPATCH",
      result: "ALLOWED",
      details: { commandId, type, fcmSent, expiresAt: expiresAt.toMillis() },
    });

    return { commandId, status: "PENDING", expiresAt: expiresAt.toMillis(), fcmSent };
  }
);
