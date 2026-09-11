package org.setbd.parentcontrol.security

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.management.DeviceAdminReceiver
import org.setbd.parentcontrol.notifications.NotificationChannels
import kotlinx.coroutines.launch

/**
 * Parent-initiated permission REQUEST flow (REQUEST_PERMISSION command).
 *
 * SAFETY CONTRACT:
 *  * The parent can only ASK. The child ALWAYS sees a real system dialog or
 *    system settings screen — nothing is ever granted programmatically.
 *  * Arrival path: CommandProcessor → [show] posts a high-priority
 *    notification (background-activity-launch safe) whose content intent
 *    opens THIS activity.
 *  * After the child answers (or returns from system settings), the fresh
 *    permission state is re-published to devices/{id}/permissions/current —
 *    the parent dashboard picks it up within one realtime poll (~5 s).
 */
class PermissionRequestActivity : androidx.activity.ComponentActivity() {

    private var permissionKey: String = ""
    private var answered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        permissionKey = intent.getStringExtra(EXTRA_PERMISSION) ?: ""
        setContentView(R.layout.activity_permission_request)
        findViewById<TextView>(R.id.perm_request_text).text = rationaleText(permissionKey)

        findViewById<Button>(R.id.perm_request_allow).setOnClickListener {
            answered = true
            handleAllow()
        }
        findViewById<Button>(R.id.perm_request_later).setOnClickListener {
            answered = true
            publishAndFinish()
        }
    }

    override fun onResume() {
        super.onResume()
        // Publish fresh state whenever we come back from system settings.
        if (answered) publishAndFinish()
    }

    private fun handleAllow() {
        when (permissionKey) {
            "location" -> requestRuntime(arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ))
            "notifications" ->
                if (Build.VERSION.SDK_INT >= 33) requestRuntime(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                else publishAndFinish()
            "camera" -> requestRuntime(arrayOf(Manifest.permission.CAMERA))
            "microphone" -> requestRuntime(arrayOf(Manifest.permission.RECORD_AUDIO))
            "appUsageAccess" -> openSettings(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            "accessibilityService" -> openSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "deviceAdmin" -> {
                val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                val intent = Intent(android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(android.app.admin.DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
                    .putExtra(
                        android.app.admin.DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                        getString(R.string.device_admin_description),
                    )
                runCatching { startActivity(intent) }
                // falls through to onResume → publish + finish when the user returns
            }
            "batteryOptimization" -> {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
                runCatching { startActivity(intent) }
            }
            else -> openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        }
    }

    private fun requestRuntime(permissions: Array<String>) {
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            publishAndFinish()
            return
        }
        ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_CODE)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CODE) publishAndFinish()
    }

    private fun openSettings(action: String) {
        runCatching {
            startActivity(Intent(action).setData(Uri.parse("package:$packageName")))
        }.onFailure {
            runCatching { startActivity(Intent(action)) }
        }
    }

    /** Re-publishes the permission dashboard state, then closes. */
    private fun publishAndFinish() {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            ServiceLocator.permissionReporter.report()
        }
        finish()
    }

    private fun rationaleText(key: String): String = when (key) {
        "location" -> "অভিভাবক লোকেশন অনুমতির অনুরোধ পাঠিয়েছেন — Allow দিলে লাইভ/একশট লোকেশন দেখা যাবে।"
        "notifications" -> "অভিভাবক নোটিফিকেশন অনুমতির অনুরোধ পাঠিয়েছেন — বার্তা ও সতর্কতা দেখতে চালু করুন।"
        "camera" -> "অভিভাবক ক্যামেরা সেশনের অনুমতি চেয়েছেন — আপনি Allow না দিলে ক্যামেরা চালু হবে না।"
        "microphone" -> "অভিভাবক অডিও সেশনের অনুমতি চেয়েছেন — আপনি Allow না দিলে মাইক্রোফোন চালু হবে না।"
        "appUsageAccess" -> "অভিভাবক স্ক্রিন-টাইম রিপোর্টের জন্য Usage access চেয়েছেন — সেটিংসে এই অ্যাপটি চালু করুন।"
        "accessibilityService" -> "অভিভাবক অ্যাপ ব্লকিং/বেডটাইমের জন্য Accessibility সার্ভিস চেয়েছেন — সেটিংসে চালু করুন।"
        "deviceAdmin" -> "অভিভাবক uninstall protection ও remote lock-এর জন্য Device admin চেয়েছেন।"
        "batteryOptimization" -> "ব্যাকগ্রাউন্ডে সংযোগ রাখতে ব্যাটারি অপটিমাইজেশন থেকে বাদ দিন।"
        else -> "অভিভাবক একটি অনুমতির অনুরোধ পাঠিয়েছেন।"
    }

    companion object {
        private const val REQ_CODE = 4211
        const val EXTRA_PERMISSION = "org.setbd.parentcontrol.extra.PERMISSION"

        /** Shows the in-app request screen for [key]; returns false when notifications are blocked. */
        fun show(context: Context, key: String): Boolean {
            if (Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                return false
            }
            NotificationChannels.ensureAll(context)
            val intent = Intent(context, PermissionRequestActivity::class.java)
                .putExtra(EXTRA_PERMISSION, key)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val pi = PendingIntent.getActivity(
                context,
                key.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(
                NOTIF_TAG,
                key.hashCode(),
                NotificationCompat.Builder(context, NotificationChannels.CHANNEL_COMMANDS)
                    .setSmallIcon(R.drawable.ic_app_logo)
                    .setContentTitle("অভিভাবকের অনুরোধ")
                    .setContentText("একটি অনুমতির অনুরোধ এসেছে — ট্যাপ করে দেখুন")
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build(),
            )
            return true
        }

        private const val NOTIF_TAG = "permission_request"
    }
}
