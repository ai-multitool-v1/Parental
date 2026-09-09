package org.setbd.parentcontrol.backup

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.firebase.functions.FirebaseFunctions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * BackupScanWorker — the reconcile pass (requirement 3/4/5/13).
 *
 * Runs when: policy flips ON, a ContentObserver fires (new media/contacts),
 * periodically (6 h), and after boot. For each enabled+consented+permitted
 * category it scans the delta cursor and enqueues PENDING items. Permission
 * loss / unsupported modules degrade gracefully (no rows, no crash, an
 * honest status surfaced to the dashboard via the permission reporter).
 */
class BackupScanWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val repo = ServiceLocator.backupItems
        val policy = ServiceLocator.backupPolicyRepository.policy.value

        // ---- gate 1: is backup enabled at all?
        if (!policy.anyEnabled) return@withContext Result.success()

        scanCategory(repo, BackupCategory.PHOTOS, MediaBackupSource(BackupCategory.PHOTOS))
        scanCategory(repo, BackupCategory.VIDEOS, MediaBackupSource(BackupCategory.VIDEOS))
        scanCategory(repo, BackupCategory.CONTACTS, ContactsBackupSource())
        scanCategory(repo, BackupCategory.SMS, SmsBackupSource())
        return@withContext Result.success()
    }

    private suspend fun scanCategory(
        repo: BackupItemRepository,
        category: BackupCategory,
        source: Any,
    ) {
        val context = applicationContext
        val policy = ServiceLocator.backupPolicyRepository.policy.value
        val cursor = ServiceLocator.secureStore.backupCursor(category.id)

        // Triple gate: parent policy + child consent + runtime permission.
        if (!policy.category(category).enabled) return
        val consent = ServiceLocator.backupPolicyRepository
        val consentOk = consent.refreshConsentCache()
            ?.optJSONObject("consent")?.optJSONObject(category.id)
            ?.optBoolean("granted", false) == true
        if (!consentOk) return

        val result = when (source) {
            is MediaBackupSource -> {
                if (!source.isSupported(context)) return
                source.scan(context, cursor)
            }
            is ContactsBackupSource -> {
                if (!source.isSupported(context)) return
                source.scan(context, cursor)
            }
            is SmsBackupSource -> {
                if (!source.isSupported(context)) return
                source.scan(context, cursor)
            }
            else -> return
        }

        // Permission revoked mid-flow → cursor untouched, nothing queued.
        if (result.rows.isEmpty()) return

        var queued = 0
        for (row in result.rows) {
            val ok = repo.enqueue(
                category = row.category,
                sourceKey = row.sourceKey,
                fileName = row.fileName,
                mimeType = row.mimeType,
                sizeBytes = row.sizeBytes,
                checksumSha256 = row.checksumSha256,
            )
            if (ok) queued++
        }
        // Advance the watermark even for duplicates (they ARE backed up or
        // already queued); a partial enqueue still moves the cursor so the
        // next pass continues where this one stopped (bounded memory/CPU).
        ServiceLocator.secureStore.setBackupCursor(category.id, result.watermark)
        if (queued > 0) {
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_BACKUP_SCAN,
                result = "queued=$queued category=${category.id}",
            )
        }
    }

    companion object {
        const val UNIQUE_PERIODIC = "backup-scan-periodic"
        const val UNIQUE_ONESHOT = "backup-scan-oneshot"
    }
}

/**
 * BackupUploadWorker — the reliable uploader (requirement 3/7/12/13/14).
 *
 * For each PENDING item (oldest first):
 *   1. SERVER policy pre-check — backupCreateUploadUrl re-validates policy +
 *      consent + ban on the server; a BLOCKED decision marks the item
 *      CANCELLED(POLICY) even if the device never saw the toggle.
 *   2. Payload resolution — media content is re-opened by URI; contacts/SMS
 *      JSON payloads were captured at scan time and are re-derivable.
 *   3. AES-256-GCM streaming encryption to a temp file (constant RAM).
 *   4. Streaming PUT to the presigned R2 URL (setFixedLengthStreamingMode).
 *   5. backupCompleteUpload — server HEAD-verifies the object, then the
 *      item becomes UPLOADED and stats update.
 * Failures mark FAILED + attempts++ and let WorkManager retry with backoff;
 * after MAX_ATTEMPTS the item stays FAILED (visible on the dashboard with
 * a retry affordance, never silently dropped).
 */
class BackupUploadWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    private val functions = FirebaseFunctions.getInstance()

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (!ServiceLocator.secureStore.isPaired()) return@withContext Result.success()

        val repo = ServiceLocator.backupItems
        var processed = 0

        val queue = repo.pendingQueue() + repo.policyCancelledQueue()
        for (item in queue.distinctBy { it.itemId }) {
            if (item.attempts >= BackupLimits.MAX_ATTEMPTS) continue
            val outcome = uploadOne(repo, item)
            processed++
            if (outcome.finalState == BackupItemState.FAILED &&
                outcome.errorCode in NET_ERRORS
            ) {
                // Network-shaped failure → non-fatal work result, retry later.
                return@withContext if (runAttemptCount < 5) Result.retry() else Result.success()
            }
        }
        return@withContext Result.success()
    }

    private suspend fun uploadOne(repo: BackupItemRepository, item: BackupItem): UploadOutcome {
        // ---------- 1. server-side eligibility (the authoritative gate) ----
        val decision = try {
            @Suppress("UNCHECKED_CAST")
            val res = functions.getHttpsCallable("backupCreateUploadUrl")
                .call(mapOf("deviceId" to item.deviceId, "itemId" to item.itemId))
                .await()
            res.data as? Map<String, Any?> ?: emptyMap()
        } catch (e: Exception) {
            repo.markState(item, BackupItemState.FAILED, BlockReason.NETWORK)
            return UploadOutcome(item, BackupItemState.FAILED, BlockReason.NETWORK)
        }

        if (decision["decision"] != "OK") {
            val reason = decision["reason"] as? String ?: "BLOCKED"
            val state = when (reason) {
                BlockReason.POLICY_DISABLED, BlockReason.DEVICE_BANNED ->
                    BackupItemState.CANCELLED
                else -> BackupItemState.FAILED
            }
            repo.markState(item, state, reason)
            return UploadOutcome(item, state, reason)
        }

        val uploadUrl = decision["uploadUrl"] as? String
        if (uploadUrl.isNullOrBlank()) {
            repo.markState(item, BackupItemState.FAILED, "BAD_SERVER_RESPONSE")
            return UploadOutcome(item, BackupItemState.FAILED, "BAD_SERVER_RESPONSE")
        }

        // ---------- 2. resolve payload bytes (re-resolve by sourceKey) -----
        val payload = resolvePayload(item)
        if (payload == null) {
            // Source vanished (photo deleted, contact removed) — this item
            // can never be fulfilled; mark CANCELLED so it stops retrying.
            repo.markState(item, BackupItemState.CANCELLED, "SOURCE_GONE")
            return UploadOutcome(item, BackupItemState.CANCELLED, "SOURCE_GONE")
        }

        // ---------- 3. encrypt (streaming, AES-256-GCM) --------------------
        val keyB64 = try {
            ServiceLocator.backupKeys.getKey(item.childUid)
        } catch (e: BackupUnavailableException) {
            repo.markState(item, BackupItemState.FAILED, e.code)
            return UploadOutcome(item, BackupItemState.FAILED, e.code)
        } catch (e: Exception) {
            repo.markState(item, BackupItemState.FAILED, BlockReason.NETWORK)
            return UploadOutcome(item, BackupItemState.FAILED, BlockReason.NETWORK)
        }

        val encrypted = try {
            val input = payload.open()
            input.use { CryptoEngine.encryptStream(it, payload.size, File(applicationContext.cacheDir, "backup"), keyB64) }
        } catch (e: Exception) {
            repo.markState(item, BackupItemState.FAILED, "ENCRYPT_FAILED")
            return UploadOutcome(item, BackupItemState.FAILED, "ENCRYPT_FAILED")
        }

        // ---------- 4. streaming PUT ---------------------------------------
        val httpOk = try {
            putToR2(uploadUrl, encrypted.file)
        } catch (e: Exception) {
            false
        } finally {
            encrypted.file.delete() // ciphertext temp never lingers
        }
        if (!httpOk) {
            repo.markState(item, BackupItemState.FAILED, BlockReason.NETWORK)
            return UploadOutcome(item, BackupItemState.FAILED, BlockReason.NETWORK)
        }

        // ---------- 5. server verifies + finalizes -------------------------
        val done = try {
            @Suppress("UNCHECKED_CAST")
            val res = functions.getHttpsCallable("backupCompleteUpload")
                .call(
                    mapOf(
                        "deviceId" to item.deviceId,
                        "itemId" to item.itemId,
                        "ivB64" to encrypted.ivB64,
                    )
                )
                .await()
            res.data as? Map<String, Any?> ?: emptyMap()
        } catch (e: Exception) {
            repo.markState(item, BackupItemState.FAILED, BlockReason.NETWORK)
            return UploadOutcome(item, BackupItemState.FAILED, BlockReason.NETWORK)
        }

        return if (done["verified"] == true) {
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_BACKUP_UPLOADED,
                result = "category=${item.category.id} size=${encrypted.cipherSizeBytes}",
            )
            UploadOutcome(item, BackupItemState.UPLOADED)
        } else {
            repo.markState(item, BackupItemState.FAILED, done["reason"] as? String ?: "VERIFY_FAILED")
            UploadOutcome(item, BackupItemState.FAILED, done["reason"] as? String ?: "VERIFY_FAILED")
        }
    }

    /**
     * Resolves the item back to its bytes at upload time. The scan encoded
     * every content id inside the fileName:
     *   media    → "media_{mediaStoreId}_{displayName}"
     *   contact  → "contact_{contactId}.json"
     *   sms      → "sms_{smsId}.json"
     * so no plaintext payload is ever cached locally between scan and upload.
     */
    private fun resolvePayload(item: BackupItem): PayloadSource? {
        return try {
            when (item.category) {
                BackupCategory.PHOTOS, BackupCategory.VIDEOS -> {
                    if (!item.fileName.startsWith("media_")) return null
                    val rest = item.fileName.removePrefix("media_")
                    val mediaId = rest.substringBefore('_')
                    if (mediaId.toLongOrNull() == null) return null
                    val uri = if (item.category == BackupCategory.PHOTOS) {
                        Uri.withAppendedPath(
                            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, mediaId)
                    } else {
                        Uri.withAppendedPath(
                            MediaStore.Video.Media.EXTERNAL_CONTENT_URI, mediaId)
                    }
                    PayloadSource.FilePayload(uri, item.sizeBytes)
                }
                BackupCategory.CONTACTS -> {
                    val id = item.fileName.removePrefix("contact_").removeSuffix(".json")
                        .toLongOrNull() ?: return null
                    val bytes = ContactsBackupSource().rebuildContactPayload(applicationContext, id)
                        ?: return null
                    PayloadSource.BytesPayload(bytes)
                }
                BackupCategory.SMS -> {
                    val id = item.fileName.removePrefix("sms_").removeSuffix(".json")
                        .toLongOrNull() ?: return null
                    val bytes = SmsBackupSource().rebuildSmsPayload(applicationContext, id)
                        ?: return null
                    PayloadSource.BytesPayload(bytes)
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    /** Streams [file] to [url] with PUT; true only on HTTP 2xx. */
    private fun putToR2(url: String, file: File): Boolean {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "PUT"
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            // RAM-safe streaming: body is piped straight from the file.
            conn.setFixedLengthStreamingMode(file.length())
            FileInputStream(file).use { input ->
                conn.outputStream.use { out ->
                    input.copyTo(out, 64 * 1024)
                }
            }
            return conn.responseCode in 200..299
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        const val UNIQUE_PERIODIC = "backup-upload-periodic"
        const val UNIQUE_ONESHOT = "backup-upload-oneshot"
        private val NET_ERRORS = setOf(BlockReason.NETWORK)
    }
}

/* ------------------------------------------------------- payload plumbing -- */

/** Where the uploader's bytes come from (fetched fresh at upload time). */
sealed class PayloadSource {
    abstract val size: Long

    /** Fresh InputStream over the payload bytes (opened once per upload). */
    abstract fun open(): java.io.InputStream

    /** Media row re-opened from its re-derived MediaStore URI. */
    class FilePayload(val uri: Uri, override val size: Long) : PayloadSource() {
        override fun open(): java.io.InputStream =
            ServiceLocator.context().contentResolver.openInputStream(uri)
                ?: throw IllegalStateException("content gone: $uri")
    }

    /** Small JSON payload (contact snapshot / SMS record) rebuilt on demand. */
    class BytesPayload(val bytes: ByteArray) : PayloadSource() {
        override val size: Long = bytes.size.toLong()
        override fun open(): java.io.InputStream = bytes.inputStream()
    }
}
