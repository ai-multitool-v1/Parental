package org.setbd.parentcontrol.backup

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.os.Build
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Telephony
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Backup content sources — the ONLY places in the app that read user content
 * for backup. Each source:
 *   • states its own runtime permission (checked right before every scan —
 *     a revoked permission stops the module gracefully, requirement 3/17),
 *   • states whether the device/OS genuinely supports it (no bypassing,
 *     no stealth fallback — requirement 18),
 *   • produces [ScannedBackup] rows with a deterministic sourceKey that the
 *     uploader later re-resolves into content (metadata-only in Firestore).
 */

/** One detected backup unit (metadata; content resolved later by sourceKey). */
data class ScannedBackup(
    val category: BackupCategory,
    val sourceKey: String,
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val checksumSha256: String,
    /** Resolved content URI for the uploader (never written to Firestore). */
    val contentUri: String,
    /** Content payload for small items (contacts/SMS JSON); null for media. */
    val inlinePayload: ByteArray? = null,
) {
    override fun equals(other: Any?) = this === other
    override fun hashCode() = System.identityHashCode(this)
}

private fun granted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/* ============================ Photos / Videos ============================ */

/**
 * MediaStore-backed scanner for photos and videos (requirement 3). Uses the
 * versioned media permissions: READ_MEDIA_IMAGES/READ_MEDIA_VIDEO on
 * Android 13+, READ_EXTERNAL_STORAGE on 12L and below (maxSdk 32). Only
 * delta rows (DATE_MODIFIED > cursor) are emitted; a hard per-pass cap
 * keeps the first sync bounded and battery-friendly.
 */
class MediaBackupSource(private val category: BackupCategory) {

    fun hasPermission(context: Context): Boolean = when {
        Build.VERSION.SDK_INT >= 33 && category == BackupCategory.PHOTOS ->
            granted(context, Manifest.permission.READ_MEDIA_IMAGES)
        Build.VERSION.SDK_INT >= 33 && category == BackupCategory.VIDEOS ->
            granted(context, Manifest.permission.READ_MEDIA_VIDEO)
        else -> granted(context, Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    fun isSupported(context: Context): Boolean = true // MediaStore exists on API 21+

    private fun collection(): android.net.Uri = when (category) {
        BackupCategory.PHOTOS -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        BackupCategory.VIDEOS -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else -> throw IllegalArgumentException("media source needs PHOTOS/VIDEOS")
    }

    private fun mediaPermission(): String = when (category) {
        BackupCategory.PHOTOS -> Manifest.permission.READ_MEDIA_IMAGES
        else -> Manifest.permission.READ_MEDIA_VIDEO
    }

    /**
     * Scans media newer than [sinceMs] (MediaStore compares epoch seconds;
     * the cursor is kept in epoch millis everywhere — converted internally).
     */
    fun scan(context: Context, sinceMs: Long, limit: Int = 200): ScanResult {
        if (!hasPermission(context)) return ScanResult.permissionRevoked(sinceMs)
        val sinceSec = sinceMs / 1000
        val selection = "${MediaStore.MediaColumns.DATE_MODIFIED} > ?"
        val args = arrayOf(sinceSec.toString())
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
        )
        val rows = mutableListOf<ScannedBackup>()
        var watermark = sinceSec
        try {
            context.contentResolver.query(collection(), projection, selection, args, null)?.use { c ->
                val iId = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val iName = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val iMime = c.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val iSize = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val iMod = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                while (c.moveToNext() && rows.size < limit) {
                    val id = c.getLong(iId)
                    val modified = c.getLong(iMod)
                    if (modified > watermark) watermark = modified
                    val size = c.getLong(iSize)
                    val name = c.getString(iName) ?: "media_$id"
                    val mime = c.getString(iMime) ?: "application/octet-stream"
                    val sourceKey = "ms_${id}_${modified}_$size"
                    // fileName carries the MediaStore id so the uploader can
                    // re-derive the row URI later: "media_{id}_{displayName}".
                    rows += ScannedBackup(
                        category = category,
                        sourceKey = sourceKey,
                        fileName = "media_${id}_${name}".take(500),
                        mimeType = mime,
                        sizeBytes = size,
                        // Identity checksum (cheap); content integrity is
                        // enforced cryptographically by the AES-GCM tag.
                        checksumSha256 = CryptoEngine.sha256Hex("media|$sourceKey"),
                        contentUri = android.net.Uri.withAppendedPath(collection(), id.toString())
                            .toString(),
                    )
                }
            }
        } catch (e: SecurityException) {
            // Permission was revoked mid-scan → graceful stop (requirement 3).
            return ScanResult.permissionRevoked(sinceMs)
        }
        // Cursor unit convention: ALWAYS epoch millis across categories
        // (media internally compares seconds; we convert back on return).
        return ScanResult(rows, watermark * 1000)
    }

    companion object {
        /** Media permission label used by PermissionReporter. */
        fun mediaPermissionFor(category: BackupCategory): String = when (category) {
            BackupCategory.PHOTOS -> Manifest.permission.READ_MEDIA_IMAGES
            else -> Manifest.permission.READ_MEDIA_VIDEO
        }

        /** Pre-13 storage permission (maxSdk 32 in the manifest). */
        const val LEGACY_STORAGE_PERMISSION = Manifest.permission.READ_EXTERNAL_STORAGE
    }
}

/* ================================ Contacts =============================== */

/**
 * ContactsContract scanner (requirement 4): delta via
 * CONTACT_LAST_UPDATED_TIMESTAMP (API 26+; on API 21–25 a full sync runs at
 * most once per 24h — an honest, documented downgrade). Payload is a small
 * JSON snapshot per contact; its sha256 is the TRUE content checksum, so a
 * changed phone number produces both a new sourceKey and a new checksum.
 */
class ContactsBackupSource {

