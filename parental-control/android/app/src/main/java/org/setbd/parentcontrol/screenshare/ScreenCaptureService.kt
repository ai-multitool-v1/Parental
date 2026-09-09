package org.setbd.parentcontrol.screenshare

import org.setbd.parentcontrol.util.stopForegroundCompat
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.webrtc.ScreenCapturerAndroid

/**
 * Foreground service of type `mediaProjection` carrying the screen-sharing
 * session started by [ScreenShareSessionManager] AFTER:
 *  * the in-app consent dialog was accepted, and
 *  * the system MediaProjection dialog was accepted.
 *
 * Android 14 compliance:
 *  * manifest: FOREGROUND_SERVICE_MEDIA_PROJECTION + type="mediaProjection"
 *  * startForeground(..., FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) with the
 *    user-approved projection token, within the service-start window,
 *  * started only from the foreground (ConsentDialog response).
 *
 * The ongoing notification is the child's visible "screen sharing active"
 * indicator, with a Stop action — the child can always end the session.
 */
class ScreenCaptureService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSession()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE)
                @Suppress("DEPRECATION")
                val resultData = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "screen"
                val commandId = intent.getStringExtra(EXTRA_COMMAND_ID) ?: sessionId

                if (resultCode == Int.MIN_VALUE || resultData == null) {
                    // Missing token: never guess. Report and stop.
                    ServiceLocator.commandProcessor.postUnsupported(
                        commandId, "REQUEST_SCREEN_SESSION", "missing projection token",
                    )
                    stopSelf()
                    return START_NOT_STICKY
                }

                // MUST be called promptly and with the mediaProjection type.
                startAsForeground()

                val projectionManager =
                    getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                // Guard: if the user revoked the token, getMediaProjection throws.
                val projection = try {
                    projectionManager.getMediaProjection(resultCode, resultData)
                } catch (e: Exception) {
                    ServiceLocator.commandProcessor.postUnsupported(
                        commandId, "REQUEST_SCREEN_SESSION", "projection token rejected: ${e.message}",
                    )
                    stopSelf()
                    return START_NOT_STICKY
                }
                projection?.registerCallback(object : android.media.projection.MediaProjection.Callback() {
                    override fun onStop() {
                        // User stopped sharing from the system cast tile.
                        stopSession()
                    }
                }, null)

                // WebRTC screen track from the projection virtual display.
                val capturer = ScreenCapturerAndroid(resultData, object :
                    android.media.projection.MediaProjection.Callback() {})

                ServiceLocator.appState.sessionStarted(
                    org.setbd.parentcontrol.di.ActiveSession(
                        sessionId = sessionId,
                        type = org.setbd.parentcontrol.di.SessionType.SCREEN,
                    ),
                )
                ServiceLocator.webRtcClient.onSessionEnded = { sid ->
                    if (sid == sessionId) stopSession()
                }
                ServiceLocator.webRtcClient.startSession(sessionId, KIND_SCREEN, capturer)

                ServiceLocator.auditLogger.log(
                    actorUid = ServiceLocator.auth.childUid.value,
                    action = AuditLogger.ACTION_SESSION_STARTED,
                    result = "SCREEN session=$sessionId",
                )
            }
        }
        return START_STICKY
    }

    // ------------------------------------------------------------- indicator --

    private fun buildNotification(): Notification {
        val stopIntent = PendingIntent.getService(
            this, 11,
            Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val openIntent = PendingIntent.getActivity(
            this, 12,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, org.setbd.parentcontrol.notifications.NotificationChannels.CHANNEL_SESSIONS)
            .setSmallIcon(R.drawable.ic_stat_familysafety)
            .setContentTitle(getString(R.string.notif_screen_active_title))
            .setContentText(getString(R.string.notif_screen_active_text))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.banner_stop), stopIntent)
            .build()
    }

    private fun startAsForeground() {
        org.setbd.parentcontrol.notifications.NotificationChannels.ensureAll(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun stopSession() {
        ServiceLocator.webRtcClient.stopSession()
        val active = ServiceLocator.appState.activeSessions.value
        active.filter { it.type == org.setbd.parentcontrol.di.SessionType.SCREEN }
            .forEach { ServiceLocator.appState.sessionEnded(it.sessionId) }
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_SESSION_STOPPED,
            result = "SCREEN",
        )
        stopForegroundCompat()
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "org.setbd.parentcontrol.action.SCREEN_START"
        const val ACTION_STOP = "org.setbd.parentcontrol.action.SCREEN_STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_COMMAND_ID = "commandId"
        const val NOTIFICATION_ID = 2002
        const val KIND_SCREEN = "SCREEN"
    }
}
