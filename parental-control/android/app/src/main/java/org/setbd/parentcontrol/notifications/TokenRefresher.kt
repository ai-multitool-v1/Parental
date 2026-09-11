package org.setbd.parentcontrol.notifications

import android.content.Context
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Keeps `devices/{deviceId}.fcmToken` current so the parent backend (Cloud
 * Function) can route commands and messages to this device.
 *
 * Called from: onNewToken, app start (MainActivity), and after pairing.
 */
object TokenRefresher {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Fetches the current FCM token and uploads it (fire-and-forget). */
    fun refresh(context: Context) {
        scope.launch {
            runCatching { FirebaseMessaging.getInstance().token.await() }
                .onSuccess { upload(context, it) }
        }
    }

    /** Uploads an explicit token (e.g. from [ChildMessagingService.onNewToken]). */
    fun upload(context: Context, token: String) {
        scope.launch {
            runCatching {
                com.google.firebase.firestore.FirebaseFirestore.getInstance()
                    .collection("devices").document(ServiceLocator.deviceId)
                    .update(
                        // ⚠️ fcmToken ONLY — firestore.rules whitelist for the
                        // device doc is affectedKeys().hasOnly([... 'fcmToken' ...]).
                        // Writing an extra field (e.g. fcmTokenUpdatedAt) fails
                        // hasOnly → PERMISSION_DENIED → token never uploaded →
                        // the Worker can never FCM-push notifications/commands.
                        mapOf("fcmToken" to token),
                    ).await()
            }.onFailure {
                // Device doc may not exist yet (pre-pairing) — retry at next refresh.
                android.util.Log.w("TokenRefresher", "token upload deferred: ${it.message}")
            }
        }
    }
}
