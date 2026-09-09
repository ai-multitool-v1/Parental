package org.setbd.parentcontrol.backup

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * BackupScheduler — WorkManager topology for the backup pipeline.
 *
 *  PERIODIC (12 h): BackupScanWorker + BackupUploadWorker with a CONNECTED
 *  constraint and exponential backoff — the safety net that catches anything
 *  the event-driven path missed and, critically, the RECOVERY path after
 *  app restart / process death (requirement 13): PENDING items live in
 *  Firestore, so the next worker run simply finds them again.
 *
 *  EVENT-DRIVEN (one-shot, expedited where allowed): triggered by
 *   - MediaStoreObserver (new photo/video/album change, debounced 5 s),
 *   - ContactsObserver (added/modified contact, debounced 5 s),
 *   - policy flips (BackupPolicyRepository → requestReconcile),
 *   - BootReceiver (reschedules periodics only — never captures anything).
 *
 *  All work is UNIQUE-named (KEEP policy) so observers cannot pile up jobs.
 */
object BackupScheduler {

    private val networkConstraint = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /** Idempotent periodic scheduling (called from onPaired / BootReceiver). */
    fun ensurePeriodic(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(
            BackupScanWorker.UNIQUE_PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<BackupScanWorker>(12, TimeUnit.HOURS)
                .setConstraints(networkConstraint)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        )
        wm.enqueueUniquePeriodicWork(
            BackupUploadWorker.UNIQUE_PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<BackupUploadWorker>(12, TimeUnit.HOURS)
                .setConstraints(networkConstraint)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        )
    }

    /**
     * Scan + upload pass (policy flip, observer burst, manual re-check).
     * APPEND keeps an already-running pass alive instead of restarting it.
     */
    fun requestReconcile(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniqueWork(
            BackupScanWorker.UNIQUE_ONESHOT,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<BackupScanWorker>().build()
        )
        wm.enqueueUniqueWork(
            BackupUploadWorker.UNIQUE_ONESHOT,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<BackupUploadWorker>()
                .setConstraints(networkConstraint)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
        )
    }

    /** Upload-only nudge (resume after re-enable / retry). */
    fun requestUpload(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            BackupUploadWorker.UNIQUE_ONESHOT,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<BackupUploadWorker>()
                .setConstraints(networkConstraint)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
        )
    }

    /** Stops periodic work (policy fully disabled or unpaired). */
    fun cancelAll(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(BackupScanWorker.UNIQUE_PERIODIC)
        wm.cancelUniqueWork(BackupUploadWorker.UNIQUE_PERIODIC)
        wm.cancelUniqueWork(BackupScanWorker.UNIQUE_ONESHOT)
        wm.cancelUniqueWork(BackupUploadWorker.UNIQUE_ONESHOT)
    }
}

/**
 * MediaStoreObserver — ContentObserver on the external images/videos and
 * contacts collections. Observers only MARK "something changed" and hand
 * off to WorkManager (debounced): the actual scan re-checks every gate
 * (policy + consent + permission) and re-reads content through the normal
 * provider APIs. No content is captured here.
 *
 * Registered only while the device is paired AND at least one category is
 * enabled+consented; unregistered otherwise (graceful stop on revoke).
 */
class MediaStoreObserver(private val context: Context) {

    private var registered = false
    private val handler = Handler(Looper.getMainLooper())
    private var debounce: Runnable? = null

    private val mediaUris = listOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
    )
    private val contactsUri = ContactsContract.Contacts.CONTENT_URI

    private val observer = object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean, uri: Uri?) {
            // Debounce bursts (camera apps fire several changes per capture).
            debounce?.let { handler.removeCallbacks(it) }
            debounce = Runnable { BackupScheduler.requestReconcile(context) }
                .also { handler.postDelayed(it, 5_000) }
        }
    }

    fun start() {
        if (registered) return
        try {
            val cr = context.contentResolver
            (mediaUris + contactsUri).forEach { cr.registerContentObserver(it, true, observer) }
            registered = true
        } catch (_: SecurityException) {
            // Observers for contacts require no permission to REGISTER, but
            // some OEMs throw when the app lacks any read grant — stay off
            // and rely on the periodic reconcile instead. Graceful degrade.
            registered = false
        }
    }

    fun stop() {
        if (!registered) return
        runCatching { context.contentResolver.unregisterContentObserver(observer) }
        registered = false
    }
}