    fun hasPermission(context: Context): Boolean = granted(context, Manifest.permission.READ_CONTACTS)
    fun isSupported(context: Context): Boolean = true

    fun scan(context: Context, sinceMs: Long, limit: Int = 200): ScanResult {
        if (!hasPermission(context)) return ScanResult.permissionRevoked(sinceMs)
        val deltaSupported = Build.VERSION.SDK_INT >= 26
        // Real delta filter (API 26+): CONTACT_LAST_UPDATED_TIMESTAMP > since.
        val sel = if (deltaSupported) "${ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP} > ?" else null
        val selArgs = if (deltaSupported) arrayOf(sinceMs.toString()) else null

        val rows = mutableListOf<ScannedBackup>()
        var watermark = sinceMs
        try {
            context.contentResolver.query(
                ContactsContract.Contacts.CONTENT_URI,
                arrayOf(
                    ContactsContract.Contacts._ID,
                    ContactsContract.Contacts.LOOKUP_KEY,
                    ContactsContract.Contacts.DISPLAY_NAME,
                    if (deltaSupported) ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP
                    else ContactsContract.Contacts._ID,
                ),
                sel,
                selArgs,
                if (deltaSupported) null else ContactsContract.Contacts._ID,
            )?.use { c ->
                val iId = c.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
                val iName = c.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME)
                val iUpd = if (deltaSupported)
                    c.getColumnIndexOrThrow(ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP) else -1
                while (c.moveToNext() && rows.size < limit) {
                    val id = c.getLong(iId)
                    val updated = if (deltaSupported && iUpd >= 0) c.getLong(iUpd) else System.currentTimeMillis()
                    if (updated > watermark) watermark = updated
                    val name = c.getString(iName) ?: "contact_$id"
                    val payload = rebuildContactPayload(context, id)
                        ?: continue // deleted/racy row — skip
                    val hash = sha256Hex(payload)
                    val sourceKey = "c_${id}_$hash".let { "c_${id}_${updated}_$hash" }
                    rows += ScannedBackup(
                        category = BackupCategory.CONTACTS,
                        sourceKey = sourceKey,
                        fileName = "contact_$id.json",
                        mimeType = "application/json",
                        sizeBytes = payload.size.toLong(),
                        checksumSha256 = hash,
                        contentUri = android.net.Uri.withAppendedPath(
                            ContactsContract.Contacts.CONTENT_URI, id.toString()
                        ).toString(),
                        inlinePayload = payload,
                    )
                }
            }
        } catch (e: SecurityException) {
            return ScanResult.permissionRevoked(sinceMs)
        }
        return ScanResult(rows, watermark)
    }

    /** Small JSON snapshot: display name, phones, emails — rebuilt on demand. */
    fun rebuildContactPayload(context: Context, contactId: Long): ByteArray? {
        var displayName = "contact_$contactId"
        context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(ContactsContract.Contacts.DISPLAY_NAME),
            "${ContactsContract.Contacts._ID} = ?",
            arrayOf(contactId.toString()),
            null,
        )?.use { c -> if (c.moveToFirst()) c.getString(0)?.let { displayName = it } }
            ?: return null // contact deleted — cannot back up
        val obj = JSONObject()
        obj.put("id", contactId)
        obj.put("name", displayName)
        obj.put("capturedAt", System.currentTimeMillis())
        val phones = JSONArray()
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.NUMBER,
                ContactsContract.CommonDataKinds.Phone.TYPE,
            ),
            "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
            arrayOf(contactId.toString()),
            null,
        )?.use { p ->
            while (p.moveToNext()) {
                phones.put(JSONObject().put("number", p.getString(0) ?: "").put("type", p.getInt(1)))
            }
        }
        obj.put("phones", phones)
        val emails = JSONArray()
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Email.ADDRESS,
                ContactsContract.CommonDataKinds.Email.TYPE,
            ),
            "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
            arrayOf(contactId.toString()),
            null,
        )?.use { e ->
            while (e.moveToNext()) {
                emails.put(JSONObject().put("address", e.getString(0) ?: "").put("type", e.getInt(1)))
            }
        }
        obj.put("emails", emails)
        return obj.toString().toByteArray(Charsets.UTF_8)
    }
    companion object {
        const val WRITE_PERMISSION = Manifest.permission.WRITE_CONTACTS
    }
}

/* ================================== SMS ================================== */

