package org.setbd.parentcontrol.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.R

/**
 * Central notification-channel registry. All channels are created at app
 * start AND lazily before any notify() call, so a missing channel can never
 * silently swallow the visible session indicators required by our consent
 * model.
 */
object NotificationChannels {
    const val CHANNEL_SESSIONS = "channel_sessions"       // active media sessions
    const val CHANNEL_COMMANDS = "channel_parent_messages" // parent messages
    const val CHANNEL_SOS = "channel_sos"                 // SOS / safety / bedtime
    const val CHANNEL_LOCATION = "channel_location"       // live location sharing

    fun ensureAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        fun channel(id: String, nameRes: Int, descRes: Int, importance: Int) {
            if (nm.getNotificationChannel(id) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(id, context.getString(nameRes), importance).apply {
                        description = context.getString(descRes)
                    },
                )
            }
        }
        channel(CHANNEL_SESSIONS, R.string.channel_sessions, R.string.channel_sessions_desc, NotificationManager.IMPORTANCE_LOW)
        channel(CHANNEL_COMMANDS, R.string.channel_parent_messages, R.string.channel_parent_messages_desc, NotificationManager.IMPORTANCE_DEFAULT)
        channel(CHANNEL_SOS, R.string.channel_sos, R.string.channel_sos_desc, NotificationManager.IMPORTANCE_HIGH)
        channel(CHANNEL_LOCATION, R.string.channel_location, R.string.channel_location_desc, NotificationManager.IMPORTANCE_LOW)
    }
}

/**
 * Parent-originated notifications (SEND_NOTIFICATION command and FCM
 * notification messages). Always tagged with the parent uid so the child UI
 * can show who sent it — transparency over obfuscation.
 */
object ParentNotification {

    /**
     * Shows a parent message. Returns false when POST_NOTIFICATIONS is not
     * granted (Android 13+) — callers translate that into UNSUPPORTED.
     */
    fun showParentMessage(context: Context, title: String, body: String, parentUid: String?): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        NotificationChannels.ensureAll(context)
        val open = PendingIntent.getActivity(
            context, 10,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, NotificationChannels.CHANNEL_COMMANDS)
            .setSmallIcon(R.drawable.ic_stat_familysafety)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            // Metadata for transparency: the child can see which parent sent it.
            .setExtras(android.os.Bundle().apply {
                putString("parentUid", parentUid)
            })
            .build()
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(TAG_PARENT_MESSAGE.hashCode(), notification)
        return true
    }

    const val TAG_PARENT_MESSAGE = "parent_message"
}
