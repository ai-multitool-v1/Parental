package org.setbd.parentcontrol.management

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context

/**
 * Reports the device's management mode using ONLY public DevicePolicyManager
 * queries.
 *
 *  * DEVICE_OWNER  — fully managed device (e.g. provisioned by `adb dpm
 *    set-device-owner` during setup, or managed Google Play enrollment).
 *    Enables remote LOCK_DEVICE and app-visibility enforcement.
 *  * PROFILE_OWNER — work-profile managed device; same APIs, profile scope.
 *  * ADMIN         — classic device admin activated by the user through the
 *    visible system dialog; supports lockNow() only.
 *  * NONE          — unmanaged; enforcement features report UNSUPPORTED
 *    (never silently attempted).
 *
 * SAFETY: nothing in this app provisions device-owner silently. Enrollment
 * happens exclusively via standard, user-visible flows (QR/adb/managed Play).
 */
enum class ManagementMode { DEVICE_OWNER, PROFILE_OWNER, ADMIN, NONE }

object ManagementState {

    /** Cheap on-demand probe of the current management mode. */
    fun current(context: Context): ManagementMode {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return ManagementMode.NONE
        val admin = ComponentName(context, DeviceAdminReceiver::class.java)
        return when {
            dpm.isDeviceOwnerApp(context.packageName) -> ManagementMode.DEVICE_OWNER
            dpm.isProfileOwnerApp(context.packageName) -> ManagementMode.PROFILE_OWNER
            dpm.isAdminActive(admin) -> ManagementMode.ADMIN
            else -> ManagementMode.NONE
        }
    }

    /** Human-readable summary for the Settings screen / permission dashboard. */
    fun describe(mode: ManagementMode): String = when (mode) {
        ManagementMode.DEVICE_OWNER -> "Device Owner"
        ManagementMode.PROFILE_OWNER -> "Profile Owner"
        ManagementMode.ADMIN -> "Device Admin"
        ManagementMode.NONE -> "Not managed"
    }
}
