package org.setbd.parentcontrol.microphone

import org.setbd.parentcontrol.util.startFgServiceCompat
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.di.ConsentRequest
import org.setbd.parentcontrol.di.ServiceLocator

/**
 * Microphone session orchestrator — same consent pattern as the camera:
 * in-app Allow → RECORD_AUDIO permission verified → foreground service of
 * type `microphone` started from the foreground with a visible notification.
 */
class MicrophoneSessionManager(private val context: Context) {

    fun hasRecordAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    /** Called by CommandProcessor.onConsentResponse when the child taps Allow. */
    fun onConsentGranted(request: ConsentRequest) {
        if (!hasRecordAudioPermission()) {
            ServiceLocator.commandProcessor.postUnsupported(
                request.commandId,
                "REQUEST_AUDIO_SESSION",
                "RECORD_AUDIO runtime permission not granted by child",
            )
            ServiceLocator.appState.sessionEnded(request.sessionId)
            return
        }
        val intent = Intent(context, AudioCaptureService::class.java).apply {
            action = AudioCaptureService.ACTION_START
            putExtra(AudioCaptureService.EXTRA_SESSION_ID, request.sessionId)
        }
        // Foreground start: the consent dialog was just dismissed.
        context.startFgServiceCompat(intent)
    }

    /** STOP_AUDIO_SESSION command or child pressing Stop on the banner. */
    fun stopSession() {
        context.startService(
            Intent(context, AudioCaptureService::class.java)
                .setAction(AudioCaptureService.ACTION_STOP),
        )
    }

    fun isSessionActive(): Boolean =
        ServiceLocator.appState.activeSessions.value.any { it.type == org.setbd.parentcontrol.di.SessionType.AUDIO }
}
