package org.setbd.parentcontrol.auth

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApiNotAvailableException
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.FirebaseAuthException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await

/**
 * Firebase Authentication for the CHILD profile.
 *
 * We sign the child device in **anonymously** (no personal data collected from
 * a minor), with an optional email/password fallback for families that prefer
 * a recoverable account. The resulting `childUid` is what the server keys on
 * after confirmPairing sets the {deviceRole, deviceId} custom claims.
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

    /** Outcome of a sign-in attempt with an actionable, user-safe message. */
    sealed class SignInResult {
        data class Success(val uid: String) : SignInResult()
        data class Failure(val userMessage: String) : SignInResult()
    }

    /**
     * Ensures a signed-in session with DETAILED failure reporting.
     *
     * The generic "check your internet connection" message hid real causes
     * (Anonymous provider disabled, placeholder google-services.json, missing
     * Play Services). These are surfaced distinctly here so the parent can
     * fix the actual problem in one glance.
     */
    suspend fun ensureSignedInDetailed(): SignInResult {
        firebaseAuth.currentUser?.let { user ->
            publish(user)
            return SignInResult.Success(user.uid)
        }
        return try {
            val result = firebaseAuth.signInAnonymously().await()
            val user = result.user
                ?: return SignInResult.Failure(
                    "Sign-in returned no user. Try again. / আবার চেষ্টা করুন।"
                )
            publish(user)
            SignInResult.Success(user.uid)
        } catch (e: Exception) {
            SignInResult.Failure(describeSignInError(e))
        }
    }

    /**
     * Ensures a signed-in session. Prefers the existing Firebase user, then
     * anonymous sign-in.
     *
     * @return the child uid, or null if sign-in failed (offline first run).
     */
    suspend fun ensureSignedIn(): String? = when (val r = ensureSignedInDetailed()) {
        is SignInResult.Success -> r.uid
        is SignInResult.Failure -> null
    }

    /** Human-readable, ACTIONABLE reason — never a raw stack trace. */
    private fun describeSignInError(e: Exception): String {
        // Play Services availability dominates on emulators / de-Googled ROMs.
        val gms = GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(context)
        if (gms != ConnectionResult.SUCCESS) {
            return when (gms) {
                ConnectionResult.SERVICE_MISSING,
                ConnectionResult.SERVICE_INVALID,
                -> "Google Play Services is missing on this device, so Firebase sign-in cannot work. Install/update Google Play Services. / এই ডিভাইসে Google Play Services নেই।"
                ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED,
                ConnectionResult.SERVICE_UPDATING,
                -> "Google Play Services needs an update before sign-in can work. / Google Play Services আপডেট করুন।"
                ConnectionResult.SERVICE_DISABLED ->
                    "Google Play Services is disabled. Enable it in Settings → Apps. / Google Play Services নিষ্ক্রিয়।"
                else ->
                    "Google Play Services is unavailable (error $gms), so Firebase sign-in cannot work. / Google Play Services পাওয়া যাচ্ছে না।"
            }
        }

        return when (e) {
            is FirebaseNetworkException ->
                "No internet connection. Connect to Wi-Fi or mobile data and try again. / ইন্টারনেট সংযোগ নেই — সংযোগ দিয়ে আবার চেষ্টা করুন।"
            is FirebaseApiNotAvailableException ->
                "Google Play Services component needed for sign-in is unavailable. Update Google Play Services. / Google Play Services আপডেট করুন।"
            is FirebaseAuthException -> when (e.errorCode) {
                "ERROR_OPERATION_NOT_ALLOWED" ->
                    "Sign-in is disabled for this Firebase project. In Firebase Console → Authentication → Sign-in method, enable the Anonymous provider. / Firebase Console-এ Anonymous sign-in চালু করুন।"
                "ERROR_TOO_MANY_REQUESTS" ->
                    "Too many attempts. Wait a few minutes and try again. / অনেকবার চেষ্টা হয়েছে — কিছুক্ষণ পরে চেষ্টা করুন।"
                else ->
                    if (e.message?.contains("api key", ignoreCase = true) == true ||
                        e.errorCode == "ERROR_INVALID_API_KEY"
                    ) {
                        "Firebase configuration is invalid (API key rejected). This build was not made with the project's real google-services.json. / Firebase config ভুল — সঠিক google-services.json দিয়ে বিল্ড করুন।"
                    } else {
                        "Sign-in rejected: ${e.errorCode}. / সাইন-ইন বাতিল হয়েছে।"
                    }
            }
            else ->
                if (e.message?.contains("FirebaseApp", ignoreCase = true) == true ||
                    e.message?.contains("DEFAULT", ignoreCase = true) == true
                ) {
                    "Firebase is not initialized — this build is missing a valid google-services.json. / সঠিক google-services.json নেই।"
                } else {
                    "Sign-in failed: ${e.javaClass.simpleName}. Try again. / সাইন-ইন ব্যর্থ — আবার চেষ্টা করুন।"
                }
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

    /** Force-refreshes the ID token (picks up deviceRole/deviceId claims). */
    suspend fun refreshIdToken() {
        runCatching { firebaseAuth.currentUser?.getIdToken(true)?.await() }
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
