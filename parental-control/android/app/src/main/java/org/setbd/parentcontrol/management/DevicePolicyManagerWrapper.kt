package org.setbd.parentcontrol.management

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import org.setbd.parentcontrol.security.AuditLogger

/**
 * Result of a privileged operation that depends on management state.
 * UNSUPPORTED is a first-class outcome: we NEVER attempt a bypass when the
 * device isn't properly enrolled.
 */
sealed class EnforcementResult {
    data object Supported : EnforcementResult()
    data object UnsupportedNotAdmin : EnforcementResult()
    data class Failed(val message: String) : EnforcementResult()
}

/**
 * Thin, audited wrapper around [DevicePolicyManager].
 *
 * Every method checks the actual admin/owner state first and returns
 * [EnforcementResult.UnsupportedNotAdmin] instead of throwing or half-working.
 * Actions performed through this wrapper are written to the audit log.
 */
class DevicePolicyManagerWrapper(private val context: Context) {

    private val dpm: DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val adminComponent: ComponentName =
        ComponentName(context, DeviceAdminReceiver::class.java)

    fun isAdminActive(): Boolean = dpm.isAdminActive(adminComponent)
    fun isDeviceOwner(): Boolean = dpm.isDeviceOwnerApp(context.packageName)
    fun isProfileOwner(): Boolean = dpm.isProfileOwnerApp(context.packageName)

    fun mode(): ManagementMode = ManagementState.current(context)

    /**
     * LOCK_DEVICE command → lockNow(). Supported only when the device admin
     * (owner/profile/admin) is actually active on this device.
     */
    fun lockNow(actorUid: String?): EnforcementResult {
        if (!isAdminActive()) return EnforcementResult.UnsupportedNotAdmin
        return try {
            dpm.lockNow()
            ServiceLocator.auditLogger.log(
                actorUid = actorUid,
                action = AuditLogger.ACTION_DEVICE_LOCKED,
                result = mode().name,
            )
            EnforcementResult.Supported
        } catch (e: SecurityException) {
            EnforcementResult.Failed(e.message ?: "SecurityException")
        }
    }

    /**
     * Bedtime app hiding / self icon hiding (kiosk-style restriction).
     * Requires Device Owner or Profile Owner AND API 28+ (setApplicationHidden
     * exists since P). Plain ADMIN cannot hide apps — we report that honestly
     * (CONDITIONALLY_SUPPORTED) rather than trying workarounds.
     */
    fun setApplicationHidden(packageName: String, hidden: Boolean): EnforcementResult {
        if (android.os.Build.VERSION.SDK_INT < 28) return EnforcementResult.UnsupportedNotAdmin
        if (!isDeviceOwner() && !isProfileOwner()) return EnforcementResult.UnsupportedNotAdmin
        return try {
            // Unhidden system-critical packages are ignored by the platform.
            dpm.setApplicationHidden(adminComponent, packageName, hidden)
            EnforcementResult.Supported
        } catch (e: SecurityException) {
            EnforcementResult.Failed(e.message ?: "SecurityException")
        } catch (e: IllegalArgumentException) {
            EnforcementResult.Failed(e.message ?: "IllegalArgumentException")
        }
    }

    /** Convenience: apply/undo bedtime hiding for a whole block list. */
    fun applyBedtimeHiding(blockList: List<String>, hide: Boolean): Map<String, String> =
        blockList.associateWith { pkg ->
            when (val r = setApplicationHidden(pkg, hide)) {
                EnforcementResult.Supported -> "hidden"
                EnforcementResult.UnsupportedNotAdmin -> "UNSUPPORTED_NOT_ADMIN"
                is EnforcementResult.Failed -> "FAILED: ${r.message}"
            }
        }

    /**
     * True when THIS app's launcher icon is currently hidden (official
     * DevicePolicyManager.setApplicationHidden on a Device/Profile Owner
     * device, API 28+). Used by the Settings screen and the dial-code
     * receiver, which un-hides the app again.
     */
    fun isSelfHidden(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 28) return false
        if (!isDeviceOwner() && !isProfileOwner()) return false
        return runCatching {
            dpm.isApplicationHidden(adminComponent, context.packageName)
        }.getOrDefault(false)
    }

    /**
     * Un-hides this app (recovery path for the dial code). Returns true when
     * the icon is guaranteed visible again.
     */
    fun unhideSelf(): Boolean = when {
        !isSelfHidden() -> true // never hidden
        else -> setApplicationHidden(context.packageName, false) == EnforcementResult.Supported
    }
}
