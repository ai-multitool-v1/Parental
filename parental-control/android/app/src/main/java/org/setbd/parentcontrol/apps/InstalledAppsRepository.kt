package org.setbd.parentcontrol.apps

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

/**
 * Installed-apps inventory for the parent dashboard's app overview.
 *
 * Reads ONLY the public PackageManager list (label, package name, version,
 * system/user app, first-install time) — no APK hashing, no signature
 * scraping, no accessibility-based snooping.
 *
 * Writes `devices/{deviceId}/installedApps/{packageName}` documents in
 * Firestore batches (max 450 ops per batch, below the 500 limit).
 */
class InstalledAppsRepository(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()

    data class InstalledApp(
        val packageName: String,
        val appName: String,
        val versionName: String,
        val isSystem: Boolean,
        val firstInstallAtMs: Long,
        val lastUpdateAtMs: Long,
    )

    /** Reads the local inventory (public PackageManager API). */
    fun readInstalledApps(): List<InstalledApp> {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 33) {
            PackageManager.ApplicationInfoFlags.of(0)
        } else {
            @Suppress("DEPRECATION") 0
        }
        return pm.getInstalledApplications(flags).mapNotNull { info ->
            try {
                val versionName = if (Build.VERSION.SDK_INT >= 33) {
                    pm.getPackageInfo(info.packageName, PackageManager.PackageInfoFlags.of(0)).versionName
                } else {
                    @Suppress("DEPRECATION")
                    pm.getPackageInfo(info.packageName, 0).versionName
                }
                InstalledApp(
                    packageName = info.packageName,
                    appName = info.loadLabel(pm).toString(),
                    versionName = versionName ?: "",
                    isSystem = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0,
                    firstInstallAtMs = info.firstInstallTime,
                    lastUpdateAtMs = info.lastUpdateTime,
                )
            } catch (e: Exception) {
                null // Package vanished mid-scan — skip it.
            }
        }
    }

    /** Full inventory sync (chunked batched writes). */
    suspend fun syncInstalledApps(): Int = withContext(Dispatchers.IO) {
        val apps = readInstalledApps()
        val deviceRef = firestore.collection("devices").document(ServiceLocator.deviceId)
        var written = 0

        apps.chunked(BATCH_SIZE).forEach { chunk ->
            try {
                firestore.runBatch { batch ->
                    chunk.forEach { app ->
                        batch.set(
                            deviceRef.collection("installedApps").document(app.packageName),
                            mapOf(
                                "appName" to app.appName,
                                "packageName" to app.packageName,
                                "versionName" to app.versionName,
                                "isSystem" to app.isSystem,
                                "installedAt" to app.firstInstallAtMs,
                                "updatedAt" to app.lastUpdateAtMs,
                                "syncedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                            ),
                            SetOptions.merge(),
                        )
                    }
                }.await()
                written += chunk.size
            } catch (e: Exception) {
                // Keep trying subsequent chunks; partial sync beats none.
            }
        }

        // Refresh the summary pointer used by the dashboard.
        runCatching {
            deviceRef.collection("installedApps").document("_summary").set(
                mapOf(
                    "count" to apps.size,
                    "syncedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                ),
                SetOptions.merge(),
            ).await()
        }
        written
    }

    private companion object { const val BATCH_SIZE = 400 }
}
