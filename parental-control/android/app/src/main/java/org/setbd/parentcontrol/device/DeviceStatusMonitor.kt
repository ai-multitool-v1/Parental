package org.setbd.parentcontrol.device

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.setbd.parentcontrol.BuildConfig
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** One heartbeat snapshot of the device's own health. */
data class DeviceSnapshot(
    val batteryPercent: Int,
    val charging: Boolean,
    val networkType: String,          // "wifi" | "mobile" | "offline"
    val androidVersion: String = Build.VERSION.RELEASE,
    val appVersion: String = BuildConfig.VERSION_NAME,
    val timestampMs: Long = System.currentTimeMillis(),
)

/**
 * Collects and publishes the device's own status (battery %, charging state,
 * network type, OS/app versions) — the "device status card" the parent sees.
 *
 * Publishing paths:
 *  * [schedulePeriodicHeartbeat] — WorkManager periodic job (15 min floor,
 *    Android's minimum), resilient across reboots & battery optimizations.
 *  * [runHeartbeatNow] — triggered by an FCM data ping (REQUEST_STATUS) for a
 *    fast refresh when the parent opens the dashboard.
 *
 * The heartbeat NEVER reads sensors, microphone or camera; it is purely
 * battery/network/version telemetry explicitly disclosed in the child UI.
 */
class DeviceStatusMonitor(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()

    /** Reads the current snapshot without any side effects. */
    fun currentSnapshot(): DeviceSnapshot {
        val battery = batteryStatus()
        return DeviceSnapshot(
            batteryPercent = battery.first,
            charging = battery.second,
            networkType = networkType(),
        )
    }

    /** Battery percent + charging flag from the sticky BATTERY_CHANGED intent. */
    private fun batteryStatus(): Pair<Int, Boolean> {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) (level * 100) / scale else -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        return pct to charging
    }

    /** Network classification via public ConnectivityManager APIs only. */
    fun networkType(): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return "offline"
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "offline"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            else -> "offline"
        }
    }

    /**
     * Publishes the heartbeat to `devices/{deviceId}/status/current` and
     * refreshes `lastSeenAt` on the device doc. Safe to call concurrently.
     */
    suspend fun runHeartbeatNow(reason: String) = withContext(Dispatchers.IO) {
        val deviceId = ServiceLocator.deviceId
        val snap = currentSnapshot()
        ServiceLocator.appState.setConnected(snap.networkType != "offline")
        try {
            firestore.collection("devices").document(deviceId)
                .collection("status").document("current")
                .set(
                    mapOf(
                        "deviceId" to deviceId,
                        "batteryPercent" to snap.batteryPercent,
                        "charging" to snap.charging,
                        "networkType" to snap.networkType,
                        "androidVersion" to snap.androidVersion,
                        "appVersion" to snap.appVersion,
                        "reason" to reason,
                        "updatedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                    ),
                    SetOptions.merge(),
                ).await()
            firestore.collection("devices").document(deviceId)
                .set(mapOf("lastSeenAt" to com.google.firebase.firestore.FieldValue.serverTimestamp()), SetOptions.merge())
                .await()
        } catch (e: Exception) {
            // Offline: WorkManager backoff will retry; UI mirrors offline state.
            ServiceLocator.appState.setConnected(false)
        }
    }

    /** Periodic 15-min heartbeat (WorkManager minimum interval) with network constraint. */
    fun schedulePeriodicHeartbeat() {
        val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_HEARTBEAT_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** Immediate one-shot (FCM ping / app open / parent REQUEST_STATUS). */
    fun enqueueImmediateHeartbeat() {
        val request = OneTimeWorkRequestBuilder<HeartbeatWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_HEARTBEAT_ONESHOT,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    companion object {
        const val UNIQUE_HEARTBEAT_WORK = "familysafety_heartbeat_periodic"
        const val UNIQUE_HEARTBEAT_ONESHOT = "familysafety_heartbeat_oneshot"
    }
}
