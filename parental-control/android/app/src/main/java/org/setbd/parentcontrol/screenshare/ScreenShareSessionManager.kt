package org.setbd.parentcontrol.screenshare

import org.setbd.parentcontrol.util.startFgServiceCompat
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import org.setbd.parentcontrol.di.ConsentRequest
import org.setbd.parentcontrol.di.ProjectionRequest
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger

/**
 * Screen-sharing session orchestrator.
 *
 * CONSENT CHAIN (all three steps required, in order):
 *  1. Parent command → in-app [org.setbd.parentcontrol.ui.ConsentDialog]
 *     (Allow / Decline) — handled by CommandProcessor.onConsentResponse which
 *     calls [onConsentGranted] only when the child taps Allow.
 *  2. System MediaProjection consent dialog
 *     (`MediaProjectionManager.createScreenCaptureIntent()`), launched from
 *     MainActivity via [org.setbd.parentcontrol.di.AppState.projectionRequests].
 *  3. Foreground service of type `mediaProjection` started from the foreground
 *     with the user-approved projection token (Android 14 requirement).
 *
 * If the child declines at ANY step, nothing captures and the parent sees
 * USER_DECLINED / UNSUPPORTED in the command results.
 */
class ScreenShareSessionManager(private val context: Context) {

    private val projectionManager: MediaProjectionManager =
        context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager

    /** Pending request context used when the projection result arrives. */
    private var pendingConsent: ConsentRequest? = null

    /**
     * Called after the child tapped Allow: asks MainActivity to launch the
     * system projection dialog. The result lands in [onProjectionResult].
     */
    fun onConsentGranted(request: ConsentRequest) {
        pendingConsent = request
        ServiceLocator.appState.projectionRequests.tryEmit(
            ProjectionRequest(sessionId = request.sessionId) { resultCode, data ->
                onProjectionResult(request, resultCode, data)
            },
        )
    }

    /**
     * Result of the SYSTEM MediaProjection dialog. Only RESULT_OK with a
     * non-null token starts the foreground service.
     */
    fun onProjectionResult(request: ConsentRequest, resultCode: Int, data: Intent?) {
        pendingConsent = null
        if (data == null || resultCode != android.app.Activity.RESULT_OK) {
            // Child said no to the system dialog: record it honestly.
            ServiceLocator.commandProcessor.postUnsupported(
                request.commandId,
                "REQUEST_SCREEN_SESSION",
                "user declined system screen-capture dialog",
            )
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_SESSION_USER_DECLINED,
                result = "SCREEN session=${request.sessionId} (system dialog)",
            )
            ServiceLocator.appState.sessionEnded(request.sessionId)
            return
        }
        // Start the foreground service WHILE THE APP IS IN FOREGROUND — the
        // dialog was just dismissed, so this is guaranteed.
        val serviceIntent = Intent(context, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
            putExtra(ScreenCaptureService.EXTRA_SESSION_ID, request.sessionId)
            putExtra(ScreenCaptureService.EXTRA_COMMAND_ID, request.commandId)
        }
        @SuppressLint("WrongConstant")
        fun startFgSafe(intent: Intent) {
            context.startFgServiceCompat(intent)
        }
        startFgSafe(serviceIntent)
    }

    /** STOP_SCREEN_SESSION command or the child pressing Stop on the banner. */
    fun stopSession(sessionId: String?) {
        val intent = Intent(context, ScreenCaptureService::class.java)
            .setAction(ScreenCaptureService.ACTION_STOP)
        if (sessionId != null) intent.putExtra(ScreenCaptureService.EXTRA_SESSION_ID, sessionId)
        context.startService(intent)
    }
}
