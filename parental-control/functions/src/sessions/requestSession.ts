/**
 * requestSession.ts — callable: parent requests a SCREEN/CAMERA/AUDIO session.
 *
 * CONSENT MODEL (critical):
 *   The device UI is the consent authority. This function only:
 *     - creates devices/{deviceId}/sessions/{sessionId}
 *         { type, requestedBy, requestedAt, state: REQUESTED,
 *           expiresAt = +15 min, consent: { granted: null, ... } }
 *     - dispatches the matching REQUEST_*_SESSION command with the sessionId
 *       (FCM data push) so the device can show its consent overlay
 *     - audits SESSION_REQUESTED
 *   The device's consent decision flows back through commandResults →
 *   onCommandResult → sessionLifecycle.applySessionCommandResult, which moves
 *   the session to ACTIVE / DENIED. Nothing here can force a session ACTIVE.
 *
 * Sessions are signaling/state ONLY — no media ever passes through Firebase
 * (see docs/architecture.md "Media path vs signaling path").
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import {
  db,
  enforceRateLimit,
  optionalString,
  requireDeviceId,
  requireParent,
} from "../lib/verify";
import { writeAudit } from "../lib/audit";
import {
  createAndDispatchCommand,
  validateCommandType,
} from "../lib/commands";
import { buildIceServers } from "../lib/turn";
import {
  REGION,
  SESSION_RATE_LIMIT,
  SESSION_REQUEST_TTL_MS,
  SESSION_TYPES,
  SessionType,
} from "../lib/constants";

export const requestSession = onCall(
  { region: REGION, timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const data = (request.data ?? {}) as Record<string, unknown>;

    const deviceId = requireDeviceId(data["deviceId"]);
    const { uid } = await requireParent(deviceId, request);

    // ---- v1.4.0 Free/Premium plan gate — ALL live sessions are premium ----
    const profile = await db().doc(`users/${uid}`).get();
    if (profile.get("plan") !== "premium") {
      await writeAudit({
        functionName: "requestSession",
        actorUid: uid,
        actorType: "PARENT",
        deviceId,
        action: "SESSION_REQUEST_BLOCKED_PLAN",
        result: "DENIED",
        details: { reason: "premium_required" },
      });
      throw new HttpsError(
        "permission-denied",
        "Live sessions require a premium plan."
      );
    }

    await enforceRateLimit(
      `sessions:${uid}`,
      SESSION_RATE_LIMIT,
      "Session request rate limit exceeded (20/hour)."
    );

    const typeRaw = data["type"];
    if (
      typeof typeRaw !== "string" ||
      !(SESSION_TYPES as readonly string[]).includes(typeRaw)
    ) {
      throw new HttpsError(
        "invalid-argument",
        `Field "type" must be one of: ${SESSION_TYPES.join(", ")}.`
      );
    }
    const type = typeRaw as SessionType;
    const note = optionalString(data["note"], "note", 200);

    const sessionId = randomUUID();
    const now = Date.now();
    const requestedAt = Timestamp.fromMillis(now);
    const expiresAt = Timestamp.fromMillis(now + SESSION_REQUEST_TTL_MS);

    await db().doc(`devices/${deviceId}/sessions/${sessionId}`).set({
      sessionId,
      deviceId,
      type,
      requestedBy: uid,
      requestedAt,
      state: "REQUESTED",
      expiresAt,
      startedAt: null,
      endedAt: null,
      endReason: null,
      consent: { granted: null, grantedAt: null, deniedAt: null, revokedAt: null },
      permissionState: null, // filled by device result (granted permissions at that moment)
      // Ephemeral, session-scoped WebRTC ICE config (incl. time-limited TURN
      // credentials when configured) — credentials NEVER ship inside the app.
      iceServers: buildIceServers(sessionId),
      note: note ?? null,
    });

    // Linked consent request command — validated whitelist type is
    // REQUEST_<TYPE>_SESSION (REQUEST_SCREEN_SESSION / CAMERA / AUDIO).
    const commandType = validateCommandType(`REQUEST_${type}_SESSION`);
    const { commandId, fcmSent } = await createAndDispatchCommand({
      deviceId,
      createdBy: uid,
      type: commandType,
      payload: { sessionId },
    });

    await writeAudit({
      functionName: "requestSession",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "SESSION_REQUESTED",
      result: "ALLOWED",
      details: { sessionId, type, commandId, fcmSent },
    });

    return {
      sessionId,
      commandId,
      state: "REQUESTED",
      expiresAt: expiresAt.toMillis(),
      fcmSent,
    };
  }
);
