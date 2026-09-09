package org.setbd.parentcontrol.device

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.setbd.parentcontrol.di.ServiceLocator

/**
 * WorkManager job that publishes one device-status heartbeat.
 *
 * WHY WorkManager (and not a persistent service): a heartbeat is a short
 * deferrable task — WorkManager survives reboots (via [org.setbd.parentcontrol.reliability.BootReceiver]),
 * respects Doze, and avoids keeping any foreground service alive, which keeps
 * the child device calm and battery-friendly.
 */
class HeartbeatWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        return try {
            ServiceLocator.deviceStatusMonitor.runHeartbeatNow(reason = inputData.reason("periodic"))
            Result.success()
        } catch (t: Throwable) {
            if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
        }
    }

    private fun androidx.work.Data.reason(default: String): String = getString(KEY_REASON) ?: default

    companion object {
        const val KEY_REASON = "reason"
        private const val MAX_RETRIES = 5
    }
}
