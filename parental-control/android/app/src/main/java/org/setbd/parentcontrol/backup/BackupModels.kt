package org.setbd.parentcontrol.backup

/**
 * Backup domain models (v1.3.0) — consent-based automatic cloud backup.
 *
 * SAFETY CONTRACT:
 *  - A backup runs ONLY when ALL THREE gates are open:
 *      1. the parent enabled the category on the dashboard (backupPolicy),
 *      2. the CHILD consented on this device (backupConsent — an explicit
 *         in-app dialog at setup or later in Settings), and
 *      3. the matching Android runtime permission is granted right now.
 *    Losing ANY gate stops uploads gracefully; nothing is collected while
 *    any gate is closed, and nothing is ever re-opened silently.
 *  - Content is encrypted ON-DEVICE (AES-256-GCM) before it leaves the app.
 *  - Firestore stores METADATA ONLY (names/sizes/checksums/states) — media,
 *    contact and SMS content live in the private R2 bucket as ciphertext.
 */

/** The four consent-gated backup categories (exact product surface). */
enum class BackupCategory(val id: String) {
    PHOTOS("photos"),
    VIDEOS("videos"),
    CONTACTS("contacts"),
    SMS("sms");

    companion object {
        fun fromId(id: String?): BackupCategory? = entries.firstOrNull { it.id == id }
    }
}

/** Backup item lifecycle (mirrors Firestore + parent dashboard exactly). */
enum class BackupItemState {
    PENDING, UPLOADING, UPLOADED, FAILED, CANCELLED;

    companion object {
        fun fromId(id: String?): BackupItemState? = entries.firstOrNull { it.name == id }
    }
}

/** Why an upload is not eligible right now (drives dashboard messaging). */
object BlockReason {
    const val POLICY_DISABLED = "POLICY_DISABLED"
    const val CONSENT_MISSING = "CONSENT_MISSING"
    const val DEVICE_BANNED = "DEVICE_BANNED"
    const val PERMISSION_REVOKED = "PERMISSION_REVOKED"
    const val STORAGE_UNAVAILABLE = "BACKUP_STORAGE_UNAVAILABLE"
    const val R2_OBJECT_MISSING = "R2_OBJECT_MISSING"
    const val FILE_TOO_LARGE = "FILE_TOO_LARGE"
    const val NETWORK = "NETWORK"
    const val DUPLICATE = "DUPLICATE"
}

/** Per-category parent policy (devices/{id}/backupPolicy/current.categories). */
data class CategoryPolicy(
    val enabled: Boolean = false,
)

/** Full parent-side backup policy document. */
data class BackupPolicy(
    val version: Long = 0,
    val photos: CategoryPolicy = CategoryPolicy(),
    val videos: CategoryPolicy = CategoryPolicy(),
    val contacts: CategoryPolicy = CategoryPolicy(),
    val sms: CategoryPolicy = CategoryPolicy(),
) {
    fun category(cat: BackupCategory): CategoryPolicy = when (cat) {
        BackupCategory.PHOTOS -> photos
        BackupCategory.VIDEOS -> videos
        BackupCategory.CONTACTS -> contacts
        BackupCategory.SMS -> sms
    }

    val anyEnabled: Boolean
        get() = photos.enabled || videos.enabled || contacts.enabled || sms.enabled
}

/** Metadata for one backup unit (photo / video / contact snapshot / SMS batch). */
data class BackupItem(
    val itemId: String,
    val deviceId: String,
    val childUid: String,
    val category: BackupCategory,
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val checksumSha256: String,
    val state: BackupItemState = BackupItemState.PENDING,
    val attempts: Int = 0,
    val lastErrorCode: String? = null,
    val r2Key: String? = null,
    val ivB64: String? = null,
    val createdAtMs: Long = 0,
)

/** Result of a finished (successful or terminal) upload attempt. */
data class UploadOutcome(
    val item: BackupItem,
    val finalState: BackupItemState,
    val errorCode: String? = null,
)
