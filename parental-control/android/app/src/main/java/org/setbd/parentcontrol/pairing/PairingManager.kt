package org.setbd.parentcontrol.pairing

import android.content.Context
import android.os.Build
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseNetworkException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.setbd.parentcontrol.auth.AuthRepository
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.net.SecureApi
import org.setbd.parentcontrol.net.SecureApiException
import org.setbd.parentcontrol.security.AuditLogger

/** Lifecycle of the pairing flow as rendered by [PairingScreen]. */
sealed class PairingState {
    /** Waiting for the child to type the code generated on the dashboard. */
    data object Idle : PairingState()
    /** Contacting the server to confirm the entered code. */
    data object Confirming : PairingState()
    /** Server confirmed; device claims + profile are set. */
    data object Approved : PairingState()
    data class Failed(val message: String) : PairingState()
}

/**
 * Secure pairing, SERVER-SIDE contract (v2):
 *
 *   1. PARENT dashboard → `generatePairingCode` on the trusted backend →
 *      server writes `pairingCodes/{code}` (5-min TTL, single-use). Clients
 *      can NEVER read or write pairingCodes (firestore.rules deny all) —
 *      the code itself is the only shared secret.
 *   2. CHILD device (this class) → signs in anonymously → calls
 *      `confirmPairing(code, deviceId, deviceName)` on the trusted backend →
 *      the SERVER atomically creates devices/{deviceId} + parents link +
 *      children/{uid}, marks the code used, and sets custom claims
 *      {deviceRole: "childDevice", deviceId}.
 *   3. We force a token refresh to pick the claims up, flip the local
 *      `paired` flag and hand control to [ServiceLocator.onPaired].
 *
 * SAFETY: device identity is the stored random UUID deviceId — never the IMEI.
 * The code grants nothing without a verified device identity + server-side
 * TTL/single-use checks; takeover protection lives in confirmPairing.
 */
