package org.setbd.parentcontrol.security

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.BuildConfig
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

/**
 * Permission transparency reporter for the parent's "Permission Dashboard".
 *
 * Publishes the app's own runtime-permission state to
 * `devices/{deviceId}/permissions/current`. WHY: in a consent-based product
 * the parent should see what the child has (and hasn't) allowed, instead of
 * discovering gaps through missing data. This reads only OUR app's
 * permissions — never the device's global state.
 */
class PermissionReporter(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** Builds the current snapshot. Pure read; safe anywhere. */
    fun snapshot(): Map<String, Any?> {
        val usageAccess = org.setbd.parentcontrol.usage.UsageStatsRepository(context)
            .let { runCatching { it.hasUsageAccessPermission() }.getOrDefault(false) }
        val managementMode = org.setbd.parentcontrol.management.ManagementState.current(context)
        return mapOf(
            "locationFine" to granted(Manifest.permission.ACCESS_FINE_LOCATION),
            "locationCoarse" to granted(Manifest.permission.ACCESS_COARSE_LOCATION),
            "locationBackground" to granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
            "notifications" to (Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS)),
            "camera" to granted(Manifest.permission.CAMERA),
            "microphone" to granted(Manifest.permission.RECORD_AUDIO),
            "appUsageAccess" to usageAccess,
            "batteryOptimizationIgnored" to
                org.setbd.parentcontrol.reliability.ReliabilityHelper.isIgnoringBatteryOptimizations(context),
            "accessibilityService" to
                org.setbd.parentcontrol.policies.AppGuardAccessibilityService.isEnabled(context),
            "deviceAdmin" to (managementMode != org.setbd.parentcontrol.management.ManagementMode.NONE),
            "deviceOwner" to (
                managementMode == org.setbd.parentcontrol.management.ManagementMode.DEVICE_OWNER ||
                    managementMode == org.setbd.parentcontrol.management.ManagementMode.PROFILE_OWNER
                ),
            "appIconHidden" to ServiceLocator.devicePolicyWrapper.isSelfHidden(),
            "secureStorage" to ServiceLocator.secureStore.storageKind(),
            "managementMode" to managementMode.name,
            // v1.3.0 — backup module permission states (consent dashboard).
            "backupReadMediaImages" to (
                Build.VERSION.SDK_INT >= 33 && granted(Manifest.permission.READ_MEDIA_IMAGES)
                    || Build.VERSION.SDK_INT < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE)
                ),
            "backupReadMediaVideos" to (
                Build.VERSION.SDK_INT >= 33 && granted(Manifest.permission.READ_MEDIA_VIDEO)
                    || Build.VERSION.SDK_INT < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE)
                ),
            "backupReadContacts" to granted(Manifest.permission.READ_CONTACTS),
            "backupWriteContacts" to granted(Manifest.permission.WRITE_CONTACTS),
            // READ_SMS is a restricted permission: false is the HONEST state
            // for most installations (Play policy) — the dashboard shows the
            // SMS backup module as unavailable rather than silently absent.
            "backupReadSms" to granted(Manifest.permission.READ_SMS),
            "androidVersion" to Build.VERSION.RELEASE,
            "androidSdkInt" to Build.VERSION.SDK_INT,
            "appVersion" to BuildConfig.VERSION_NAME,
            "updatedAt" to FieldValue.serverTimestamp(),
        )
    }

    /** Uploads the snapshot (fire-and-forget from UI/app start). */
    suspend fun report() = withContext(Dispatchers.IO) {
        runCatching {
            firestore.collection("devices").document(ServiceLocator.deviceId)
                .collection("permissions").document("current")
                .set(snapshot(), SetOptions.merge())
                .await()
        }
    }
}
