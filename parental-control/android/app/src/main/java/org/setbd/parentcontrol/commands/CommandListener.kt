package org.setbd.parentcontrol.commands

import android.util.Log
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query

/**
 * Firestore snapshot listener on `devices/{deviceId}/commands` where
 * `status == "PENDING"`.
 *
 * This is the RELIABLE path for parent commands. The FCM data message
 * ([org.setbd.parentcontrol.notifications.ChildMessagingService]) is only a
 * low-latency fast path that feeds the very same
 * [CommandProcessor.processIncoming] — replay + result-existence checks make
 * double delivery harmless.
 */
object CommandListener {

    private const val TAG = "CommandListener"
    private var registration: ListenerRegistration? = null

    fun start() {
        if (registration != null) return
        val firestore = FirebaseFirestore.getInstance()
        registration = firestore.collection("devices")
            .document(ServiceLocator.deviceId)
            .collection("commands")
            .whereEqualTo("status", "PENDING")
            .orderBy("createdAt", Query.Direction.ASCENDING)
            .limit(20)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.w(TAG, "command listener error: ${error.message}")
                    return@addSnapshotListener
                }
                snapshot?.documentChanges?.forEach { change ->
                    // Only react to newly added pending commands; MODIFIED is
                    // ignored because results are written to commandResults.
                    if (change.type == com.google.firebase.firestore.DocumentChange.Type.ADDED) {
                        val doc = change.document
                        ServiceLocator.commandProcessor.enqueue(
                            commandId = doc.id,
                            data = doc.data,
                        )
                    }
                }
            }
    }

    fun stop() {
        registration?.remove()
        registration = null
    }
}
