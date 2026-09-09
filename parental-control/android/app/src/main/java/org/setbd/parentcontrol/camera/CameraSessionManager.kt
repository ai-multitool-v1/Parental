package org.setbd.parentcontrol.camera

import org.setbd.parentcontrol.util.startFgServiceCompat
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.di.ConsentRequest
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger

/**
 * Camera session orchestrator.
 *
 * CONSENT CHAIN:
 *  1. REQUEST_CAMERA_SESSION command → visible ConsentDialog (Allow/Decline).
 *  2. On Allow: verify the CAMERA runtime permission. Missing permission is a
 *     hard stop — we report UNSUPPORTED (the UI offers the system Settings
 *     flow); we NEVER try to bypass.
 *  3. Start [CameraCaptureService] — a foreground service of type `camera`,
 *     started from the foreground (Android 14 requirement) with a visible
 *     "Camera session active" notification the child can use to stop.
 */
class CameraSessionManager(private val context: Context) {

    fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    /** Called by CommandProcessor.onConsentResponse when the child taps Allow. */
    fun onConsentGranted(request: ConsentRequest) {
        if (!hasCameraPermission()) {
            ServiceLocator.commandProcessor.postUnsupported(
                request.commandId,
                "REQUEST_CAMERA_SESSION",
                "CAMERA runtime permission not granted by child",
            )
            ServiceLocator.appState.sessionEnded(request.sessionId)
            return
        }
        val intent = Intent(context, CameraCaptureService::class.java).apply {
            action = CameraCaptureService.ACTION_START
            putExtra(CameraCaptureService.EXTRA_SESSION_ID, request.sessionId)
        }
        // App is in the foreground here (the consent dialog was just closed).
        context.startFgServiceCompat(intent)
    }

    /** STOP_CAMERA_SESSION command or child pressing Stop on the banner. */
    fun stopSession() {
        context.startService(
            Intent(context, CameraCaptureService::class.java)
                .setAction(CameraCaptureService.ACTION_STOP),
        )
    }

    fun isSessionActive(): Boolean =
        ServiceLocator.appState.activeSessions.value.any { it.type == org.setbd.parentcontrol.di.SessionType.CAMERA }

    @Suppress("unused")
    private fun unusedAuditHook() {
        // Kept intentionally blank: audit logging for camera sessions happens
        // inside the service (start/stop) via AuditLogger.
    }
}
