package org.setbd.parentcontrol.backup

import android.content.Context
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import org.json.JSONObject
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger

/**
 * BackupPolicyRepository — the child-side half of the dual-opt-in model.
 *
 *  - LISTENS to `devices/{id}/backupPolicy/current` (parent toggles, written
 *    only by the backupSetPolicy callable). Offline devices keep enforcing
 *    the last known-good policy from the SecureStore cache.
 *  - Publishes the policy as a StateFlow so the Settings UI and the workers
 *    observe the same truth.
 *  - Writes the CHILD's own consent doc (`devices/{id}/backupConsent/current`)
 *    when the child enables/disables a category in the app — this is the
 *    explicit, user-visible Allow/Decline surface required by the safety
 *    contract. The write is a narrow rules-validated map ({granted} per
 *    category + server timestamp); nothing else is client-writable there.
 *  - Every policy flip triggers a reconcile pass (scan + upload workers) so
 *    toggles take effect immediately: ON → eligible PENDING items resume;
 *    OFF → the server-side pre-check cancels queued uploads.
 */
class BackupPolicyRepository(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _policy = MutableStateFlow(loadCachedPolicy())
    val policy: StateFlow<BackupPolicy> = _policy.asStateFlow()

    private var listener: ListenerRegistration? = null

    fun start() {
        if (listener != null) return
        listener = firestore.collection("devices")
            .document(ServiceLocator.deviceId)
            .collection("backupPolicy")
            .document("current")
            .addSnapshotListener { snapshot, _ ->
                val data = snapshot?.data ?: return@addSnapshotListener
                parsePolicy(data)?.let { fresh ->
                    if (fresh.version >= _policy.value.version) {
                        _policy.value = fresh
                        ServiceLocator.secureStore.cacheBackupPolicyJson(toJson(fresh))
                        // Policy changed → reconcile the queue (resume/cancel).
                        BackupScheduler.requestReconcile(context)
                    }
                }
            }
    }

    fun stop() {
        listener?.remove()
        listener = null
    }

    /**
     * Writes the child consent for one category (the in-app consent dialog
     * calls this). Returns true when the write was accepted by Firestore.
     */
    suspend fun setChildConsent(category: BackupCategory, granted: Boolean): Boolean {
        val childUid = ServiceLocator.auth.childUid.value ?: return false
        return try {
            firestore.collection("devices")
                .document(ServiceLocator.deviceId)
                .collection("backupConsent")
                .document("current")
                .set(
                    mapOf(
                        "consent" to mapOf(
                            category.id to mapOf(
                                "granted" to granted,
                                "grantedAt" to FieldValue.serverTimestamp(),
                            )
                        ),
                        "updatedAt" to FieldValue.serverTimestamp(),
                    ),
                    com.google.firebase.firestore.SetOptions.merge()
                )
                .await()
            ServiceLocator.auditLogger.log(
                actorUid = childUid,
                action = if (granted) AuditLogger.ACTION_CONSENT_GRANTED else AuditLogger.ACTION_CONSENT_DENIED,
                result = "backup:${category.id}",
            )
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Current cached consent (used by workers before hitting the network). */
    suspend fun refreshConsentCache(): JSONObject? {
        return try {
            val snap = firestore.collection("devices")
                .document(ServiceLocator.deviceId)
                .collection("backupConsent")
                .document("current")
                .get()
                .await()
            snap.data?.let { JSONObject(it).also { json ->
                ServiceLocator.secureStore.cacheBackupConsentJson(json.toString())
            } }
        } catch (e: Exception) {
            ServiceLocator.secureStore.cachedBackupConsentJson()
                ?.let { runCatching { JSONObject(it) }.getOrNull() }
        }
    }

    // ------------------------------------------------------------ parsing --

    private fun loadCachedPolicy(): BackupPolicy =
        ServiceLocator.secureStore.cachedBackupPolicyJson()
            ?.let { json -> runCatching { fromJson(JSONObject(json)) }.getOrNull() }
            ?: BackupPolicy()

    private fun parsePolicy(data: Map<String, Any?>): BackupPolicy? {
        val version = (data["version"] as? Number)?.toLong() ?: return null
        if (version <= 0) return null
        val categories = data["categories"] as? Map<*, *> ?: return null
        fun enabled(id: String) =
            ((categories[id] as? Map<*, *>)?.get("enabled") as? Boolean) == true
        return BackupPolicy(
            version = version,
            photos = CategoryPolicy(enabled("photos")),
            videos = CategoryPolicy(enabled("videos")),
            contacts = CategoryPolicy(enabled("contacts")),
            sms = CategoryPolicy(enabled("sms")),
        )
    }

    private fun toJson(p: BackupPolicy): String = JSONObject().apply {
        put("version", p.version)
        put("photos", p.photos.enabled)
        put("videos", p.videos.enabled)
        put("contacts", p.contacts.enabled)
        put("sms", p.sms.enabled)
    }.toString()

    private fun fromJson(j: JSONObject): BackupPolicy = BackupPolicy(
        version = j.optLong("version", 0),
        photos = CategoryPolicy(j.optBoolean("photos", false)),
        videos = CategoryPolicy(j.optBoolean("videos", false)),
        contacts = CategoryPolicy(j.optBoolean("contacts", false)),
        sms = CategoryPolicy(j.optBoolean("sms", false)),
    )
}
