package org.setbd.parentcontrol.policies

import android.content.Context
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.SecureStore
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.json.JSONObject

/** Bedtime schedule from the policy doc (24h "HH:mm" strings, ISO days 1=Mon..7=Sun). */
data class BedtimePolicy(
    val start: String,                       // "21:30"
    val end: String,                         // "07:00"
    val days: Set<Int>,                      // ISO day-of-week
    val allowedPackages: List<String>,       // apps still usable at bedtime
)

/** Full child policy document. */
data class Policy(
    val version: Long,
    val appBlockList: List<String>,
    val dailyLimitsMinutes: Map<String, Long>,
    val bedtime: BedtimePolicy?,
    val emergencyContacts: List<Map<String, String?>>,
    val updatedAtMs: Long,
    /** Device settings carried by the policy (applied only when the device
     *  management mode supports them — never bypassed). */
    val hideAppIcon: Boolean = false,
    val protectSettings: Boolean = false,
)

/**
 * Policy engine for the child device.
 *
 * Source of truth: `devices/{deviceId}/policies/current`. On every snapshot
 * (and on the SYNC_POLICY command) we:
 *   1. validate the document,
 *   2. apply it only if its `version` is NEWER than the cached one
 *      (conflict resolution — an older snapshot never rolls back a newer
 *      policy),
 *   3. cache the JSON in [SecureStore] so offline devices keep enforcing the
 *      last known-good policy,
 *   4. re-arm bedtime alarms via [BedtimeScheduler].
 */
