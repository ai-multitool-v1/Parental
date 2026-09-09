package org.setbd.parentcontrol.camera

import org.setbd.parentcontrol.util.stopForegroundCompat
import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.MainActivity
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.notifications.NotificationChannels
import org.setbd.parentcontrol.security.AuditLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.webrtc.VideoCapturer

/**
 * Foreground service of type `camera` streaming the camera to the parent
 * after explicit in-app consent.
 *
 * Android 14 compliance:
 *  * FOREGROUND_SERVICE_CAMERA permission + manifest type="camera"
 *  * started from the FOREGROUND (consent dialog response)
 *  * startForeground(..., FOREGROUND_SERVICE_TYPE_CAMERA) immediately
 *  * CAMERA runtime permission re-checked here; revoked permission stops the
 *    session (never a silent fallback).
 *
 * Visible state: ongoing notification "Camera session active" with Stop.
 */
class CameraCaptureService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSession()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "camera"

                // Hard permission gate inside the service as well.
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) !=
                    PackageManager.PERMISSION_GRANTED
                ) {
                    ServiceLocator.commandProcessor.postUnsupported(
                        sessionId, "REQUEST_CAMERA_SESSION", "CAMERA permission revoked before start",
                    )
                    stopSelf()
                    return START_NOT_STICKY
                }

                val capturer: VideoCapturer? = ServiceLocator.webRtcClient.createFrontCameraCapturer()
                if (capturer == null) {
                    // Camera-less device or camera busy: report honestly.
                    ServiceLocator.commandProcessor.postUnsupported(
                        sessionId, "REQUEST_CAMERA_SESSION", "no available camera",
                    )
                    stopSelf()
                    return START_NOT_STICKY
                }

                startAsForeground()

                ServiceLocator.appState.sessionStarted(
                    org.setbd.parentcontrol.di.ActiveSession(
                        sessionId = sessionId,
                        type = org.setbd.parentcontrol.di.SessionType.CAMERA,
                    ),
                )
                ServiceLocator.webRtcClient.onSessionEnded = { sid ->
                    if (sid == sessionId) stopSession()
                }
                ServiceLocator.webRtcClient.startSession(sessionId, KIND_CAMERA, capturer)

                ServiceLocator.auditLogger.log(
                    actorUid = ServiceLocator.auth.childUid.value,
                    action = AuditLogger.ACTION_SESSION_STARTED,
                    result = "CAMERA session=$sessionId",
                )
            }
        }
        return START_STICKY
    }

    // ------------------------------------------------------------- indicator --

    private fun buildNotification(): Notification {
        val stopIntent = PendingIntent.getService(
            this, 21,
            Intent(this, CameraCaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val openIntent = PendingIntent.getActivity(
            this, 22,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, NotificationChannels.CHANNEL_SESSIONS)
            .setSmallIcon(R.drawable.ic_stat_familysafety)
            .setContentTitle(getString(R.string.notif_camera_active_title))
            .setContentText(getString(R.string.notif_camera_active_text))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.banner_stop), stopIntent)
            .build()
    }

    private fun startAsForeground() {
        NotificationChannels.ensureAll(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun stopSession() {
        ServiceLocator.webRtcClient.stopSession()
        ServiceLocator.appState.activeSessions.value
            .filter { it.type == org.setbd.parentcontrol.di.SessionType.CAMERA }
            .forEach { ServiceLocator.appState.sessionEnded(it.sessionId) }
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_SESSION_STOPPED,
            result = "CAMERA",
        )
        stopForegroundCompat()
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "org.setbd.parentcontrol.action.CAMERA_START"
        const val ACTION_STOP = "org.setbd.parentcontrol.action.CAMERA_STOP"
        const val EXTRA_SESSION_ID = "sessionId"
        const val NOTIFICATION_ID = 2003
        const val KIND_CAMERA = "CAMERA"
    }
}
