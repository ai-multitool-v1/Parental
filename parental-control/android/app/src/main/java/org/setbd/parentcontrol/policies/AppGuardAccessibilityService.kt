package org.setbd.parentcontrol.policies

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityEvent
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger

/**
 * "App Guard" accessibility service — the real-time policy enforcer.
 *
 * WHAT IT DOES (official AccessibilityService use, fully disclosed):
 *  * Reads ONLY the package name of the app that just came to the foreground
 *    (`TYPE_WINDOW_STATE_CHANGED`). It does NOT read screen content, does NOT
 *    log keystrokes, does NOT collect any text — `canRetrieveWindowContent`
 *    is only enabled so OEM window events reliably carry the package name.
 *  * When the foreground app is:
 *      - in the policy block list            → BlockerActivity ("blocked app")
 *      - a non-allowed app during bedtime    → BlockerActivity ("bedtime")
 *      - the Settings app while `protectSettings` is on
 *        (prevents tampering with device-admin) → BlockerActivity ("protected")
 *
 * DISCLOSURE: the service can only be enabled by the user in system Settings;
 * the app shows a persistent "App protection active" notification while it
 * runs, and its state is published to the parent's permission dashboard.
 *
 * API note: accessibility is available on every Android version we support
 * (API 21+), which is exactly why it is the enforcement layer for app
 * blocking on Android 5–8 where UsageStats-based foreground detection is
 * unreliable.
 */
class AppGuardAccessibilityService : AccessibilityService() {

    private var lastBlockedPkg: String? = null
    private var lastBlockAtMs: Long = 0L
    private var launcherPkg: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        launcherPkg = resolveLauncher()
        showProtectionNotification()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName || pkg == "com.android.systemui") return
        if (pkg == launcherPkg) return

        val policy = ServiceLocator.policyRepository.currentPolicy() ?: return

        val bedtime = policy.bedtime
        val bedtimeActive = bedtime != null && BedtimeScheduler.isInBedtimeWindowNow(policy)

        val blockedApp = policy.appBlockList.contains(pkg)
        val blockedBedtime = bedtimeActive && bedtime != null && !bedtime.allowedPackages.contains(pkg)
        val blockedSettings = policy.protectSettings && pkg == "com.android.settings"

        if (blockedApp || blockedBedtime || blockedSettings) {
            val now = System.currentTimeMillis()
            // Throttle: one blocker launch per package per 5 s (accessibility
            // can fire WINDOW_STATE_CHANGED repeatedly for the same app).
            if (pkg == lastBlockedPkg && now - lastBlockAtMs < 5_000L) return
            lastBlockedPkg = pkg
            lastBlockAtMs = now

            val reason = when {
                blockedSettings -> BlockerActivity.REASON_PROTECTED
                bedtimeActive -> BlockerActivity.REASON_BEDTIME
                else -> BlockerActivity.REASON_BLOCKED_APP
            }
            auditBlock(pkg, reason)
            val intent = Intent(this, BlockerActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION,
                )
                putExtra(BlockerActivity.EXTRA_REASON, reason)
                putExtra(BlockerActivity.EXTRA_PACKAGE, pkg)
            }
            runCatching { startActivity(intent) }
        }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        hideProtectionNotification()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ util --

    private fun resolveLauncher(): String? = runCatching {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        packageManager.resolveActivity(home, 0)?.activityInfo?.packageName
    }.getOrNull()

    private fun auditBlock(pkg: String, reason: String) {
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_APP_BLOCKED_BY_POLICY,
            result = "pkg=$pkg reason=$reason",
        )
    }

    private fun showProtectionNotification() {
        runCatching {
            val ctx = this
            org.setbd.parentcontrol.notifications.NotificationChannels.ensureAll(ctx)
            if (android.os.Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) return
            val notification = androidx.core.app.NotificationCompat.Builder(
                ctx,
                org.setbd.parentcontrol.notifications.NotificationChannels.CHANNEL_SESSIONS,
            )
                .setSmallIcon(org.setbd.parentcontrol.R.drawable.ic_stat_familysafety)
                .setContentTitle(ctx.getString(org.setbd.parentcontrol.R.string.guard_notif_title))
                .setContentText(ctx.getString(org.setbd.parentcontrol.R.string.guard_notif_text))
                .setOngoing(true)
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
                .build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager)
                .notify(NOTIFICATION_ID, notification)
        }
    }

    private fun hideProtectionNotification() {
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager)
                .cancel(NOTIFICATION_ID)
        }
    }

    companion object {
        private const val NOTIFICATION_ID = 3001

        /** True when this exact service is enabled in system accessibility settings. */
        fun isEnabled(context: Context): Boolean {
            val expected = ComponentName(context, AppGuardAccessibilityService::class.java)
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            if (TextUtils.isEmpty(enabled)) return false
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(enabled)
            for (component in splitter) {
                val cn = ComponentName.unflattenFromString(component.toString())
                if (cn != null && cn == expected) return true
                // Some OEMs store flattened short form "pkg/.Class".
                if (component.toString().contains(expected.packageName) &&
                    component.toString().contains(expected.className.substringAfterLast('.'))
                ) return true
            }
            return false
        }
    }
}
