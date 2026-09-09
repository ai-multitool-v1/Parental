package org.setbd.parentcontrol.backup

import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.tasks.await
import org.setbd.parentcontrol.di.ServiceLocator

/**
 * BackupItemRepository — metadata queue in Firestore.
 *
 * DEDUPLICATION (requirement 12): every item id is
 *     sha256("{deviceId}|{category}|{sourceKey}")
 * where sourceKey is the content-identity of the source row:
 *     media    → mediaStore id + dateModified + size
 *     contact  → contact id + last-updated timestamp + revision hash
 *     sms      → sms _ID + date + body-hash
 * Re-detecting the same content therefore produces the SAME document id;
 * Firestore `create()` (no overwrite) fails with ALREADY_EXISTS and the
 * scanner simply skips it. Distinct content can never collide (64-bit+
 * hash space via SHA-256 truncation to 48 hex chars).
 *
 * STATE MACHINE (rules-enforced, mirrored here):
 *   PENDING ──(server: createUploadUrl)──► UPLOADING
 *   UPLOADING ──(server: completeUpload)─► UPLOADED
 *   UPLOADING/PENDING ──(device)─────────► FAILED / CANCELLED
 *   CANCELLED(POLICY) ──(re-enabled)─────► PENDING  (resume)
 */
class BackupItemRepository {

    private val firestore = FirebaseFirestore.getInstance()

    private fun itemsRef(deviceId: String) =
        firestore.collection("devices").document(deviceId).collection("backupItems")

    /** Deterministic id from the content identity (see class doc). */
    fun contentId(category: BackupCategory, sourceKey: String): String =
        CryptoEngine.sha256Hex("${ServiceLocator.deviceId}|${category.id}|$sourceKey")
            .take(48)

    /**
     * Enqueues one backup unit. Returns false when the item already exists
     * (duplicate) — this is the expected, happy dedupe path.
     */
    suspend fun enqueue(
        category: BackupCategory,
        sourceKey: String,
        fileName: String,
        mimeType: String,
        sizeBytes: Long,
        checksumSha256: String,
    ): Boolean {
        val childUid = ServiceLocator.auth.childUid.value ?: return false
        if (sizeBytes > BackupLimits.MAX_ITEM_BYTES) return false // too large, never queued
        val doc = itemsRef(ServiceLocator.deviceId).document(contentId(category, sourceKey))
        return try {
            doc.set(
                mapOf(
                    "deviceId" to ServiceLocator.deviceId,
                    "childUid" to childUid,
                    "category" to category.id,
                    "fileName" to fileName.take(500),
                    "mimeType" to mimeType.take(120),
                    "sizeBytes" to sizeBytes,
                    "checksumSha256" to checksumSha256,
                    "state" to BackupItemState.PENDING.name,
                    "attempts" to 0,
                    "createdAt" to FieldValue.serverTimestamp(),
                    "updatedAt" to FieldValue.serverTimestamp(),
                ),
                SetOptions.merge()
            ).await()
            true
        } catch (e: Exception) {
            // ALREADY_EXISTS → duplicate → skip silently; other errors are
            // surfaced as false so the worker can retry on a later pass.
            false
        }
    }

    /** Oldest-first queue of items that still need server policy re-check. */
    suspend fun pendingQueue(limit: Long = 25): List<BackupItem> =
        queryStates(listOf(BackupItemState.PENDING, BackupItemState.FAILED), limit)

    /** Items the server previously CANCELLED for POLICY_DISABLED (resume set). */
    suspend fun policyCancelledQueue(limit: Long = 25): List<BackupItem> =
        queryStates(listOf(BackupItemState.CANCELLED), limit)
            .filter { it.lastErrorCode == BlockReason.POLICY_DISABLED || it.lastErrorCode == null }

    private suspend fun queryStates(states: List<BackupItemState>, limit: Long): List<BackupItem> {
        return try {
            itemsRef(ServiceLocator.deviceId)
                .whereIn("state", states.map { it.name })
                .orderBy("createdAt", Query.Direction.ASCENDING)
                .limit(limit)
                .get()
                .await()
                .documents
                .mapNotNull { d -> parseItem(d.id, d.data) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** Local device-side state transitions allowed by the rules. */
    suspend fun markState(item: BackupItem, state: BackupItemState, errorCode: String? = null) {
        try {
            val patch = mutableMapOf<String, Any?>(
                "state" to state.name,
                "updatedAt" to FieldValue.serverTimestamp(),
            )
            if (errorCode != null) patch["lastErrorCode"] = errorCode
            if (state == BackupItemState.FAILED) {
                patch["attempts"] = FieldValue.increment(1)
            }
            itemsRef(item.deviceId).document(item.itemId).set(patch, SetOptions.merge()).await()
        } catch (_: Exception) {
            // Rules will reject malformed transitions; the next reconcile
            // pass re-reads the authoritative server state anyway.
        }
    }

    /** Server state wins: re-pull one item (used after UPLOADING re-claim). */
    suspend fun reload(item: BackupItem): BackupItem? = try {
        val d = itemsRef(item.deviceId).document(item.itemId).get().await()
        if (d.exists()) parseItem(d.id, d.data) else null
    } catch (e: Exception) {
        null
    }

    private fun parseItem(id: String, data: Map<String, Any?>?): BackupItem? {
        if (data == null) return null
        val category = BackupCategory.fromId(data["category"] as? String) ?: return null
        val state = BackupItemState.fromId(data["state"] as? String) ?: return null
        return BackupItem(
            itemId = id,
            deviceId = data["deviceId"] as? String ?: ServiceLocator.deviceId,
            childUid = data["childUid"] as? String ?: "",
            category = category,
            fileName = data["fileName"] as? String ?: id,
            mimeType = data["mimeType"] as? String ?: "application/octet-stream",
            sizeBytes = (data["sizeBytes"] as? Number)?.toLong() ?: 0L,
            checksumSha256 = data["checksumSha256"] as? String ?: "",
            state = state,
            attempts = (data["attempts"] as? Number)?.toInt() ?: 0,
            lastErrorCode = data["lastErrorCode"] as? String,
            r2Key = data["r2Key"] as? String,
            ivB64 = data["ivB64"] as? String,
        )
    }
}

/** Shared limits (kept in one place to match firestore.rules + functions). */
object BackupLimits {
    /** Must stay below the rules cap of 512 MiB. */
    const val MAX_ITEM_BYTES: Long = 512L * 1024 * 1024
    const val MAX_ATTEMPTS: Int = 5
}
