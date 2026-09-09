package org.setbd.parentcontrol.reliability

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Reliability helpers — everything here is a USER-INITIATED, visible request
 * launched from the Settings screen. There is no silent prompting and no
 * auto-grant anywhere in this app.
 */
object ReliabilityHelper {

    // ------------------------------------------------------------ battery ----

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        // PowerManager.isIgnoringBatteryOptimizations exists since API 23.
        if (Build.VERSION.SDK_INT < 23) return false
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Opens the system dialog asking the user to exempt the app from battery
     * optimization (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS requires the
     * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission declared in the
     * manifest). Called only when the child/parent taps the Settings control.
     *
     * WHY: WorkManager heartbeats and bedtime alarms get throttled hard on
     * aggressive OEMs; an explicit, user-approved exemption keeps the
     * consented monitoring features reliable.
     */
    fun requestIgnoreBatteryOptimizations(context: Context) {
        if (isIgnoringBatteryOptimizations(context)) return
        try {
            context.startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Exception) {
            // OEM removed the action: fall back to the general battery list.
            runCatching {
                context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }
    }

    // ------------------------------------------------- OEM-specific guidance --

    /**
     * Known aggressive OEMs whose extra battery settings can silently kill
     * the heartbeat / bedtime schedules. We surface a plain-language hint on
     * the Settings screen instead of trying to fight them in the background.
     */
    fun manufacturerHint(): String? {
        val manufacturer = Build.MANUFACTURER.lowercase()
        return when {
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco") ->
                "Xiaomi/Redmi: enable Autostart and set Battery saver to \"No restrictions\" for Family Safety."
            manufacturer.contains("huawei") || manufacturer.contains("honor") ->
                "Huawei/Honor: enable \"Launch in background\" and disable \"Close apps when screen is locked\" for Family Safety."
            manufacturer.contains("oppo") || manufacturer.contains("realme") ->
                "OPPO/realme: enable \"Allow Auto-launch\" and \"Allow background activity\" for Family Safety."
            manufacturer.contains("vivo") ->
                "vivo: enable \"High background power consumption\" for Family Safety."
            manufacturer.contains("samsung") ->
                "Samsung: remove Family Safety from \"Sleeping apps\" (Battery → Background usage limits)."
            else -> null
        }
    }

    // -------------------------------------------------------- notifications --

    /** True when POST_NOTIFICATIONS is granted (always true below Android 13). */
    fun hasNotificationPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    /**
     * Launches the system POST_NOTIFICATIONS request (Android 13+). Must be
     * called from an Activity context with a visible UI — we do it from the
     * onboarding flow where the purpose is explained first.
     */
    fun requestNotificationPermission(activity: android.app.Activity) {
        if (Build.VERSION.SDK_INT >= 33) {
            activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    /** Opens the app's system settings page (used from "permission needed" prompts). */
    fun openAppSettings(context: Context) {
        context.startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
