package org.setbd.parentcontrol.notifications

import org.setbd.parentcontrol.commands.CommandTypes
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM entry point for the child device.
 *
 *  * **Data messages** with `type == "COMMAND"` are the fast path into
 *    [org.setbd.parentcontrol.commands.CommandProcessor] (which re-validates
 *    auth, TTL, parent authorization and replay protection — an FCM payload
 *    is NEVER trusted on its own).
 *  * **Notification messages** (and data "PARENT_MESSAGE" payloads) are shown
 *    to the child with the parent's uid metadata attached — fully visible,
 *    never silently swallowed.
 */
class ChildMessagingService : FirebaseMessagingService() {

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.ensureAll(this)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data

        // ---- fast path: parent command ------------------------------------
        // The Worker pushes data {kind: "COMMAND", commandId, type,
        // payload(JSON), expiresAtMs} — the push payload alone does NOT satisfy
        // the security gates, so wakeFromFcm() fetches the authoritative
        // Firestore command doc and runs the full pipeline.
        if (data["kind"] == "COMMAND" || data["type"] == "COMMAND") {
            val commandId = data["commandId"]
            if (!commandId.isNullOrBlank()) {
                ServiceLocator.commandProcessor.wakeFromFcm(commandId)
            }
            return
        }

        // ---- visible parent message ----------------------------------------
        val notification = message.notification
        val title = notification?.title
            ?: data["title"]
            ?: getString(org.setbd.parentcontrol.R.string.notif_parent_message_title)
        val body = notification?.body ?: data["body"] ?: ""
        ParentNotification.showParentMessage(
            context = this,
            title = title,
            body = body,
            parentUid = data["parentUid"] ?: data["parentId"],
        )
    }

    override fun onNewToken(token: String) {
        TokenRefresher.upload(this, token)
    }
}
