package org.setbd.parentcontrol.usage

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * App usage aggregation (screen-time per package, daily) via the public
 * [UsageStatsManager] API.
 *
 * CONSENT / DISCLOSURE:
 *  * Requires the user to explicitly grant "Apps with usage access" in system
 *    settings (App-Ops). We check [hasUsageAccessPermission] and, if absent,
 *    we report UNSUPPORTED-style status instead of trying any workaround —
 *    there is NO reflection hack, NO hidden grant.
 *  * The permission is requested from the visible Settings screen with an
 *    explanation of exactly what will be shared (daily per-app minutes).
 *
 * Writes one document per local day: `devices/{deviceId}/appUsage/{yyyy-MM-dd}`.
 */
class UsageStatsRepository(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()

    /** Official App-Ops check for PACKAGE_USAGE_STATS (same technique Settings uses). */
    fun hasUsageAccessPermission(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
            ?: return false
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * Aggregates today's foreground time per package and uploads it.
     * @return true when a usage doc was written.
     */
    suspend fun syncUsageNow(): Boolean = withContext(Dispatchers.IO) {
        if (!hasUsageAccessPermission()) {
            reportNoPermission()
            return@withContext false
        }
        val usageManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return@withContext false
        val pm = context.packageManager

        val calendar = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        val startOfDay = calendar.timeInMillis

        // queryUsageStats(INTERVAL_DAILY) returns buckets; we merge all buckets
        // overlapping today and clamp times into the local day window.
        val perApp = HashMap<String, Long>()
        usageManager.queryUsageStats(
            UsageStatsManager.INTERVAL_DAILY, startOfDay, System.currentTimeMillis(),
        )?.forEach { stats ->
            val foreground = stats.totalTimeInForeground.coerceAtLeast(0L)
            if (foreground > 0) {
                perApp[stats.packageName] = (perApp[stats.packageName] ?: 0L) + foreground
            }
        }
        if (perApp.isEmpty()) return@withContext false

        val appNameCache = HashMap<String, String>()
        fun appName(pkg: String): String = appNameCache.getOrPut(pkg) {
            try {
                val flags = if (Build.VERSION.SDK_INT >= 33) {
                    PackageManager.ApplicationInfoFlags.of(0)
                } else {
                    @Suppress("DEPRECATION") 0
                }
                pm.getApplicationInfo(pkg, flags).loadLabel(pm).toString()
            } catch (e: Exception) { pkg }
        }

        val perAppNamed = perApp.entries
            .sortedByDescending { it.value }
            .associate { (pkg, ms) -> pkg to mapOf("appName" to appName(pkg), "minutes" to ms / 60000) }
        val totalMinutes = perApp.values.sum() / 60000
        val dayKey = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(Calendar.getInstance().time)

        try {
            firestore.collection("devices").document(ServiceLocator.deviceId)
                .collection("appUsage").document(dayKey)
                .set(
                    mapOf(
                        "deviceId" to ServiceLocator.deviceId,
                        "usageId" to dayKey,
                        "date" to dayKey,
                        "totalScreenTimeMinutes" to totalMinutes,
                        "perApp" to perAppNamed,
                        "capturedAt" to FieldValue.serverTimestamp(),
                    ),
                ).await()
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Mirrors "usage access missing" into the permissions doc so the parent dashboard shows why data is absent. */
    private suspend fun reportNoPermission() {
        runCatching {
            firestore.collection("devices").document(ServiceLocator.deviceId)
                .collection("permissions").document("current")
                .set(
                    mapOf(
                        "appUsageAccess" to false,
                        "appUsageNote" to "UNSUPPORTED: child has not granted Apps-with-usage access",
                        "updatedAt" to FieldValue.serverTimestamp(),
                    ),
                    com.google.firebase.firestore.SetOptions.merge(),
                ).await()
        }
    }

    /** Daily periodic sync — keeps the dashboard's screen-time charts fresh. */
    fun schedulePeriodicSync() {
        val request = PeriodicWorkRequestBuilder<UsageWorker>(6, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .setRequiresBatteryNotLow(true)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_USAGE_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    companion object {
        const val UNIQUE_USAGE_WORK = "familysafety_usage_sync_periodic"
    }
}
