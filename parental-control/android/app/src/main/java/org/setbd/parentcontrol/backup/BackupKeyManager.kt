package org.setbd.parentcontrol.backup

import com.google.firebase.functions.FirebaseFunctions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.setbd.parentcontrol.di.ServiceLocator
import java.util.concurrent.ConcurrentHashMap

/**
 * BackupKeyManager — on-device access to the child's backup DEK.
 *
 * SECURITY:
 *  - The DEK is provisioned by Cloud Functions at pairing time and stored
 *    server-side ONLY in wrapped form (AES-256-GCM under a KEK in Secret
 *    Manager). The APK contains NO key material (nothing hardcoded).
 *  - This class fetches it over the authenticated callable channel
 *    (backupGetKey; App Check + device claim + rate limit + server audit)
 *    and caches it in SecureStore (Keystore-backed EncryptedSharedPreferences
 *    on API 23+; documented plain fallback on 21/22).
 *  - The cache is keyed by childUid: after a phone reset + re-pair the same
 *    childUid resolves to the SAME DEK, which is what makes restorable
 *    backups survive device replacement.
 *  - Keys are never logged, never emitted to crash reporters, and cleared
 *    with SecureStore.clearAll() on unpair.
 */
class BackupKeyManager {

    private val functions = FirebaseFunctions.getInstance()

    /** childUid → cached key (memory-only hot cache; persisted in SecureStore). */
    private val hot = ConcurrentHashMap<String, String>()

    /**
     * Returns the base64 DEK for [childUid]. Falls back to the secure cache
     * when offline; re-fetches when the cached key is missing.
     */
    suspend fun getKey(childUid: String): String = withContext(Dispatchers.IO) {
        hot[childUid]?.let { return@withContext it }

        val cached = ServiceLocator.secureStore.backupDek(childUid)
        if (cached != null) {
            hot[childUid] = cached
            return@withContext cached
        }

        val result = functions.getHttpsCallable("backupGetKey")
            .call(mapOf("childUid" to childUid, "reason" to "upload"))
            .await()
        @Suppress("UNCHECKED_CAST")
        val data = result.data as? Map<String, Any?>
            ?: throw BackupUnavailableException("KEY_RESPONSE_MALFORMED")
        val keyB64 = data["keyB64"] as? String
        if (keyB64.isNullOrBlank()) {
            throw BackupUnavailableException("KEY_RESPONSE_MALFORMED")
        }
        ServiceLocator.secureStore.storeBackupDek(childUid, keyB64)
        hot[childUid] = keyB64
        keyB64
    }

    /** Forget the in-memory copy (called on unpair / security wipe). */
    fun evictCache() = hot.clear()
}

/** Raised when the backup key path is genuinely unavailable (fail-closed). */
class BackupUnavailableException(val code: String) : Exception(code)

/** B64 validation helper shared by upload/restore paths (API 21-safe). */
fun isValidB64(value: String?, maxLen: Int = 64): Boolean =
    value != null && value.length <= maxLen && runCatching {
        android.util.Base64.decode(value, android.util.Base64.NO_WRAP)
    }.isSuccess
