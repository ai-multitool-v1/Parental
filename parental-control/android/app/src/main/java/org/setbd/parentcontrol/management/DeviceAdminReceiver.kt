package org.setbd.parentcontrol.management

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger

/**
 * Family Safety device-admin receiver.
 *
 * Purpose (deliberately narrow):
 *  * receive lockNow capability for the parent's LOCK_DEVICE command,
 *  * record admin enable/disable events in the family audit log.
 *
 * It is activated ONLY through the standard visible system dialog (or device
 * provisioning flows). The requested policies live in
 * `res/xml/device_admin_sample.xml` — force-lock and watch-login ONLY
 * (limit-password was removed in the security audit: unused declared
 * policies widen the admin surface). No wipe, no password reset, no
 * camera-disable policy.
 */
class DeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = "DEVICE_ADMIN_ENABLED",
            result = ManagementState.current(context).name,
        )
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = "DEVICE_ADMIN_DISABLED",
            result = ManagementMode.NONE.name,
        )
    }

    override fun onPasswordFailed(context: Context, intent: Intent, userHandle: android.os.UserHandle) {
        super.onPasswordFailed(context, intent, userHandle)
        // watch-login policy: record suspicious unlock attempts in the audit
        // log only — we never lock or wipe on failed logins ourselves.
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = "DEVICE_UNLOCK_FAILED",
            result = "recorded",
        )
    }
}
