/**
 * onCommandResult.ts — Firestore trigger: the device reported a command result.
 *
 * devices/{deviceId}/commandResults/{resultId}  onCreate
 *
 * Responsibilities:
 *   1. Marks the parent command EXECUTED/FAILED (single-use terminal state).
 *   2. REPLAY PROTECTION: a command already in a terminal state
 *      (EXECUTED | FAILED | EXPIRED) is NEVER updated again — duplicate
 *      result writes are logged as COMMAND_REPLAY_BLOCKED / DENIED.
 *   3. Session linkage: for SESSION command types the result carries
 *      { sessionId, consent: GRANTED|DENIED, permissionState, durationSeconds }
 *      and we drive the consent state machine in sessions/{sessionId}
 *      (see sessionLifecycle.applySessionCommandResult). Consent itself is
 *      ALWAYS decided on the device UI — this only records the outcome.
 *   4. Audits COMMAND_RESULT (device-local + platform mirror).
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { SESSION_COMMAND_TYPES, REGION } from "../lib/constants";
import { applySessionCommandResult } from "../sessions/sessionLifecycle";

interface CommandResultPayload {
  commandId?: unknown;
  status?: unknown;
  result?: Record<string, unknown> | null;
  sessionId?: unknown;
}

export const onCommandResult = onDocumentCreated(
  { region: REGION, document: "devices/{deviceId}/commandResults/{resultId}" },
  async (event) => {
    const params = event.params as { deviceId?: string; resultId?: string };
    const deviceId = params.deviceId;
    const resultId = params.resultId;
    const snap = event.data;
    if (!deviceId || !resultId || !snap) return;

    const data = (snap.data() ?? {}) as CommandResultPayload;
    const commandId =
      typeof data.commandId === "string" ? data.commandId : null;
    if (!commandId) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: "command_result_missing_commandId",
          deviceId,
          resultId,
        })
      );
      return;
    }

    const commandRef = db().doc(`devices/${deviceId}/commands/${commandId}`);
    const commandSnap = await commandRef.get();

    if (!commandSnap.exists) {
      await writeAudit({
        functionName: "onCommandResult",
        actorUid: `device:${deviceId}`,
        actorType: "DEVICE",
        deviceId,
        action: "COMMAND_RESULT_UNKNOWN",
        result: "ERROR",
        details: { commandId, resultId },
      });
      return;
    }

    const command = commandSnap.data()!;

    /* ---------------- single-use / replay protection ---------------- */
    const terminalStates = ["EXECUTED", "FAILED", "EXPIRED"];
    if (terminalStates.includes(command["status"] as string)) {
      await writeAudit({
        functionName: "onCommandResult",
        actorUid: `device:${deviceId}`,
        actorType: "DEVICE",
        deviceId,
        action: "COMMAND_REPLAY_BLOCKED",
        result: "DENIED",
        details: {
          commandId,
          type: command["type"] ?? null,
          previousStatus: command["status"],
          duplicateResultStatus: data.status ?? null,
        },
      });
      return;
    }

    const finalStatus = data.status === "FAILED" ? "FAILED" : "EXECUTED";
    await commandRef.update({
      status: finalStatus,
      result: data.result ?? null,
      completedAt: FieldValue.serverTimestamp(),
      resultId,
    });

    /* ---------------- session consent linkage ----------------------- */
    const commandType = command["type"] as string | undefined;
    const resultPayload = (data.result ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof resultPayload["sessionId"] === "string"
        ? (resultPayload["sessionId"] as string)
        : typeof data.sessionId === "string"
          ? (data.sessionId as string)
          : null;

    if (
      sessionId &&
      commandType &&
      (SESSION_COMMAND_TYPES as readonly string[]).includes(commandType)
    ) {
      await applySessionCommandResult(
        deviceId,
        sessionId,
        commandType,
        resultPayload
      );
    }

    await writeAudit({
      functionName: "onCommandResult",
      actorUid: `device:${deviceId}`,
      actorType: "DEVICE",
      deviceId,
      action: "COMMAND_RESULT",
      result: "ALLOWED",
      details: {
        commandId,
        type: commandType ?? null,
        finalStatus,
        sessionId,
      },
    });
  }
);
