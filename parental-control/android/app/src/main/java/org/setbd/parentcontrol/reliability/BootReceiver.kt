package org.setbd.parentcontrol.reliability

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger

/**
 * BOOT_COMPLETED / MY_PACKAGE_REPLACED receiver.
 *
 * SAFETY CONTRACT: this receiver ONLY re-schedules WorkManager periodic jobs
 * (heartbeat + usage sync) that the user has already opted into by pairing.
 *
 * It NEVER:
 *  * starts the camera / microphone / screen-capture foreground services
 *    (those require a fresh, visible consent flow in the foreground),
 *  * performs any network call other than what WorkManager schedules,
 *  * bypasses background-start restrictions.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        // Only continue for an actually-paired device; a factory-reset or
        // unpaired install has nothing to reschedule.
        if (!ServiceLocator.secureStore.isPaired()) return

        // Re-arm periodic WorkManager jobs (idempotent: KEEP policy).
        ServiceLocator.deviceStatusMonitor.schedulePeriodicHeartbeat()
        ServiceLocator.usageStatsRepository.schedulePeriodicSync()

        // v1.3.0 — re-arm the backup periodic workers. Boot NEVER starts a
        // scan/capture directly; the workers themselves re-check the full
        // triple gate (policy + consent + permission) before touching any
        // content, so this is purely job scheduling.
        org.setbd.parentcontrol.backup.BackupScheduler.ensurePeriodic(context)

        // Re-arm the bedtime schedule from the cached offline policy.
        ServiceLocator.policyRepository.currentPolicy()?.let {
            org.setbd.parentcontrol.policies.BedtimeScheduler.scheduleNext(context, it)
        }

        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_JOBS_RESCHEDULED,
            result = action,
        )
    }
}
