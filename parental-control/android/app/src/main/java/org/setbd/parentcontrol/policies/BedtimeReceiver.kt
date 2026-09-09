package org.setbd.parentcontrol.policies

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.notifications.NotificationChannels
import org.setbd.parentcontrol.security.AuditLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * Bedtime schedule enforcement.
 *
 * SUPPORTED MEANS ONLY (no accessibility abuse, no root, no hidden tricks):
 *  1. AlarmManager (exact when the system allows; inexact + WorkManager
 *     fallback otherwise — see [BedtimeScheduler]).
 *  2. Device Owner / Profile Owner: hide blocked apps for the window via
 *     [org.setbd.parentcontrol.management.DevicePolicyManagerWrapper].
 *  3. Otherwise: a visible high-priority "bedtime" notification with a
 *     full-screen intent to the in-app bedtime screen.
 *  4. If nothing can be applied (e.g. no notification permission), we report
 *     `UNSUPPORTED` in the device status + audit log — never a bypass.
 */
class BedtimeReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val policy = ServiceLocator.policyRepository.currentPolicy() ?: return
        if (policy.bedtime == null) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                when (intent.action) {
                    ACTION_BEDTIME_START -> BedtimeEnforcement.start(context, policy)
                    ACTION_BEDTIME_END -> BedtimeEnforcement.end(context, policy)
                }
                // Always re-arm the next transition.
                BedtimeScheduler.scheduleNext(context, policy)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_BEDTIME_START = "org.setbd.parentcontrol.action.BEDTIME_START"
        const val ACTION_BEDTIME_END = "org.setbd.parentcontrol.action.BEDTIME_END"
        const val NOTIF_BEDTIME_ID = 2001
    }
}

/** Shared enforcement logic used by both the receiver and the fallback worker. */
internal object BedtimeEnforcement {

