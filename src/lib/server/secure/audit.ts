import "server-only";
/**
 * audit.ts — platform-wide, append-only audit trail (port of functions'
 * lib/audit.ts). Clients have ZERO access per firestore.rules.
 *
 * PRIVACY: details carry IDs, states and reasons — never message bodies,
 * file names, contact data or any other user content.
 */

import { FieldValue } from "firebase-admin/firestore";
import { db } from "./core";

export type AuditActorType = "PARENT" | "DEVICE" | "SYSTEM" | "ADMIN";

export interface AuditEntry {
  /** Which handler is writing (e.g. "confirmPairing"). */
  functionName: string;
  /** uid, `device:{deviceId}` or "system". */
  actorUid: string;
  actorType: AuditActorType;
  /** Present when the event is scoped to a device. */
  deviceId?: string;
  /** Machine-readable event name (e.g. "PAIR_DEVICE", "COMMAND_DISPATCH"). */
  action: string;
  /** ALLOWED | DENIED | ERROR | INFO. */
  result: "ALLOWED" | "DENIED" | "ERROR" | "INFO";
  /** Small structured context — IDs and reasons only. */
  details?: Record<string, unknown>;
}

/** Appends one entry to the platform audit log (auditLogs/{autoId}). */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db().collection("auditLogs").add({
      functionName: entry.functionName,
      actorUid: entry.actorUid,
      actorType: entry.actorType,
      deviceId: entry.deviceId ?? null,
      action: entry.action,
      result: entry.result,
      details: entry.details ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Auditing is critical but must not break the user-facing operation.
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "audit_write_failed",
        action: entry.action,
        functionName: entry.functionName,
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
