/**
 * retentionPurge.ts — scheduled daily at 03:15.
 *
 * Privacy by default: telemetry is minimized over time.
 *
 *   locations        older than 30 days  → deleted
 *   notifications    older than 90 days  → deleted
 *   sessions (ENDED/EXPIRED/DENIED) older than 30 days → deleted
 *   commands         older than 30 days (past expiresAt) → deleted
 *   auditLogs        older than 365 days → deleted
 *   devices tombstoned UNPAIRED with purgeScheduledAt → recursive delete
 *
 * Uses collection-group queries + BulkWriter, capped per run
 * (RETENTION_BATCH_LIMIT); the next run continues. Range filters only match
 * the filter's type in Firestore, so null fields (e.g. sessions.endedAt of a
 * live session) are never selected.
 *
 * Required single-field collection-group indexes are declared in
 * firebase/firestore.indexes.json (fieldOverrides).
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { REGION, RETENTION_BATCH_LIMIT, RETENTION_DAYS } from "../lib/constants";

const PAGE_SIZE = 300;

export const retentionPurge = onSchedule(
  {
    schedule: "every day 03:15",
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const summary: Record<string, number> = {};

    summary["locations"] = await purgeCollectionGroup(
      "locations",
      "timestamp",
      RETENTION_DAYS.locations
    );
    summary["notifications"] = await purgeCollectionGroup(
      "notifications",
      "createdAt",
      RETENTION_DAYS.notifications
    );
    summary["sessions"] = await purgeCollectionGroup(
      "sessions",
      "endedAt",
      RETENTION_DAYS.sessions
    );
    summary["commands"] = await purgeCollectionGroup(
      "commands",
      "expiresAt",
      RETENTION_DAYS.commands
    );
    summary["auditLogs"] = await purgeCollectionGroup(
      "auditLogs",
      "createdAt",
      RETENTION_DAYS.auditLogs
    );
    summary["orphanDevices"] = await purgeOrphanedDevices();

    console.log(
      JSON.stringify({ severity: "INFO", message: "retention_purge_summary", ...summary })
    );

    await writeAudit({
      functionName: "retentionPurge",
      actorUid: "system",
      actorType: "SYSTEM",
      action: "RETENTION_PURGE",
      result: "INFO",
      details: summary,
    });
  }
);

/** Deletes docs of a collection group older than `days` for `field`. */
async function purgeCollectionGroup(
  group: string,
  field: string,
  days: number
): Promise<number> {
  const cutoff = Timestamp.fromMillis(Date.now() - days * 86_400_000);
  let deleted = 0;

  for (;;) {
    const snap = await db()
      .collectionGroup(group)
      .where(field, "<", cutoff)
      .limit(PAGE_SIZE)
      .get();
    if (snap.empty) break;

    const writer = db().bulkWriter();
    snap.forEach((doc) => writer.delete(doc.ref));
    await writer.close();

    deleted += snap.size;
    if (snap.size < PAGE_SIZE || deleted >= RETENTION_BATCH_LIMIT) break;
  }
  return deleted;
}

/** Finishes recursive deletes tombstoned by onUserDeleted. */
async function purgeOrphanedDevices(): Promise<number> {
  const orphans = await db()
    .collection("devices")
    .where("status", "==", "UNPAIRED")
    .where("purgeScheduledAt", "<=", Timestamp.now())
    .limit(100)
    .get();

  let purged = 0;
  for (const doc of orphans.docs) {
    try {
      await db().recursiveDelete(doc.ref);
      purged++;
    } catch (err) {
      console.error(
        JSON.stringify({
          severity: "ERROR",
          message: "orphan_device_purge_failed",
          deviceId: doc.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
  return purged;
}
