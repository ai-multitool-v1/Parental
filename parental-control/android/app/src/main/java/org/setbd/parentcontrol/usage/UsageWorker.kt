package org.setbd.parentcontrol.usage

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.setbd.parentcontrol.di.ServiceLocator

/**
 * Periodic usage-sync job (see [org.setbd.parentcontrol.usage.UsageStatsRepository.schedulePeriodicSync]).
 * Also re-runs after reboot via the BootReceiver's WorkManager rescheduling.
 */
class UsageWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = try {
        ServiceLocator.usageStatsRepository.syncUsageNow()
        Result.success()
    } catch (t: Throwable) {
        if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
}
