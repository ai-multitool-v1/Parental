package org.setbd.parentcontrol.device

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.management.DeviceAdminReceiver
import org.setbd.parentcontrol.security.AuditLogger

/**
 * Secret dial-code launcher.
 *
 * Dialing `*#*#1111#*#*` (or `*#*#1112#*#*`) in the phone dialer makes the
 * SYSTEM dialer broadcast `android.provider.Telephony.SECRET_CODE`
 * (data `android_secret_code://1111`) to every app that registered for it.
 * This receiver then opens the app — including when the launcher icon is
 * hidden via the official Device Owner "hidden application" API, because the
 * AOSP dialer sends secret-code broadcasts with FLAG_INCLUDE_STOPPED_PACKAGES.
 *
 * SAFETY: this is a convenience entry point for the PARENT (e.g. after the
 * app icon was hidden on a Device Owner device). It only ever OPENS the app's
 * visible MainActivity; it cannot grant any permission or start any capture
 * service. No consent model bypass is possible through this path.
 */
class SecretCodeReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "android.provider.Telephony.SECRET_CODE") return
        val host = intent.data?.host ?: return
        if (host != CODE_HOST_PRIMARY && host != CODE_HOST_SECONDARY) return
        openApp(context, "secret_code:$host")
    }

    companion object {
        const val CODE_HOST_PRIMARY = "1111"   // *#*#1111#*#*
        const val CODE_HOST_SECONDARY = "1112" // *#*#1112#*#*

        /** Un-hides (if Device Owner hidden mode) and opens the app. */
        fun openApp(context: Context, source: String) {
            try {
                ServiceLocator.init(context.applicationContext)
                val unhidden = ServiceLocator.devicePolicyWrapper.unhideSelf()
                val launch = Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                context.startActivity(launch)
                ServiceLocator.auditLogger.log(
                    actorUid = ServiceLocator.auth.childUid.value,
                    action = AuditLogger.ACTION_APP_OPENED_VIA_DIAL_CODE,
                    result = "source=$source unhidden=$unhidden",
                )
            } catch (e: Exception) {
                // Never crash from a dialer broadcast.
                Log.w(TAG, "openApp failed: ${e.message}")
                runCatching {
                    context.startActivity(
                        Intent(context, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
        }

        private const val TAG = "SecretCodeReceiver"
    }
}

/**
 * Fallback for OEM dialers that do not emit SECRET_CODE (mainly Android 9 and
 * below where intercepting NEW_OUTGOING_CALL was the common pattern).
 *
 * PROCESS_OUTGOING_CALLS is deprecated and blocked from Android 10 for
 * non-dialer apps, so this receiver is declared with maxSdkVersion=28 in the
 * manifest. On Android 10+ the SECRET_CODE receiver above is the mechanism.
 */
class DialCodeFallbackReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT > 28) return
        if (intent.action != Intent.ACTION_NEW_OUTGOING_CALL) return
        val number = resultData?.getStringExtra(Intent.EXTRA_PHONE_NUMBER) ?: return
        if (number != DIAL_CODE_PRIMARY && number != DIAL_CODE_SECONDARY) return

        // Swallow the "call" so the dialer does not attempt it, then open the app.
        setResultData(null)
        SecretCodeReceiver.openApp(context, "outgoing_call:$number")
    }

    companion object {
        const val DIAL_CODE_PRIMARY = "*#*#1111#*#*"
        const val DIAL_CODE_SECONDARY = "*#*#1112#*#*"
    }
}
