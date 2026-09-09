package org.setbd.parentcontrol.location

import org.setbd.parentcontrol.util.stopForegroundCompat
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger
import kotlinx.coroutines.*

/**
 * Foreground service of type `location` for LIVE location sharing.
 *
 * Android 14 requirements honored:
 *  * Declared with `android:foregroundServiceType="location"`, plus the
 *    FOREGROUND_SERVICE_LOCATION permission in the manifest.
 *  * Started ONLY while the app is in the foreground (a visible command flow
 *    or the Settings screen triggered it).
 *  * Calls startForeground() with FOREGROUND_SERVICE_TYPE_LOCATION within a
 *    few seconds of onStartCommand.
 *
 * The persistent notification is the child's always-visible indicator, with
 * a Stop action — the child can end sharing without asking anyone.
 */
class LocationService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSharing()
                return START_NOT_STICKY
            }
            else -> {
                val repo = ServiceLocator.locationRepository
                if (!repo.hasFineLocation()) {
                    // No permission = never start. Report UNSUPPORTED-ish state
                    // instead of trying any bypass.
                    stopSelf()
                    return START_NOT_STICKY
                }
                startAsForeground()
                val started = repo.startLiveUpdates()
                if (!started) {
                    stopSelf()
                } else {
                    // Register in shared state so the dashboard shows the
                    // always-visible "location sharing" banner too.
                    ServiceLocator.appState.sessionStarted(
                        org.setbd.parentcontrol.di.ActiveSession(
                            sessionId = SESSION_ID,
                            type = org.setbd.parentcontrol.di.SessionType.LOCATION,
                        )
                    )
                    ServiceLocator.auditLogger.log(
                        actorUid = ServiceLocator.auth.childUid.value,
                        action = AuditLogger.ACTION_SESSION_STARTED,
                        result = "live_location",
                    )
                    // Hard safety stop: live tracking never runs silently forever.
                    scheduleSafetyStop(LIVE_SESSION_MAX_MS)
                }
            }
        }
        return START_STICKY
    }

    /** Visible, non-dismissable indicator with a working Stop action. */
    private fun buildNotification(): Notification {
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, LocationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val openIntent = PendingIntent.getActivity(
            this, 2,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_LOCATION)
            .setSmallIcon(R.drawable.ic_stat_familysafety)
            .setContentTitle(getString(R.string.notif_location_active_title))
            .setContentText(getString(R.string.notif_location_active_text))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.banner_stop), stopIntent)
            .build()
    }

    private fun startAsForeground() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_LOCATION,
                    getString(R.string.channel_location),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = getString(R.string.channel_location_desc) }
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    /** Auto-stop after the max window — shared sessions must never outlive consent indefinitely. */
    private fun scheduleSafetyStop(durationMs: Long) {
        scope.launch {
            delay(durationMs)
            stopSharing()
        }
    }

    private fun stopSharing() {
        ServiceLocator.locationRepository.stopLiveUpdates()
        ServiceLocator.appState.sessionEnded(SESSION_ID)
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_SESSION_STOPPED,
            result = "live_location",
        )
        stopForegroundCompat()
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "org.setbd.parentcontrol.action.LOCATION_START"
        const val ACTION_STOP = "org.setbd.parentcontrol.action.LOCATION_STOP"
        const val CHANNEL_LOCATION = "channel_location"
        const val NOTIFICATION_ID = 1001
        const val SESSION_ID = "live-location"
        const val LIVE_SESSION_MAX_MS = 30 * 60 * 1000L // 30 minutes
    }
}
