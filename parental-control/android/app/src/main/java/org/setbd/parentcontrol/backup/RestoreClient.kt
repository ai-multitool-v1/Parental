package org.setbd.parentcontrol.backup

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.net.SecureApi
import org.setbd.parentcontrol.security.AuditLogger
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * RestoreClient — the phone-reset / new-device recovery path (requirement 15).
 *
 * FLOW: after a factory reset the child app is re-paired; the childUid is
 * the same, so the child's DEK (escrowed per-child, NOT per-device) still
 * decrypts every backup made by ANY device of this child:
 *   1. backupListForChild  → restorable items across all devices of this child
 *   2. backupGetKey(reason="restore") → same DEK used at encryption
 *   3. per item: backupGetDownloadUrl is a PARENT callable, so ON-DEVICE
 *      restore focuses on what the device can authorize:
 *        - Contacts: rebuild from a backup payload requires the payload
 *          bytes → fetched by the PARENT from the dashboard and pushed via
 *          the payload file, OR the device pulls through the parent-issued
 *          short-lived URL handed to the restore flow by the parent action
 *          ("Restore to device" command on the dashboard).
 *      For self-service restore the device restores CONTACTS from a payload
 *      handed over by [restoreContactsFromPayload] (the dashboard's
 *      "Restore" button produces this JSON through a parent-authorized
 *      download + decrypt, then sends it via the standard notification
 *      payload channel — size-bounded, user-visible).
 *
 * CAPABILITY MATRIX (honest reporting, no bypass):
 *   Contacts restore  → SUPPORTED (WRITE_CONTACTS, visible inserts)
 *   Media restore     → SUPPORTED via parent dashboard download (files are
 *                       re-saved by the parent, or copied to the device by
 *                       the family through normal file transfer); on-device
 *                       silent media rewrite is deliberately NOT implemented
 *                       (a consent product must not bulk-rewrite the child's
 *                       gallery invisibly).
 *   SMS restore       → UNSUPPORTED by Android design since 4.4 (only the
 *                       default SMS app may write Telephony.Sms). We do NOT
 *                       become the default SMS app to gain it. The parent can
 *                       still download the decrypted SMS archive.
 */
class RestoreClient(private val context: Context) {

    /** True when contacts can be written back (restore capability probe). */
    fun canRestoreContacts(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Lists restorable backup metadata for this child across all its devices.
     * Returns server-verified rows only (state == UPLOADED).
     */
    suspend fun listRestorable(childUid: String): List<RestoreItem> = withContext(Dispatchers.IO) {
        try {
            val data = SecureApi.call("backupListForChild", mapOf("childUid" to childUid))
            @Suppress("UNCHECKED_CAST")
            val items = data["items"] as? List<Map<String, Any?>> ?: emptyList()
            items.mapNotNull { row ->
                val category = BackupCategory.fromId(row["category"] as? String)
                    ?: return@mapNotNull null
                RestoreItem(
                    itemId = row["itemId"] as? String ?: return@mapNotNull null,
                    sourceDeviceId = row["deviceId"] as? String ?: "",
                    category = category,
                    fileName = row["fileName"] as? String ?: "",
                    mimeType = row["mimeType"] as? String ?: "application/octet-stream",
                    sizeBytes = (row["sizeBytes"] as? Number)?.toLong() ?: 0L,
                    ivB64 = row["ivB64"] as? String ?: return@mapNotNull null,
                )
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * Restores contacts from a decrypted payload JSON (produced by the
     * parent's authorized download+decrypt on the dashboard). Each contact
     * is inserted through the standard ContactsContract insert path —
     * visible to the user, audited, and rate-bounded by the payload size.
     */
    suspend fun restoreContactsFromPayload(payloadJson: ByteArray): Int = withContext(Dispatchers.IO) {
        if (!canRestoreContacts()) return@withContext 0
        val arr = JSONObject(String(payloadJson, Charsets.UTF_8)).optJSONArray("contacts")
            ?: return@withContext 0
        var inserted = 0
        for (i in 0 until minOf(arr.length(), 500)) { // hard bound: one pass ≤ 500 contacts
            val obj = arr.optJSONObject(i) ?: continue
            val insertedRow = insertContact(
                name = obj.optString("name", "Restored contact"),
                phones = obj.optJSONArray("phones")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("number") }
                } ?: emptyList(),
                emails = obj.optJSONArray("emails")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("address") }
                } ?: emptyList(),
            )
            if (insertedRow) inserted++
        }
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_BACKUP_RESTORE,
            result = "contacts=$inserted",
        )
        inserted
    }

    private fun insertContact(name: String, phones: List<String>, emails: List<String>): Boolean {
        return try {
            val ops = arrayListOf<android.content.ContentProviderOperation>()
            ops += android.content.ContentProviderOperation
                .newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                .build()
            ops += android.content.ContentProviderOperation
                .newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE
                )
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
                .build()
            phones.take(3).forEach { number ->
                ops += android.content.ContentProviderOperation
                    .newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(
                        ContactsContract.Data.MIMETYPE,
                        ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE
                    )
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                    .build()
            }
            emails.take(3).forEach { address ->
                ops += android.content.ContentProviderOperation
                    .newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(
                        ContactsContract.Data.MIMETYPE,
                        ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE
                    )
                    .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, address)
                    .build()
            }
            context.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Streams + decrypts one item to a file (used by the device's own
     * restore UI when the parent grants a download URL for an item).
     */
    suspend fun decryptToFile(
        downloadUrl: String,
        ivB64: String,
        keyB64: String,
        target: File,
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val conn = URL(downloadUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            val ok = try {
                conn.responseCode in 200..299
            } catch (e: Exception) {
                false
            }
            if (!ok) {
                conn.disconnect()
                return@withContext false
            }
            conn.inputStream.use { input ->
                FileOutputStream(target).use { out ->
                    CryptoEngine.decryptStream(input, out, keyB64, ivB64)
                }
            }
            true
        } catch (e: Exception) {
            // GCM tag failure lands here — tampered/truncated ciphertext is
            // rejected, never written partially as if valid.
            target.delete()
            false
        }
    }
}

/** One restorable item as returned by backupListForChild. */
data class RestoreItem(
    val itemId: String,
    val sourceDeviceId: String,
    val category: BackupCategory,
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val ivB64: String,
)