class PolicyRepository(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _policy = MutableStateFlowShared()
    val policyFlow = _policy.flow

    private var listener: ListenerRegistration? = null

    fun start() {
        if (listener != null) return
        listener = firestore.collection("devices")
            .document(ServiceLocator.deviceId)
            .collection("policies")
            .document("current")
            .addSnapshotListener { snapshot, error ->
                if (error != null || snapshot == null || !snapshot.exists()) return@addSnapshotListener
                snapshot.data?.let { applyPolicy(it) }
            }
    }

    fun stop() {
        listener?.remove()
        listener = null
    }

    /** One-shot server refresh used by the SYNC_POLICY command. */
    suspend fun refreshNow(): Boolean {
        return try {
            val snapshot = firestore.collection("devices")
                .document(ServiceLocator.deviceId)
                .collection("policies")
                .document("current")
                .get()
                .await()
            val data = snapshot.data ?: return false
            applyPolicy(data)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Applies the policy's device-management settings:
     *  * `hideAppIcon` — hides THIS app's launcher icon using the official
     *    DevicePolicyManager.setApplicationHidden API (Device Owner / Profile
     *    Owner devices, API 28+). The child app goes dormant while hidden;
     *    the parent re-opens it by dialing *#*#1111#*#* (SecretCodeReceiver
     *    un-hides and launches). On non-owner devices this reports
     *    UNSUPPORTED and the icon stays visible — no stealth mechanism is
     *    used as a fallback.
     *  * `protectSettings` — the accessibility App Guard blocks the Settings
     *    app (prevents deactivating device admin) while enabled.
     */
    private fun applyDeviceSettings(policy: Policy) {
        val wrapper = ServiceLocator.devicePolicyWrapper
        val currentlyHidden = wrapper.isSelfHidden()
        if (policy.hideAppIcon && !currentlyHidden) {
            when (wrapper.setApplicationHidden(context.packageName, true)) {
                org.setbd.parentcontrol.management.EnforcementResult.Supported ->
                    ServiceLocator.auditLogger.log(
                        actorUid = ServiceLocator.auth.childUid.value,
                        action = org.setbd.parentcontrol.security.AuditLogger.ACTION_ICON_VISIBILITY_CHANGED,
                        result = "hidden (policy v${policy.version})",
                    )
                else -> ServiceLocator.auditLogger.log(
                    actorUid = ServiceLocator.auth.childUid.value,
                    action = org.setbd.parentcontrol.security.AuditLogger.ACTION_COMMAND_UNSUPPORTED,
                    result = "hideAppIcon UNSUPPORTED (needs Device Owner, API 28+)",
                )
            }
        } else if (!policy.hideAppIcon && currentlyHidden) {
            wrapper.setApplicationHidden(context.packageName, false)
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = org.setbd.parentcontrol.security.AuditLogger.ACTION_ICON_VISIBILITY_CHANGED,
                result = "visible (policy v${policy.version})",
            )
        }
    }

    /** Validate + version-check + cache + schedule. Returns the applied version, or -1 if ignored. */
    private fun applyPolicy(data: Map<String, Any?>): Long {
        val policy = parsePolicy(data) ?: return -1L
        val cachedVersion = currentPolicy()?.version ?: 0L
        if (policy.version <= cachedVersion) return -1L // stale snapshot — ignore

        ServiceLocator.secureStore.cachePolicyJson(toJson(policy))
        _policy.set(policy)

        // Re-arm bedtime alarms for the new schedule.
        BedtimeScheduler.scheduleNext(context, policy)
        ServiceLocator.appState.setBedtimeActive(BedtimeScheduler.isInBedtimeWindowNow(policy))

        // Apply device-management settings (official DevicePolicyManager APIs
        // only; silently no-ops with an audit entry when unsupported).
        applyDeviceSettings(policy)

        // Observability for the dashboard ("policy v3 applied").
        scope.launch {
            runCatching {
                firestore.collection("devices").document(ServiceLocator.deviceId)
                    .set(mapOf("policyVersion" to policy.version), SetOptions.merge()).await()
            }
        }
        return policy.version
    }

    /** Latest valid policy: memory first, then the encrypted offline cache. */
    fun currentPolicy(): Policy? {
        _policy.get()?.let { return it }
        return ServiceLocator.secureStore.cachedPolicyJson()?.let { json ->
            runCatching { fromJson(JSONObject(json)) }.getOrNull()
        }
    }

    // ------------------------------ (de)serialization -------------------------

    private fun parsePolicy(data: Map<String, Any?>): Policy? {
        val version = (data["version"] as? Number)?.toLong() ?: return null
        if (version <= 0) return null
        val blockList = (data["appBlockList"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
        val limits = (data["dailyLimits"] as? Map<*, *>)
            ?.mapNotNull { (k, v) ->
                val key = k as? String ?: return@mapNotNull null
                val minutes = (v as? Number)?.toLong() ?: return@mapNotNull null
                key to minutes
            }?.toMap() ?: emptyMap()
        val bedtimeMap = data["bedtime"] as? Map<*, *>
        val bedtime = bedtimeMap?.let { b ->
            val start = b["start"] as? String ?: return@let null
            val end = b["end"] as? String ?: return@let null
            if (!Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(start) ||
                !Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(end)
            ) return@let null
            BedtimePolicy(
                start = start,
                end = end,
                days = (b["days"] as? List<*>)?.filterIsInstance<Number>()?.map { it.toInt() }?.toSet()
                    ?: setOf(1, 2, 3, 4, 5, 6, 7),
                allowedPackages = (b["allowedPackages"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
            )
        }
        val contacts = (data["emergencyContacts"] as? List<*>)
            ?.filterIsInstance<Map<*, *>>()
            ?.map { c ->
                mapOf(
                    "name" to (c["name"] as? String),
                    "phone" to (c["phone"] as? String),
                    "relation" to (c["relation"] as? String),
                )
            } ?: emptyList()
        val settings = data["settings"] as? Map<*, *>
        return Policy(
            version = version,
            appBlockList = blockList,
            dailyLimitsMinutes = limits,
            bedtime = bedtime,
            emergencyContacts = contacts,
            updatedAtMs = (data["updatedAt"] as? com.google.firebase.Timestamp)?.toDate()?.time
                ?: System.currentTimeMillis(),
            hideAppIcon = settings?.get("hideAppIcon") as? Boolean ?: false,
            protectSettings = settings?.get("protectSettings") as? Boolean ?: false,
        )
    }

    private fun toJson(p: Policy): String = JSONObject().apply {
        put("version", p.version)
        put("appBlockList", JSONArray(p.appBlockList))
        put("dailyLimitsMinutes", JSONObject().apply { p.dailyLimitsMinutes.forEach { (k, v) -> put(k, v) } })
        put("updatedAtMs", p.updatedAtMs)
        p.bedtime?.let { b ->
            put(
                "bedtime", JSONObject().apply {
                    put("start", b.start); put("end", b.end)
                    put("days", JSONArray(b.days.toList()))
                    put("allowedPackages", JSONArray(b.allowedPackages))
                },
            )
        }
        put(
            "emergencyContacts", JSONArray().apply {
                p.emergencyContacts.forEach { c -> put(JSONObject().apply { c.forEach { (k, v) -> put(k, v ?: JSONObject.NULL) } }) }
            },
        )
        put(
            "settings", JSONObject().apply {
                put("hideAppIcon", p.hideAppIcon)
                put("protectSettings", p.protectSettings)
            },
        )
    }.toString()

    private fun fromJson(j: JSONObject): Policy = Policy(
        version = j.getLong("version"),
        appBlockList = j.optJSONArray("appBlockList")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
        dailyLimitsMinutes = j.optJSONObject("dailyLimitsMinutes")?.let { o ->
            o.keys().asSequence().associateWith { o.getLong(it) }
        } ?: emptyMap(),
        bedtime = j.optJSONObject("bedtime")?.let { b ->
            BedtimePolicy(
                start = b.getString("start"),
                end = b.getString("end"),
                days = b.optJSONArray("days")?.let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() }
                    ?: setOf(1, 2, 3, 4, 5, 6, 7),
                allowedPackages = b.optJSONArray("allowedPackages")?.let { a -> (0 until a.length()).map { a.getString(it) } }
                    ?: emptyList(),
            )
        },
        emergencyContacts = j.optJSONArray("emergencyContacts")?.let { a ->
            (0 until a.length()).map { i ->
                val c = a.getJSONObject(i)
                mapOf("name" to c.optString("name"), "phone" to c.optString("phone"), "relation" to c.optString("relation"))
            }
        } ?: emptyList(),
        updatedAtMs = j.optLong("updatedAtMs", System.currentTimeMillis()),
        hideAppIcon = j.optJSONObject("settings")?.optBoolean("hideAppIcon", false) ?: false,
        protectSettings = j.optJSONObject("settings")?.optBoolean("protectSettings", false) ?: false,
    )
}

/** Tiny wrapper so the nullable-policy StateFlow stays internal to this file. */
private class MutableStateFlowShared {
    private val backing = kotlinx.coroutines.flow.MutableStateFlow<Policy?>(null)
    val flow: kotlinx.coroutines.flow.StateFlow<Policy?> = backing
    fun get(): Policy? = backing.value
    fun set(p: Policy?) { backing.value = p }
}