/**
 * OPTIONAL SMS module (requirement 5). Compliance posture:
 *  - Runtime READ_SMS permission is requested ONLY through the standard
 *    system dialog, from the visible backup-settings UI, with a plain
 *    explanation — no request-time spoofing, no AppOps manipulation,
 *    no default-SMS-app takeover.
 *  - The module degrades to UNSUPPORTED (never partially works) when the
 *    system will not grant it: Play policy restricts READ_SMS to default
 *    handlers + vetted exceptions on Play-distributed builds, and some
 *    OEMs auto-revoke it. The Settings UI shows the honest state either way.
 *  - Content: per-message JSON (sender hash — NOT the raw number — date,
 *    type, body). SMS content is encrypted with the same AES-256-GCM
 *    engine before upload (requirement 5/10); the raw number is hashed so
 *    even the metadata envelope carries no direct PII.
 */
class SmsBackupSource {

    fun hasPermission(context: Context): Boolean = granted(context, Manifest.permission.READ_SMS)

    /** Telephony-capable device + actually-granted permission. */
    fun isSupported(context: Context): Boolean {
        val pm = context.packageManager
        val hasTelephony = pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
        return hasTelephony && hasPermission(context)
    }

    fun scan(context: Context, sinceMs: Long, limit: Int = 200): ScanResult {
        if (!isSupported(context)) return ScanResult.unsupported(sinceMs)
        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
        )
        val selection = "${Telephony.Sms.DATE} > ?"
        val args = arrayOf(sinceMs.toString())
        val rows = mutableListOf<ScannedBackup>()
        var watermark = sinceMs
        try {
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI, projection, selection, args, null
            )?.use { c ->
                val iId = c.getColumnIndexOrThrow(Telephony.Sms._ID)
                val iDate = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
                val iType = c.getColumnIndexOrThrow(Telephony.Sms.TYPE)
                val iAddr = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val iBody = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
                while (c.moveToNext() && rows.size < limit) {
                    val id = c.getLong(iId)
                    val date = c.getLong(iDate)
                    if (date > watermark) watermark = date
                    val body = c.getString(iBody) ?: ""
                    // Hash the sender instead of storing the raw number.
                    val addrHash = sha256Hex((c.getString(iAddr) ?: "").toByteArray(Charsets.UTF_8))
                        .take(16)
                    val payload = JSONObject()
                        .put("smsId", id)
                        .put("date", date)
                        .put("type", c.getInt(iType))
                        .put("addressHash", addrHash)
                        .put("body", body)
                        .toString().toByteArray(Charsets.UTF_8)
                    val hash = sha256Hex(payload)
                    rows += ScannedBackup(
                        category = BackupCategory.SMS,
                        sourceKey = "s_${id}_${date}_$hash",
                        fileName = "sms_$id.json",
                        mimeType = "application/json",
                        sizeBytes = payload.size.toLong(),
                        checksumSha256 = hash,
                        contentUri = android.net.Uri.withAppendedPath(
                            android.net.Uri.parse("content://sms"), id.toString()
                        ).toString(),
                        inlinePayload = payload,
                    )
                }
            }
        } catch (e: SecurityException) {
            return ScanResult.permissionRevoked(sinceMs)
        }
        return ScanResult(rows, watermark)
    }

    /**
     * Re-reads one SMS record by _ID at UPLOAD time (the scan-time snapshot
     * is not persisted — content is always fetched fresh, encrypted, and
     * never cached on disk in plaintext).
     */
    fun rebuildSmsPayload(context: Context, smsId: Long): ByteArray? {
        if (!hasPermission(context)) return null
        val projection = arrayOf(
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
        )
        return try {
            context.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                projection,
                "${Telephony.Sms._ID} = ?",
                arrayOf(smsId.toString()),
                null,
            )?.use { c ->
                if (!c.moveToFirst()) return null
                val date = c.getLong(0)
                val type = c.getInt(1)
                val addrHash = sha256Hex((c.getString(2) ?: "").toByteArray(Charsets.UTF_8)).take(16)
                val body = c.getString(3) ?: ""
                JSONObject()
                    .put("smsId", smsId)
                    .put("date", date)
                    .put("type", type)
                    .put("addressHash", addrHash)
                    .put("body", body)
                    .toString().toByteArray(Charsets.UTF_8)
            }
        } catch (e: SecurityException) {
            null
        }
    }
}

/* ================================ plumbing =============================== */

/**
 * Non-throwing scan outcome: the produced rows plus the advanced watermark
 * (epoch seconds for media, epoch millis for contacts/SMS — the caller
 * stores it back into the matching cursor). Terminal states carry no rows
 * and leave the cursor untouched so the next pass retries.
 */
data class ScanResult(val rows: List<ScannedBackup>, val watermark: Long) {
    companion object {
        /** Permission revoked mid-flow → graceful stop, cursor untouched. */
        fun permissionRevoked(cursor: Long): ScanResult = ScanResult(emptyList(), cursor)
        fun unsupported(cursor: Long): ScanResult = ScanResult(emptyList(), cursor)
    }
}
