/**
 * cleanupExpired.ts — scheduled every 5 minutes.
 *
 * 1. Marks PENDING commands past expiresAt as EXPIRED (collection group
 *    across ALL devices). Expiry + single-use in onCommandResult together
 *    make command replay worthless: an expired command can never transition
 *    to EXECUTED, and an executed one can never be re-executed.
 * 2. Deletes pairing codes that expired more than PAIRING_CODE_GRACE_MS ago.
 *
 * Uses a BulkWriter and caps work per run to stay inside the timeout; the
 * next run picks up the remainder. Composite index needed:
 *   commands(status ASC, expiresAt ASC) with COLLECTION_GROUP scope
 *   → see firebase/firestore.indexes.json.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { PAIRING_CODE_GRACE_MS, REGION } from "../lib/constants";

const MAX_COMMANDS_PER_RUN = 500;
const MAX_CODES_PER_RUN = 500;

export const cleanupExpired = onSchedule(
  {
    schedule: "every 5 minutes",
    region: REGION,
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const now = Timestamp.now();
    let expiredCommands = 0;
    let deletedCodes = 0;

    /* ---------- 1. expire stale PENDING commands --------------------- */
    const staleCommands = await db()
      .collectionGroup("commands")
      .where("status", "==", "PENDING")
      .where("expiresAt", "<", now)
      .limit(MAX_COMMANDS_PER_RUN)
      .get();

    if (!staleCommands.empty) {
      const writer = db().bulkWriter();
      staleCommands.forEach((doc) => {
        expiredCommands++;
        writer.update(doc.ref, {
          status: "EXPIRED",
          completedAt: now,
          expiredBy: "cleanupExpired",
        });
      });
      await writer.close();
    }

    /* ---------- 2. delete long-expired pairing codes ----------------- */
    const codeCutoff = Timestamp.fromMillis(Date.now() - PAIRING_CODE_GRACE_MS);
    const staleCodes = await db()
      .collection("pairingCodes")
      .where("expiresAt", "<", codeCutoff)
      .limit(MAX_CODES_PER_RUN)
      .get();

    if (!staleCodes.empty) {
      const writer = db().bulkWriter();
      staleCodes.forEach((doc) => {
        deletedCodes++;
        writer.delete(doc.ref);
      });
      await writer.close();
    }

    if (expiredCommands > 0 || deletedCodes > 0) {
      console.log(
        JSON.stringify({
          severity: "INFO",
          message: "cleanup_expired_summary",
          expiredCommands,
          deletedCodes,
        })
      );
      await writeAudit({
        functionName: "cleanupExpired",
        actorUid: "system",
        actorType: "SYSTEM",
        action: "CLEANUP_EXPIRED",
        result: "INFO",
        details: { expiredCommands, deletedCodes },
      });
    }
  }
);
