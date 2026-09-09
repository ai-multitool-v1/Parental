package org.setbd.parentcontrol.webrtc

import android.util.Log
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import kotlinx.coroutines.tasks.await

/** One signaling envelope exchanged over Firestore. */
data class Signal(
    val kind: String,            // "offer" | "answer" | "candidate" | "bye"
    val sdp: String? = null,     // for offer/answer (SDP body)
    val sdpType: String? = null, // e.g. "offer"
    val candidateSdp: String? = null, // for candidate
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
    val from: String = "child",  // "child" | "parent"
)

/**
 * Firestore-based signaling for WebRTC sessions.
 *
 * Path: `devices/{deviceId}/sessions/{sessionId}` (session doc with
 * status/startedAt) and `devices/{deviceId}/sessions/{sessionId}/signals`
 * (ordered envelopes, one document per signal).
 *
 * WHY Firestore signaling: it rides the same authenticated, App-Check-
 * protected, rules-enforced channel as everything else — no extra socket
 * infrastructure, and the parent dashboard participates with plain SDK calls.
 */
class SignalingClient {

    private val firestore = FirebaseFirestore.getInstance()
    private var listener: com.google.firebase.firestore.ListenerRegistration? = null

    private fun sessions() = firestore.collection("devices")
        .document(ServiceLocator.deviceId)
        .collection("sessions")

    /**
     * Reads the per-session ICE server config issued by requestSession
     * (ephemeral, time-limited TURN credentials when configured).
     * SECURITY: credentials live ONLY in the session document — they are
     * never compiled into the app.
     */
    suspend fun fetchIceServers(sessionId: String): List<Map<String, Any?>> {
        return runCatching {
            val snap = sessions().document(sessionId).get().await()
            @Suppress("UNCHECKED_CAST")
            (snap.get("iceServers") as? List<Map<String, Any?>>) ?: emptyList()
        }.getOrDefault(emptyList())
    }

    /**
     * SECURITY (audit fix): the session DOCUMENT is written ONLY by Cloud
     * Functions (firestore.rules: sessions allow write: if false). The
     * child-side transport announces itself via the OFFER signal instead —
     * the earlier version of this method tried to write status/startedAt
     * onto the session doc, which the rules (correctly) deny.
     */
    suspend fun openSession(sessionId: String, type: String) {
        // No session-doc write: consent state is function-owned.
    }

    /**
     * Child-side teardown:
     *  1. send a `bye` signaling envelope (the parent stops rendering), and
     *  2. call the `endSession` Cloud Function so the function-owned session
     *     state machine records CHILD_STOPPED (this replaces the previous —
     *     rules-denied — direct doc update, and works for the no-timer
     *     SCREEN sessions that never auto-expire).
     */
    suspend fun closeSession(sessionId: String) {
        stopListening()
        runCatching {
            sessions().document(sessionId).collection("signals").add(
                mapOf(
                    "kind" to "bye",
                    "from" to "child",
                    "createdAt" to FieldValue.serverTimestamp(),
                ),
            ).await()
        }.onFailure { Log.w(TAG, "bye signal failed: ${it.message}") }
        runCatching {
            FirebaseFunctions.getInstance(FUNCTIONS_REGION)
                .getHttpsCallable("endSession")
                .call(mapOf("sessionId" to sessionId))
                .await()
        }.onFailure { Log.w(TAG, "endSession callable failed: ${it.message}") }
    }

    suspend fun sendOffer(sessionId: String, sdp: String) =
        send(sessionId, Signal(kind = "offer", sdp = sdp, sdpType = "offer"))

    suspend fun sendCandidate(
        sessionId: String,
        candidateSdp: String,
        sdpMid: String?,
        sdpMLineIndex: Int,
    ) = send(
        sessionId,
        Signal(
            kind = "candidate",
            candidateSdp = candidateSdp,
            sdpMid = sdpMid,
            sdpMLineIndex = sdpMLineIndex,
        ),
    )

    private suspend fun send(sessionId: String, signal: Signal) {
        runCatching {
            sessions().document(sessionId).collection("signals").add(
                mapOf(
                    "kind" to signal.kind,
                    "sdp" to signal.sdp,
                    "sdpType" to signal.sdpType,
                    "candidateSdp" to signal.candidateSdp,
                    "sdpMid" to signal.sdpMid,
                    "sdpMLineIndex" to signal.sdpMLineIndex,
                    "from" to "child",
                    "createdAt" to FieldValue.serverTimestamp(),
                ),
            ).await()
        }.onFailure { Log.w(TAG, "signal send failed: ${it.message}") }
    }

    /**
     * Listens for parent signals (answer/candidates/bye) and forwards them to
     * [onSignal]. Firestore orders by createdAt so SDP ordering is stable.
     */
    fun listen(sessionId: String, onSignal: (Signal) -> Unit) {
        stopListening()
        listener = sessions().document(sessionId).collection("signals")
            .whereEqualTo("from", "parent")
            .orderBy("createdAt", Query.Direction.ASCENDING)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.w(TAG, "signal listen error: ${error.message}")
                    return@addSnapshotListener
                }
                snapshot?.documentChanges?.forEach { change ->
                    if (change.type != com.google.firebase.firestore.DocumentChange.Type.ADDED) return@forEach
                    val d = change.document
                    onSignal(
                        Signal(
                            kind = d.getString("kind") ?: return@forEach,
                            sdp = d.getString("sdp"),
                            sdpType = d.getString("sdpType"),
                            candidateSdp = d.getString("candidateSdp"),
                            sdpMid = d.getString("sdpMid"),
                            sdpMLineIndex = (d.getLong("sdpMLineIndex") ?: -1L).toInt(),
                            from = "parent",
                        ),
                    )
                }
            }
    }

    fun stopListening() {
        listener?.remove()
        listener = null
    }

    private companion object {
        const val TAG = "SignalingClient"
        /** Must match functions/src/lib/constants.ts REGION. */
        const val FUNCTIONS_REGION = "asia-south1"
    }
}