    /** Entering the bedtime window. */
    suspend fun start(context: Context, policy: Policy) {
        ServiceLocator.appState.setBedtimeActive(true)
        val blocked = blockedPackages(policy)

        val enforcement = when (ServiceLocator.devicePolicyWrapper.mode()) {
            org.setbd.parentcontrol.management.ManagementMode.DEVICE_OWNER,
            org.setbd.parentcontrol.management.ManagementMode.PROFILE_OWNER,
            -> {
                val hidden = ServiceLocator.devicePolicyWrapper.applyBedtimeHiding(blocked, hide = true)
                "hiddenApps=${hidden.count { it.value == "hidden" }}/${hidden.size}"
            }
            else -> {
                if (showBedtimeNotification(context)) "visibleNotification" else "UNSUPPORTED"
            }
        }

        reportStatus(if (enforcement == "UNSUPPORTED") "UNSUPPORTED" else "on:$enforcement")
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_BEDTIME_STARTED,
            result = enforcement,
        )
    }

    /** Leaving the bedtime window: undo restrictions. */
    suspend fun end(context: Context, policy: Policy) {
        ServiceLocator.appState.setBedtimeActive(false)
        val blocked = blockedPackages(policy)
        when (ServiceLocator.devicePolicyWrapper.mode()) {
            org.setbd.parentcontrol.management.ManagementMode.DEVICE_OWNER,
            org.setbd.parentcontrol.management.ManagementMode.PROFILE_OWNER,
            -> ServiceLocator.devicePolicyWrapper.applyBedtimeHiding(blocked, hide = false)
            else -> Unit
        }
        reportStatus("off")
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_BEDTIME_ENDED,
            result = "restrictions_removed",
        )
    }

    private fun blockedPackages(policy: Policy): List<String> =
        policy.bedtime?.let { b -> policy.appBlockList.filterNot { it in b.allowedPackages } }
            ?: policy.appBlockList

    /**
     * Visible bedtime indicator — the supported "overlay" when the device is
     * not device-owner. Returns false when notifications are not permitted,
     * which the caller reports as UNSUPPORTED.
     */
    private fun showBedtimeNotification(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        NotificationChannels.ensureAll(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        val fullScreen = PendingIntent.getActivity(
            context, 101,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_BEDTIME_ACTIVE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_SOS)
            .setSmallIcon(R.drawable.ic_stat_familysafety)
            .setContentTitle(context.getString(R.string.notif_bedtime_title))
            .setContentText(context.getString(R.string.notif_bedtime_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setFullScreenIntent(fullScreen, true)
            .setOngoing(true)
            .build()
        nm.notify(BedtimeReceiver.NOTIF_BEDTIME_ID, notification)
        return true
    }

    private suspend fun reportStatus(enforcement: String) {
        runCatching {
            com.google.firebase.firestore.FirebaseFirestore.getInstance()
                .collection("devices").document(ServiceLocator.deviceId)
                .collection("status").document("current")
                .set(
                    mapOf(
                        "bedtimeEnforcement" to enforcement,
                        "updatedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                    ),
                    com.google.firebase.firestore.SetOptions.merge(),
                ).await()
        }
    }
}

// ============================================================================
// Scheduling helpers
// ============================================================================

/**
 * Arms the next bedtime START/END transitions:
 *  * exact alarms when the system grants `canScheduleExactAlarms()`,
 *  * inexact `setAndAllowWhileIdle` otherwise (never a SecurityException,
 *    never a bypass),
 *  * plus a WorkManager one-time fallback job as a second line of defense.
 */
object BedtimeScheduler {

    private val hm: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    fun scheduleNext(context: Context, policy: Policy?) {
        val bedtime = policy?.bedtime
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (bedtime == null) {
            cancel(context)
            return
        }
        val startAt = nextStart(bedtime)
        val endAt = nextEnd(bedtime)
        arm(context, am, startAt, BedtimeReceiver.ACTION_BEDTIME_START, BedtimeScheduler.REQ_START)
        arm(context, am, endAt, BedtimeReceiver.ACTION_BEDTIME_END, BedtimeScheduler.REQ_END)
        enqueueWorkManagerFallback(context, startAt, BedtimeReceiver.ACTION_BEDTIME_START)
        enqueueWorkManagerFallback(context, endAt, BedtimeReceiver.ACTION_BEDTIME_END)
    }

    fun cancel(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        listOf(
            REQ_START to BedtimeReceiver.ACTION_BEDTIME_START,
            REQ_END to BedtimeReceiver.ACTION_BEDTIME_END,
        ).forEach { (req, action) -> am.cancel(pendingBroadcast(context, action, req)) }
    }

    /** True when the current wall-clock sits inside the (possibly overnight) window. */
    fun isInBedtimeWindowNow(policy: Policy): Boolean {
        val b = policy.bedtime ?: return false
        val now = LocalDateTime.now()
        val start = LocalTime.parse(b.start, hm)
        val end = LocalTime.parse(b.end, hm)
        val today = now.toLocalDate()
        val todayIso = today.dayOfWeek.value // 1=Mon..7=Sun

        return if (!start.isAfter(end)) {
            todayIso in b.days && now.toLocalTime() >= start && now.toLocalTime() < end
        } else {
            // Overnight window (e.g. 21:30 -> 07:00).
            (todayIso in b.days && now.toLocalTime() >= start) ||
                (today.minusDays(1).dayOfWeek.value in b.days && now.toLocalTime() < end)
        }
    }

    /** Next datetime at `time` on an enabled ISO day (searches 8 days ahead). */
    private fun nextAt(b: BedtimePolicy, time: LocalTime): LocalDateTime {
        var candidate = LocalDateTime.of(LocalDate.now(), time)
        repeat(8) {
            if (candidate.dayOfWeek.value in b.days && candidate.isAfter(LocalDateTime.now())) return candidate
            candidate = candidate.plusDays(1)
        }
        return candidate.plusDays(1)
    }

    private fun nextStart(b: BedtimePolicy): LocalDateTime = nextAt(b, LocalTime.parse(b.start, hm))

    /** End lands the morning after an enabled start day for overnight windows. */
    private fun nextEnd(b: BedtimePolicy): LocalDateTime {
        val end = LocalTime.parse(b.end, hm)
        var candidate = LocalDateTime.of(LocalDate.now(), end)
        repeat(8) {
            val windowStartDay = if (LocalTime.parse(b.start, hm).isAfter(end)) {
                candidate.minusDays(1).dayOfWeek.value
            } else {
                candidate.dayOfWeek.value
            }
            if (candidate.isAfter(LocalDateTime.now()) && windowStartDay in b.days) return candidate
            candidate = candidate.plusDays(1)
        }
        return candidate
    }

    private fun arm(context: Context, am: AlarmManager, at: LocalDateTime, action: String, requestCode: Int) {
        val epochMs = at.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val pi = pendingBroadcast(context, action, requestCode)
        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                // User withheld exact-alarm permission: fall back to inexact.
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, pi)
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, pi)
            }
        } catch (se: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, pi)
        }
    }

    private fun enqueueWorkManagerFallback(context: Context, at: LocalDateTime, action: String) {
        val delayMs = ChronoUnit.MILLIS.between(LocalDateTime.now(), at).coerceAtLeast(0)
        val request = OneTimeWorkRequestBuilder<BedtimeWorker>()
            .setInitialDelay(delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            .setInputData(androidx.work.Data.Builder().putString(KEY_ACTION, action).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "familysafety_bedtime_fallback_$action",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    private fun pendingBroadcast(context: Context, action: String, requestCode: Int): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, BedtimeReceiver::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    const val KEY_ACTION = "action"
    const val REQ_START = 3001
    const val REQ_END = 3002
}

/**
 * WorkManager fallback for the bedtime alarms: runs near the transition time
 * and applies it if the alarm was dropped (Doze, aggressive OEM killers).
 */
class BedtimeWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val policy = ServiceLocator.policyRepository.currentPolicy() ?: return Result.success()
        when {
            inputData.getString(BedtimeScheduler.KEY_ACTION) == BedtimeReceiver.ACTION_BEDTIME_END ->
                BedtimeEnforcement.end(applicationContext, policy)
            BedtimeScheduler.isInBedtimeWindowNow(policy) ->
                BedtimeEnforcement.start(applicationContext, policy)
        }
        BedtimeScheduler.scheduleNext(applicationContext, policy)
        return Result.success()
    }
}
