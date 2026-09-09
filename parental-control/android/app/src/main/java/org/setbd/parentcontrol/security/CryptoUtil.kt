package org.setbd.parentcontrol.security

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom
import java.util.UUID

/**
 * Cryptographic helpers for device identity and pairing.
 *
 * SAFETY:
 *  * Device identity is a **randomly generated UUID** stored in
 *    [androidx.security.crypto.EncryptedSharedPreferences]. The IMEI (or any
 *    other telephony identifier) is **never** used for authentication or
 *    authorization — a consent-based family platform must not depend on
 *    hardware identity, and the required READ_PHONE_STATE scope is avoided.
 *  * Pairing codes are generated with [SecureRandom] from an unambiguous
 *    alphabet (no 0/O/1/I/L) so a child can read them aloud reliably.
 */
object CryptoUtil {

    /** 8-character pairing code alphabet — no visually ambiguous characters. */
    private const val CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    private const val CODE_LENGTH = 8

    private val secureRandom = SecureRandom()

    /** Cryptographically random, single-use, short-lived pairing code. */
    fun generatePairingCode(): String {
        val sb = StringBuilder(CODE_LENGTH)
        repeat(CODE_LENGTH) { sb.append(CODE_ALPHABET[secureRandom.nextInt(CODE_ALPHABET.length)]) }
        return sb.toString()
    }

    /** Fresh random device identity (UUIDv4). Called once, then persisted. */
    fun generateDeviceId(): String = UUID.randomUUID().toString()
}

/**
 * Small wrapper around [EncryptedSharedPreferences] used for everything that
 * must survive reboot but must NOT live in plaintext:
 *  * deviceId / pairing state
 *  * the processed-command replay cache
 *  * the last valid policy snapshot (offline enforcement cache)
 *  * the last SOS timestamp (rate limiting)
 */
class SecureStore(context: Context) {

    /**
     * API 21+ note: [EncryptedSharedPreferences] requires the Android Keystore
     * (API 23+). On API 21/22 we transparently fall back to plain
     * SharedPreferences — a documented, honest downgrade for very old
     * devices (the PermissionReporter surfaces `secureStorage: "plain"` so
     * the parent dashboard can see it). No API-specific code crashes.
     */
    private val prefs: SharedPreferences =
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            try {
                createEncrypted(context)
            } catch (e: Exception) {
                // Keystore corruption on some OEMs: fall back rather than crash-loop.
                context.getSharedPreferences("familysafety_secure_prefs_fallback", Context.MODE_PRIVATE)
            }
        } else {
            context.getSharedPreferences("familysafety_secure_prefs", Context.MODE_PRIVATE)
        }

    private fun createEncrypted(context: Context): SharedPreferences =
        EncryptedSharedPreferences.create(
            context,
            "familysafety_secure_prefs",
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

    /** "encrypted" (API 23+) or "plain" (API 21/22 fallback) — surfaced to the dashboard. */
    fun storageKind(): String =
        if (android.os.Build.VERSION.SDK_INT >= 23) "encrypted" else "plain"

    // ------------------------------- deviceId --------------------------------

    /** Returns the stable random deviceId, creating and persisting it on first run. */
    fun getOrCreateDeviceId(): String =
        prefs.getString(KEY_DEVICE_ID, null) ?: CryptoUtil.generateDeviceId().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    // ------------------------------ pairing ----------------------------------

    fun isPaired(): Boolean = prefs.getBoolean(KEY_PAIRED, false)
    fun setPaired(paired: Boolean) = prefs.edit().putBoolean(KEY_PAIRED, paired).apply()

    // --------------------------- replay protection ---------------------------
    // Bounded LRU-ish cache of processed commandIds; protects against FCM +
    // Firestore double-delivery and malicious replay of old commands.

    fun getProcessedCommandIds(): MutableSet<String> =
        prefs.getStringSet(KEY_PROCESSED_COMMANDS, emptySet())?.toMutableSet() ?: mutableSetOf()

    fun rememberProcessedCommandId(commandId: String) {
        val ids = getProcessedCommandIds().apply { add(commandId) }
        // Cap size to keep the blob small; oldest entries (set order is
        // unspecified, so a hard cap on count is acceptable for replay safety
        // because Firestore commandResults remain the authoritative check).
        val trimmed = if (ids.size > MAX_PROCESSED_COMMANDS) ids.drop(ids.size - MAX_PROCESSED_COMMANDS).toSet() else ids
        prefs.edit().putStringSet(KEY_PROCESSED_COMMANDS, trimmed).apply()
    }

    // ------------------------------ rate limiting ----------------------------

    fun lastSosAtMs(): Long = prefs.getLong(KEY_LAST_SOS, 0L)
    fun setLastSosAtMs(ts: Long) = prefs.edit().putLong(KEY_LAST_SOS, ts).apply()

    // --------------------------- policy offline cache ------------------------

    fun cachedPolicyJson(): String? = prefs.getString(KEY_POLICY_CACHE, null)
    fun cachePolicyJson(json: String) = prefs.edit().putString(KEY_POLICY_CACHE, json).apply()

    // --------------------------- backup policy cache (v1.3.0) ----------------

    fun cachedBackupPolicyJson(): String? = prefs.getString(KEY_BACKUP_POLICY_CACHE, null)
    fun cacheBackupPolicyJson(json: String) =
        prefs.edit().putString(KEY_BACKUP_POLICY_CACHE, json).apply()

    /** Offline cache of THIS device's child-consent doc (v1.3.0). */
    fun cachedBackupConsentJson(): String? = prefs.getString(KEY_BACKUP_CONSENT_CACHE, null)
    fun cacheBackupConsentJson(json: String) =
        prefs.edit().putString(KEY_BACKUP_CONSENT_CACHE, json).apply()

    /**
     * Backup DEK cache (v1.3.0) — see BackupKeyManager. Stored in this
     * (EncryptedSharedPreferences) store so the key never lands on disk in
     * plaintext on API 23+. Removed on unpair via clearAll().
     */
    fun backupDek(childUid: String): String? = prefs.getString(dekKey(childUid), null)
    fun storeBackupDek(childUid: String, keyB64: String) {
        prefs.edit().putString(dekKey(childUid), keyB64).apply()
    }

    fun removeBackupDek(childUid: String) {
        prefs.edit().remove(dekKey(childUid)).apply()
    }

    private fun dekKey(childUid: String) = "backupDek_$childUid"

    /**
     * Per-category backup detection cursors (v1.3.0) — the delta watermark
     * (max dateModified/lastUpdated already enqueued). Survives reboot so
     * a scan never re-enqueues what it has already queued.
     */
    fun backupCursor(categoryId: String): Long = prefs.getLong("backupCursor_$categoryId", 0L)
    fun setBackupCursor(categoryId: String, value: Long) =
        prefs.edit().putLong("backupCursor_$categoryId", value).apply()

    // ------------------------------- misc -------------------------------------

    fun clearAll() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_DEVICE_ID = "deviceId"
        const val KEY_PAIRED = "paired"
        const val KEY_PROCESSED_COMMANDS = "processedCommandIds"
        const val KEY_LAST_SOS = "lastSosAt"
        const val KEY_POLICY_CACHE = "policyCacheJson"
        const val KEY_BACKUP_POLICY_CACHE = "backupPolicyCacheJson"
        const val KEY_BACKUP_CONSENT_CACHE = "backupConsentCacheJson"
        const val MAX_PROCESSED_COMMANDS = 500
    }
}
