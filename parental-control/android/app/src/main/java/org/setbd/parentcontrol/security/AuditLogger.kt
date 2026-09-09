package org.setbd.parentcontrol.security

import android.content.Context
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Append-only audit trail: every privileged action (command executed, consent
 * granted/denied, session started/stopped, pairing change, SOS, bedtime
 * enforcement) is written to `devices/{deviceId}/auditLogs/{logId}` as
 * `{actorUid, deviceId, action, result, details, timestamp}`.
 *
 * WHY: a consent-based parental control product must be *transparent to the
 * family*: the parent dashboard and (via the child UI) the child can review
 * what happened on the device. Failures to upload are swallowed (logged
 * locally) — auditing must never crash or block the UX.
 */
class AuditLogger(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Fire-and-forget audit write on the IO dispatcher. */
    fun log(
        actorUid: String?,
        action: String,
        result: String,
        details: Map<String, Any?> = emptyMap(),
    ) {
        val deviceId = ServiceLocator.deviceId
        val entry = buildMap {
            put("actorUid", actorUid ?: "child-device")
            put("deviceId", deviceId)
            put("action", action)
            put("result", result)
            put("details", details)
            put("timestamp", FieldValue.serverTimestamp())
        }
        scope.launch {
            runCatching {
                firestore.collection(COLLECTION_DEVICES).document(deviceId)
                    .collection(COLLECTION_AUDIT_LOGS)
                    .add(entry)
                    .await()
            }.onFailure {
                android.util.Log.w(TAG, "audit write failed: ${it.message}")
            }
        }
    }

    companion object {
        private const val TAG = "AuditLogger"
        const val COLLECTION_DEVICES = "devices"
        const val COLLECTION_AUDIT_LOGS = "auditLogs"

        // Canonical action names (kept stable for dashboard filters).
        const val ACTION_PAIRING_APPROVED = "PAIRING_APPROVED"
        const val ACTION_UNPAIRED = "UNPAIRED"
        const val ACTION_COMMAND_EXECUTED = "COMMAND_EXECUTED"
        const val ACTION_COMMAND_REJECTED = "COMMAND_REJECTED"
        const val ACTION_COMMAND_UNSUPPORTED = "COMMAND_UNSUPPORTED"
        const val ACTION_CONSENT_GRANTED = "CONSENT_GRANTED"
        const val ACTION_CONSENT_DENIED = "CONSENT_DENIED"
        const val ACTION_SESSION_STARTED = "SESSION_STARTED"
        const val ACTION_SESSION_STOPPED = "SESSION_STOPPED"
        const val ACTION_SESSION_USER_DECLINED = "SESSION_USER_DECLINED"
        const val ACTION_SOS_TRIGGERED = "SOS_TRIGGERED"
        const val ACTION_SOS_RATE_LIMITED = "SOS_RATE_LIMITED"
        const val ACTION_SAFETY_CHECK_SHOWN = "SAFETY_CHECK_SHOWN"
        const val ACTION_SAFETY_CHECK_ANSWERED = "SAFETY_CHECK_ANSWERED"
        const val ACTION_BEDTIME_STARTED = "BEDTIME_STARTED"
        const val ACTION_BEDTIME_ENDED = "BEDTIME_ENDED"
        const val ACTION_DEVICE_LOCKED = "DEVICE_LOCKED"
        const val ACTION_APP_OPENED_VIA_DIAL_CODE = "APP_OPENED_VIA_DIAL_CODE"
        const val ACTION_APP_BLOCKED_BY_POLICY = "APP_BLOCKED_BY_POLICY"
        const val ACTION_ICON_VISIBILITY_CHANGED = "ICON_VISIBILITY_CHANGED"
        const val ACTION_JOBS_RESCHEDULED = "JOBS_RESCHEDULED"

        // Backup (v1.3.0) — consent-based cloud backup trail.
        const val ACTION_BACKUP_SCAN = "BACKUP_SCAN"
        const val ACTION_BACKUP_UPLOADED = "BACKUP_UPLOADED"
        const val ACTION_BACKUP_RESTORE = "BACKUP_RESTORE"
    }
}
