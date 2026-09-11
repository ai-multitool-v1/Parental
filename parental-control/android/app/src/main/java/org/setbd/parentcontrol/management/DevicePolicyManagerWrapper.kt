package org.setbd.parentcontrol.management

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import org.setbd.parentcontrol.di.ServiceLocator
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

    /**
     * Launcher activity-alias (`.MainLauncher`) — disabling this component
     * hides the launcher icon on ANY device, no admin/owner enrollment
     * needed. Dial codes keep working: the SecretCode receivers are separate
     * components and MainActivity is still launchable by explicit intent.
     */
    private val launcherAlias: ComponentName =
        ComponentName(context, "${context.packageName}.MainLauncher")

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
     * True when THIS app's launcher icon is currently hidden — either via the
     * official DevicePolicyManager.setApplicationHidden (Device/Profile Owner,
     * API 28+) OR via the launcher activity-alias component (any device).
     * Used by the Settings screen and the dial-code receiver, which un-hides
     * the app again.
     */
    fun isSelfHidden(): Boolean {
        if (isLauncherAliasHidden()) return true
        if (android.os.Build.VERSION.SDK_INT < 28) return false
        if (!isDeviceOwner() && !isProfileOwner()) return false
        return runCatching {
            dpm.isApplicationHidden(adminComponent, context.packageName)
        }.getOrDefault(false)
    }

    /**
     * Launcher-alias icon hiding — works on every Android device (API 15+),
     * no special enrollment. This is the fallback for non-owner devices.
     */
    fun setLauncherAliasHidden(hidden: Boolean): Boolean = try {
        context.packageManager.setComponentEnabledSetting(
            launcherAlias,
            if (hidden) android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            else android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
            android.content.pm.PackageManager.DONT_KILL_APP,
        )
        true
    } catch (e: Exception) {
        false
    }

    fun isLauncherAliasHidden(): Boolean = runCatching {
        context.packageManager.getComponentEnabledSetting(launcherAlias) ==
            android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED
    }.getOrDefault(false)

    /**
     * Hide/unhide THIS app's launcher icon — works on EVERY device, no
     * owner enrollment required.
     *
     * ⚠️ Deliberately uses the launcher-alias path INSTEAD of
     * dpm.setApplicationHidden for SELF-hiding: a DPM-hidden app's
     * components (incl. SecretCodeReceiver) stop receiving broadcasts on
     * many Android builds, which permanently locked children out. With the
     * alias approach the app keeps running and *#*#1111#*#* still unhides.
     */
    fun setSelfHidden(hidden: Boolean): Boolean = setLauncherAliasHidden(hidden)

    /**
     * Un-hides this app (recovery path for the dial code). Returns true when
     * the icon is guaranteed visible again.
     */
    fun unhideSelf(): Boolean {
        if (isLauncherAliasHidden()) setLauncherAliasHidden(false)
        return if (!isSelfHidden()) true
        else setApplicationHidden(context.packageName, false) == EnforcementResult.Supported
    }
}
