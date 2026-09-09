package org.setbd.parentcontrol.pairing

import android.content.Context
import android.os.Build
import org.setbd.parentcontrol.BuildConfig
import org.setbd.parentcontrol.auth.AuthRepository
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.security.AuditLogger
import org.setbd.parentcontrol.security.CryptoUtil
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.Timestamp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/** Lifecycle of the pairing flow as rendered by [PairingScreen]. */
sealed class PairingState {
    data object Idle : PairingState()
    data object Generating : PairingState()
    data class WaitingForApproval(val code: String, val expiresAtMs: Long) : PairingState()
    data object Approved : PairingState()
    data object Expired : PairingState()
    data class Failed(val message: String) : PairingState()
}

/**
 * Secure, single-use, short-lived pairing between the child device and the
 * parent dashboard.
 *
 * Flow:
 *  1. Child generates a cryptographically random 8-char code
 *     ([CryptoUtil.generatePairingCode], [SecureRandom]).
 *  2. Code is stored at `pairingCodes/{code}` as
 *     `{deviceId, childUid, createdAt, expiresAt(+5 min), used:false}`.
 *  3. Parent types the code in the dashboard. The parent backend verifies TTL
 *     & single-use and writes `{approved:true, parentUid}` to the same doc and
 *     creates `devices/{deviceId}/parents/{parentUid}`.
 *  4. This class listens on the code doc; on approval it finalizes: marks the
 *     code `used:true`, upserts the `devices/{deviceId}` profile doc, flips
 *     the local `paired` flag and hands control to [ServiceLocator.onPaired].
 *
 * SAFETY: device identity is the stored random UUID deviceId — never the IMEI.
 * The code alone grants nothing: the parent side must authenticate and the
 * Firestore rules verify the childUid matches the code.
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

    private val firestore = FirebaseFirestore.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow<PairingState>(PairingState.Idle)
    val state: StateFlow<PairingState> = _state.asStateFlow()

    private var codeDoc: String? = null
    private var approvalListener: ListenerRegistration? = null

    val isPaired: Boolean get() = ServiceLocator.secureStore.isPaired()

    /**
     * Generates a fresh code and waits for parent approval.
     * Safe to call repeatedly (cancels any previous attempt first).
     */
    fun startPairing() {
        cancelPairing(clearState = false)
        _state.value = PairingState.Generating
        scope.launch {
            val childUid = auth.ensureSignedIn()
            if (childUid == null) {
                _state.value = PairingState.Failed("Sign-in failed — check internet and try again.")
                return@launch
            }
            try {
                val code = CryptoUtil.generatePairingCode()
                val expiresAt = Timestamp(System.currentTimeMillis() / 1000 + PAIRING_TTL_SECONDS, 0)
                firestore.collection(COLLECTION_PAIRING_CODES).document(code).set(
                    mapOf(
                        FIELD_DEVICE_ID to ServiceLocator.deviceId,
                        FIELD_CHILD_UID to childUid,
                        FIELD_CREATED_AT to FieldValue.serverTimestamp(),
                        FIELD_EXPIRES_AT to expiresAt,
                        FIELD_USED to false,
                        FIELD_MODEL to Build.MODEL,
                        FIELD_ANDROID_VERSION to Build.VERSION.RELEASE,
                        FIELD_APP_VERSION to BuildConfig.VERSION_NAME,
                    )
                ).await()

                codeDoc = code
                _state.value = PairingState.WaitingForApproval(
                    code = code,
                    expiresAtMs = System.currentTimeMillis() + PAIRING_TTL_SECONDS * 1000L,
                )
                listenForApproval(code)
                scheduleExpiryCheck(code)
            } catch (e: Exception) {
                _state.value = PairingState.Failed(e.message ?: "Pairing failed")
            }
        }
    }

    /** Listens for the parent writing `{approved:true, parentUid}` on the code doc. */
    private fun listenForApproval(code: String) {
        approvalListener = firestore.collection(COLLECTION_PAIRING_CODES).document(code)
            .addSnapshotListener { snapshot, error ->
                if (error != null) return@addSnapshotListener
                val data = snapshot?.data ?: return@addSnapshotListener
                val approved = data[FIELD_APPROVED] == true
                val parentUid = data[FIELD_PARENT_UID] as? String
                if (approved && !parentUid.isNullOrBlank()) {
                    scope.launch { finalizePairing(code, parentUid) }
                }
            }
    }

    /** Finalizes pairing after parent approval (marks code used, writes profile). */
    private suspend fun finalizePairing(code: String, parentUid: String) {
        try {
            // Transactionally flip used:false -> used:true so a stolen code
            // cannot be approved twice (single-use guarantee).
            val codeRef = firestore.collection(COLLECTION_PAIRING_CODES).document(code)
            firestore.runTransaction { tx ->
                val snap = tx.get(codeRef)
                if (snap.getBoolean(FIELD_USED) == true) {
                    // Already consumed elsewhere: abort silently; rules also guard this.
                    return@runTransaction null
                }
                tx.update(codeRef, mapOf(FIELD_USED to true, FIELD_APPROVED_BY to parentUid))
                null
            }.await()

            // Upsert the device profile doc the whole platform keys off.
            firestore.collection(COLLECTION_DEVICES).document(ServiceLocator.deviceId).set(
                mapOf(
                    FIELD_DEVICE_ID to ServiceLocator.deviceId,
                    FIELD_CHILD_UID to auth.childUid.value,
                    FIELD_MODEL to Build.MODEL,
                    FIELD_MANUFACTURER to Build.MANUFACTURER,
                    FIELD_ANDROID_VERSION to Build.VERSION.RELEASE,
                    FIELD_APP_VERSION to BuildConfig.VERSION_NAME,
                    FIELD_PAIRED to true,
                    FIELD_PAIRED_AT to FieldValue.serverTimestamp(),
                    FIELD_LAST_SEEN_AT to FieldValue.serverTimestamp(),
                ),
                com.google.firebase.firestore.SetOptions.merge(),
            ).await()

            ServiceLocator.secureStore.setPaired(true)
            auditLogger.log(
                actorUid = auth.childUid.value,
                action = AuditLogger.ACTION_PAIRING_APPROVED,
                result = "parentUid=$parentUid",
            )
            _state.value = PairingState.Approved
            ServiceLocator.onPaired()
        } catch (e: Exception) {
            _state.value = PairingState.Failed(e.message ?: "Pairing failed")
        }
    }

    /** Local TTL watchdog — flips to [PairingState.Expired] if nobody approves in 5 min. */
    private fun scheduleExpiryCheck(code: String) {
        scope.launch {
            delay(PAIRING_TTL_SECONDS * 1000L)
            if (_state.value is PairingState.WaitingForApproval) {
                _state.value = PairingState.Expired
                runCatching {
                    firestore.collection(COLLECTION_PAIRING_CODES).document(code).delete().await()
                }
                stopListening()
            }
        }
    }

    /** Cancels a pending code (child pressed cancel, or a new code is requested). */
    fun cancelPairing(clearState: Boolean = true) {
        stopListening()
        val code = codeDoc
        codeDoc = null
        if (code != null) {
            scope.launch {
                runCatching {
                    firestore.collection(COLLECTION_PAIRING_CODES).document(code).delete().await()
                }
            }
        }
        if (clearState) _state.value = PairingState.Idle
    }

    /**
     * Unpair (Settings): clears the local pairing, notifies the platform, and
     * signs out. The parent dashboard sees the device flip to unpaired.
     */
    fun unpair() {
        val deviceId = ServiceLocator.deviceId
        ServiceLocator.secureStore.setPaired(false)
        scope.launch {
            runCatching {
                firestore.collection(COLLECTION_DEVICES).document(deviceId).update(
                    mapOf(FIELD_PAIRED to false, FIELD_UNPAIRED_AT to FieldValue.serverTimestamp())
                ).await()
            }
            auditLogger.log(
                actorUid = auth.childUid.value,
                action = AuditLogger.ACTION_UNPAIRED,
                result = "by_child",
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
                val doc = firestore.collection(COLLECTION_DEVICES)
                    .document(ServiceLocator.deviceId)
                    .get(Source.SERVER)
                    .await()
                if (doc.exists() && doc.getBoolean(FIELD_PAIRED) != true) {
                    ServiceLocator.secureStore.setPaired(false)
                }
            } catch (_: Exception) { /* offline: keep local flag */ }
        }
    }

    private fun stopListening() {
        approvalListener?.remove()
        approvalListener = null
    }

    private companion object {
        const val COLLECTION_PAIRING_CODES = "pairingCodes"
        const val COLLECTION_DEVICES = "devices"
        const val FIELD_DEVICE_ID = "deviceId"
        const val FIELD_CHILD_UID = "childUid"
        const val FIELD_PARENT_UID = "parentUid"
        const val FIELD_APPROVED = "approved"
        const val FIELD_APPROVED_BY = "approvedBy"
        const val FIELD_CREATED_AT = "createdAt"
        const val FIELD_EXPIRES_AT = "expiresAt"
        const val FIELD_USED = "used"
        const val FIELD_MODEL = "model"
        const val FIELD_MANUFACTURER = "manufacturer"
        const val FIELD_ANDROID_VERSION = "androidVersion"
        const val FIELD_APP_VERSION = "appVersion"
        const val FIELD_PAIRED = "paired"
        const val FIELD_PAIRED_AT = "pairedAt"
        const val FIELD_LAST_SEEN_AT = "lastSeenAt"
        const val FIELD_UNPAIRED_AT = "unpairedAt"
        const val PAIRING_TTL_SECONDS = 5 * 60L
    }
}
