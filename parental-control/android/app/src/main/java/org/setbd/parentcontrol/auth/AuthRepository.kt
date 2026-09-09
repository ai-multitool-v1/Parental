package org.setbd.parentcontrol.auth

import android.content.Context
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await

/**
 * Firebase Authentication for the CHILD profile.
 *
 * We sign the child device in **anonymously** (no personal data collected from
 * a minor), with an optional email/password fallback for families that prefer
 * a recoverable account. The resulting `childUid` is what the parent dashboard
 * approves during pairing, and what Firestore security rules key on.
 *
 * SAFETY: the childUid (or anonymous uid) — NEVER the IMEI — is the only
 * identity used for authorization decisions.
 */
class AuthRepository(private val context: Context) {

    private val firebaseAuth: FirebaseAuth = FirebaseAuth.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _childUid = MutableStateFlow<String?>(firebaseAuth.currentUser?.uid)
    val childUid: StateFlow<String?> = _childUid.asStateFlow()

    private val _signedIn = MutableStateFlow(_childUid.value != null)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    /**
     * Ensures a signed-in session. Prefers the existing Firebase user, then
     * anonymous sign-in, then (only if the family opted into a child account)
     * email/password sign-up handled by the parent dashboard export.
     *
     * @return the child uid, or null if sign-in failed (offline first run).
     */
    suspend fun ensureSignedIn(): String? {
        firebaseAuth.currentUser?.let { user ->
            publish(user)
            return user.uid
        }
        return try {
            val result = firebaseAuth.signInAnonymously().await()
            publish(result.user)
            result.user?.uid
        } catch (e: Exception) {
            // Offline or Firebase config problem: remain signed out; pairing
            // screen will surface a friendly retry. Never fall back to any
            // device identifier (e.g. IMEI) as an identity.
            null
        }
    }

    /**
     * Optional email/password sign-in for families that created a named child
     * account in advance. Kept separate from anonymous flow on purpose.
     */
    suspend fun signInWithEmail(email: String, password: String): String? = try {
        val result = firebaseAuth.signInWithEmailAndPassword(email, password).await()
        publish(result.user)
        result.user?.uid
    } catch (e: Exception) {
        null
    }

    /** Registers a listener so late token refreshes keep [childUid] fresh. */
    fun observeAuthState() {
        firebaseAuth.addAuthStateListener { auth -> publish(auth.currentUser) }
    }

    /** Signs out (used by "unpair" in Settings). Anonymous data stays server-side until rules/TTL purge it. */
    fun signOut() {
        firebaseAuth.signOut()
        publish(null)
    }

    private fun publish(user: FirebaseUser?) {
        _childUid.value = user?.uid
        _signedIn.value = user != null
    }
}