class PairingManager(
    context: Context,
    private val auth: AuthRepository,
    private val auditLogger: AuditLogger,
) {
    constructor(context: Context) : this(
        context,
        ServiceLocator.auth,
        ServiceLocator.auditLogger,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow<PairingState>(PairingState.Idle)
    val state: StateFlow<PairingState> = _state

    val isPaired: Boolean get() = ServiceLocator.secureStore.isPaired()

    /**
     * Confirms the code the parent read out from the dashboard.
     * Safe to call repeatedly (state machine resets each attempt).
     */
    fun submitCode(rawCode: String) {
        // Uppercase + strip separators/spaces: parents read codes aloud.
        val code = rawCode.uppercase().filter { it.isLetterOrDigit() }
        if (code.length != CODE_LENGTH || !code.all { it in CODE_ALPHABET }) {
            _state.value = PairingState.Failed(
                "Enter the 8-character code from the parent dashboard (no 0/O/1/I). " +
                    "/ ড্যাশবোর্ডের ৮-অক্ষরের কোডটি লিখুন।"
            )
            return
        }

        _state.value = PairingState.Confirming
        scope.launch {
            when (val signIn = auth.ensureSignedInDetailed()) {
                is AuthRepository.SignInResult.Failure -> {
                    _state.value = PairingState.Failed(
                        "Sign-in failed — ${signIn.userMessage}"
                    )
                }
                is AuthRepository.SignInResult.Success -> {
                    try {
                        val result = SecureApi.call(
                            "confirmPairing",
                            mapOf(
                                "code" to code,
                                "deviceId" to ServiceLocator.deviceId,
                                "deviceName" to deviceName(),
                            )
                        )

                        // Pick up {deviceRole, deviceId} custom claims NOW —
                        // rules deny device telemetry until the fresh token.
                        auth.refreshIdToken()

                        val parentUid = result["parentUid"] as? String
                        ServiceLocator.secureStore.setPaired(true)
                        auditLogger.log(
                            actorUid = auth.childUid.value,
                            action = AuditLogger.ACTION_PAIRING_APPROVED,
                            result = "ALLOWED",
                            details = mapOf("parentUid" to parentUid),
                        )
                        _state.value = PairingState.Approved
                        ServiceLocator.onPaired()
                    } catch (e: Exception) {
                        _state.value = PairingState.Failed(describeError(e))
                    }
                }
            }
        }
    }

    /** Resets to the input state (child pressed back/retry). */
    fun cancelPairing() {
        _state.value = PairingState.Idle
    }

    /**
     * Unpair (Settings): clears the local pairing and asks the server side to
     * flip the device doc (best-effort — the identity delete trigger is the
     * authoritative cleanup when the child account is removed).
     */
    fun unpair() {
        val deviceId = ServiceLocator.deviceId
        ServiceLocator.secureStore.setPaired(false)
        scope.launch {
            runCatching {
                ServiceLocator.policyRepository.stop()
            }
            auditLogger.log(
                actorUid = auth.childUid.value,
                action = AuditLogger.ACTION_UNPAIRED,
                result = "INFO",
                details = mapOf("by" to "child"),
            )
            auth.signOut()
        }
    }

    /** Re-reads the paired flag after process death (used by MainActivity). */
    fun refreshPairedFlag() {
        // Cheap consistency probe against the server so a stale local flag
        // (e.g. parent revoked pairing) doesn't keep the app in dashboard mode.
        scope.launch {
            try {
                val doc = com.google.firebase.firestore.FirebaseFirestore.getInstance()
                    .collection("devices")
                    .document(ServiceLocator.deviceId)
                    .get(com.google.firebase.firestore.Source.SERVER)
                    .await()
                if (doc.exists() && doc.getBoolean("paired") != true &&
                    doc.getString("status") == "UNPAIRED"
                ) {
                    ServiceLocator.secureStore.setPaired(false)
                }
            } catch (_: Exception) { /* offline: keep local flag */ }
        }
    }

    private fun deviceName(): String =
        "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(64)

    /** Transport/API errors → actionable message (never raw stack traces). */
    private fun describeError(e: Exception): String {
        if (e is FirebaseNetworkException || e is java.io.IOException) {
            return "No internet connection. Connect and try again. / ইন্টারনেট সংযোগ নেই — আবার চেষ্টা করুন।"
        }
        if (e is SecureApiException) {
            return when (e.code) {
                "not-found" ->
                    "Invalid code — check it on the dashboard and try again. / কোড ভুল — ড্যাশবোর্ড মিলিয়ে আবার লিখুন।"
                "failed-precondition" ->
                    e.message ?: "This code has expired or was already used. / কোডের মেয়াদ শেষ বা ব্যবহৃত।"
                "permission-denied" ->
                    e.message ?: "Not allowed to pair this device. / এই ডিভাইস পেয়ার করা যাচ্ছে না।"
                "already-exists" ->
                    "This device is already paired to another family. Unpair first or contact your parent. / ডিভাইসটি আগে থেকেই পেয়ারড।"
                "resource-exhausted" ->
                    e.message ?: "Too many attempts. Please wait. / অনেকবার চেষ্টা — একটু অপেক্ষা করুন।"
                "unauthenticated" ->
                    "Sign-in expired. Try again. / সাইন-ইন শেষ — আবার চেষ্টা করুন।"
                "unavailable" ->
                    e.message ?: "Server unreachable. Try again later. / সার্ভারে পৌঁছানো যাচ্ছে না — পরে চেষ্টা করুন।"
                else ->
                    e.message ?: "Pairing failed. Try again. / পেয়ারিং ব্যর্থ — আবার চেষ্টা করুন।"
            }
        }
        if (e is FirebaseException) {
            return "Pairing failed: ${e.message ?: "unknown error"}. Try again. / পেয়ারিং ব্যর্থ — আবার চেষ্টা করুন।"
        }
        return "Pairing failed: ${e.javaClass.simpleName}. Try again. / পেয়ারিং ব্যর্থ — আবার চেষ্টা করুন।"
    }

    private companion object {
        const val CODE_LENGTH = 8
        /** Mirror of the server alphabet (no 0/O/1/I). */
        const val CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        const val TAG = "PairingManager"
    }
}
