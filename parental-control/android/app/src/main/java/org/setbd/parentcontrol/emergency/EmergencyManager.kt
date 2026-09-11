package org.setbd.parentcontrol.emergency

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.di.SafetyCheckResponse
import org.setbd.parentcontrol.notifications.NotificationChannels
import org.setbd.parentcontrol.security.AuditLogger
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Child-side SOS and parent-initiated safety checks.
 *
 * SOS (child-initiated):
 *  * The UI shows a confirmation dialog with a **3-second countdown** — a
 *    moment to breathe, and protection against accidental pocket triggers.
 *  * Server-side AND local rate limit: max 1 SOS per 5 minutes.
 *  * Writes `devices/{deviceId}/emergencyEvents/{eventId}` with timestamp,
 *    battery, network and a best-effort location snapshot (only if the child
 *    granted location permission — we never bypass it for emergencies).
 *
 * Safety check (parent-initiated TRIGGER_SAFETY_CHECK):
 *  * Shows a high-priority notification + in-app dialog: "Are you OK?" with
 *    "I'm OK" / "I need help" answers; a 10-minute timeout records NO_RESPONSE.
 */
class EmergencyManager(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Rate limit window for SOS. */
    private companion object {
        const val SOS_COOLDOWN_MS = 5 * 60 * 1000L
        const val SOS_COUNTDOWN_MS = 3000L
        const val SAFETY_CHECK_TIMEOUT_MS = 10 * 60 * 1000L
        const val EXTRA_COMMAND_ID = "safetyCheckCommandId"
    }

    val countdownMs: Long get() = SOS_COUNTDOWN_MS

    /**
     * Triggers an SOS after the UI's 3-2-1 countdown completed.
     * @return true when the event was written (false = rate limited).
     */
    suspend fun triggerSos(): Boolean {
        val now = System.currentTimeMillis()
        val last = ServiceLocator.secureStore.lastSosAtMs()
        if (now - last < SOS_COOLDOWN_MS) {
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_SOS_RATE_LIMITED,
                result = "cooldown_active",
            )
            return false
        }
        ServiceLocator.secureStore.setLastSosAtMs(now)

        val deviceId = ServiceLocator.deviceId
        val snapshot = ServiceLocator.deviceStatusMonitor.currentSnapshot()

        // Best-effort location: only with granted permission, never a bypass.
        var locationMap: Map<String, Any?>? = null
        if (ServiceLocator.locationRepository.hasFineLocation()) {
            ServiceLocator.locationRepository.writeSingleFix("SOS")
            locationMap = ServiceLocator.locationRepository.snapshotMap()
        }

        val event = mapOf(
            "type" to "SOS",
            "deviceId" to deviceId,
            "childUid" to ServiceLocator.auth.childUid.value,
            "timestamp" to FieldValue.serverTimestamp(),
            "batteryPercent" to snapshot.batteryPercent,
            "charging" to snapshot.charging,
            "networkType" to snapshot.networkType,
            "location" to locationMap,
            "acknowledged" to false,
        )

        return try {
            firestore.collection("devices").document(deviceId)
                .collection("emergencyEvents")
                .add(event).await()
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_SOS_TRIGGERED,
                result = "event_written",
            )
            showSosConfirmation()
            true
        } catch (e: Exception) {
            // Offline: the SOS must not vanish silently — the parent dashboard
            // will also see the missing heartbeat; retry opportunistically.
            scope.launch {
                delay(30_000)
                runCatching {
                    firestore.collection("devices").document(deviceId)
                        .collection("emergencyEvents").add(event).await()
                }
            }
            false
        }
    }

    /** Parent-initiated safety check: notification + in-app prompt + timeout. */
    fun showSafetyCheckPrompt(commandId: String, parentUid: String) {
        ServiceLocator.appState.showSafetyCheck(commandId)
        ServiceLocator.auditLogger.log(
            actorUid = parentUid,
            action = AuditLogger.ACTION_SAFETY_CHECK_SHOWN,
            result = "commandId=$commandId",
        )

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED || android.os.Build.VERSION.SDK_INT < 33
        ) {
            NotificationChannels.ensureAll(context)
            val open = PendingIntent.getActivity(
                context, 41,
                Intent(context, MainActivity::class.java)
                    .putExtra(EXTRA_COMMAND_ID, commandId)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            nm.notify(
                2005,
                NotificationCompat.Builder(context, NotificationChannels.CHANNEL_SOS)
                    .setSmallIcon(R.drawable.ic_stat_familysafety)
                    .setContentTitle(context.getString(R.string.notif_safety_check_title))
                    .setContentText(context.getString(R.string.notif_safety_check_text))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setFullScreenIntent(open, true)
                    .setAutoCancel(true)
                    .build(),
            )
        }

        // Timeout: if the child never answers, record NO_RESPONSE so the
        // parent knows the check-in wasn't answered (rather than hanging).
        scope.launch {
            delay(SAFETY_CHECK_TIMEOUT_MS)
            if (ServiceLocator.appState.safetyCheckCommandId.value == commandId) {
                ServiceLocator.appState.clearSafetyCheck()
                writeSafetyCheckResult(commandId, "NO_RESPONSE", parentUid)
                // Surface the failed check-in on the parent's EMERGENCY list —
                // without this the dashboard emergency view (fed from
                // emergencyEvents) never shows unanswered safety checks.
                runCatching {
                    firestore.collection("devices").document(ServiceLocator.deviceId)
                        .collection("emergencyEvents")
                        .add(
                            mapOf(
                                "type" to "SAFETY_CHECK_FAIL",
                                "deviceId" to ServiceLocator.deviceId,
                                "childUid" to ServiceLocator.auth.childUid.value,
                                "commandId" to commandId,
                                "timestamp" to FieldValue.serverTimestamp(),
                                "batteryPercent" to ServiceLocator.deviceStatusMonitor.currentSnapshot().batteryPercent,
                                "networkType" to ServiceLocator.deviceStatusMonitor.currentSnapshot().networkType,
                                "acknowledged" to false,
                            )
                        ).await()
                }
            }
        }
    }

    /** Child answered the safety check (called from the UI dialog). */
    fun answerSafetyCheck(commandId: String, response: SafetyCheckResponse, parentUid: String?) {
        ServiceLocator.appState.clearSafetyCheck()
        scope.launch {
            writeSafetyCheckResult(commandId, response.name, parentUid)
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_SAFETY_CHECK_ANSWERED,
                result = response.name,
            )
        }
    }

    private suspend fun writeSafetyCheckResult(commandId: String, result: String, parentUid: String?) {
        runCatching {
            firestore.collection("devices").document(ServiceLocator.deviceId)
                .collection("commandResults").document(commandId)
                .set(
                    mapOf(
                        "commandId" to commandId,
                        "type" to "TRIGGER_SAFETY_CHECK",
                        "status" to "EXECUTED",
                        "message" to "child_response:$result",
                        "issuedBy" to parentUid,
                        "processedAt" to FieldValue.serverTimestamp(),
                    ),
                    com.google.firebase.firestore.SetOptions.merge(),
                ).await()
        }
    }

    private fun showSosConfirmation() {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        NotificationChannels.ensureAll(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(
            2006,
            NotificationCompat.Builder(context, NotificationChannels.CHANNEL_SOS)
                .setSmallIcon(R.drawable.ic_stat_familysafety)
                .setContentTitle(context.getString(R.string.notif_sos_sent_title))
                .setContentText(context.getString(R.string.notif_sos_sent_text))
                .setAutoCancel(true)
                .build(),
        )
    }
}
