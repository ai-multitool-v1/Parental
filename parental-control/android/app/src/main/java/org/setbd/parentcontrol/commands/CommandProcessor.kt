package org.setbd.parentcontrol.commands

import org.setbd.parentcontrol.util.startFgServiceCompat
import android.content.Context
import org.setbd.parentcontrol.di.ConsentRequest
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.di.SessionType
import org.setbd.parentcontrol.location.LocationService
import org.setbd.parentcontrol.management.EnforcementResult
import org.setbd.parentcontrol.net.SecureApi
import org.setbd.parentcontrol.notifications.ParentNotification
import org.setbd.parentcontrol.security.AuditLogger
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.Timestamp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

/** The ONLY command types the child will ever execute. Anything else is rejected. */
object CommandTypes {
    const val SYNC_POLICY = "SYNC_POLICY"
    const val REQUEST_STATUS = "REQUEST_STATUS"
    const val REQUEST_LOCATION = "REQUEST_LOCATION"
    const val LOCK_DEVICE = "LOCK_DEVICE"
    const val SEND_NOTIFICATION = "SEND_NOTIFICATION"
    const val SYNC_APPS = "SYNC_APPS"
    const val SYNC_USAGE = "SYNC_USAGE"
    const val REQUEST_SCREEN_SESSION = "REQUEST_SCREEN_SESSION"
    const val STOP_SCREEN_SESSION = "STOP_SCREEN_SESSION"
    const val REQUEST_CAMERA_SESSION = "REQUEST_CAMERA_SESSION"
    const val STOP_CAMERA_SESSION = "STOP_CAMERA_SESSION"
    const val REQUEST_AUDIO_SESSION = "REQUEST_AUDIO_SESSION"
    const val STOP_AUDIO_SESSION = "STOP_AUDIO_SESSION"
    const val TRIGGER_SAFETY_CHECK = "TRIGGER_SAFETY_CHECK"
    const val REQUEST_PERMISSION = "REQUEST_PERMISSION"

    val WHITELIST: Set<String> = setOf(
        SYNC_POLICY, REQUEST_STATUS, REQUEST_LOCATION, LOCK_DEVICE, SEND_NOTIFICATION,
        SYNC_APPS, SYNC_USAGE, REQUEST_SCREEN_SESSION, STOP_SCREEN_SESSION,
        REQUEST_CAMERA_SESSION, STOP_CAMERA_SESSION, REQUEST_AUDIO_SESSION,
        STOP_AUDIO_SESSION, TRIGGER_SAFETY_CHECK, REQUEST_PERMISSION,
    )
}

/** Terminal status written to `devices/{deviceId}/commandResults/{commandId}`. */
enum class CommandResultStatus {
    EXECUTED,                 // ran successfully
    PENDING_USER_CONSENT,     // session request waiting for the child's Allow/Decline
    USER_ACCEPTED,            // child tapped Allow (follow-up result)
    USER_DECLINED,            // child tapped Decline (follow-up result)
    REJECTED,                 // failed a security check (auth, TTL, replay, authorization)
    UNSUPPORTED,              // device/admin state cannot support it — never bypassed
    FAILED,                   // execution error
}

/**
 * CORE command pipeline for the child device.
 *
 * Security gates, applied to EVERY incoming command, in order:
 *  1. **Authenticated** — the app must hold a Firebase session (childUid).
 *  2. **Device match** — the command's deviceId must equal this device's
 *     stored UUID deviceId (never IMEI).
 *  3. **Whitelist** — unknown command types are rejected outright.
 *  4. **TTL** — `expiresAt` must be in the future.
 *  5. **Parent authorization** — `devices/{deviceId}/parents/{issuedBy}` must
 *     exist; a random uid cannot command this device.
 *  6. **Replay protection** — locally processed commandIds (encrypted prefs,
 *     bounded set) AND existence of `commandResults/{commandId}` both short-
 *     circuit duplicate/replayed delivery (Firestore listener + FCM can race).
 *  7. **Consent gates** — camera/mic/screen REQUEST_* commands never execute
 *     directly; they surface a visible ConsentDialog and only continue after
 *     the child taps Allow (plus the system MediaProjection dialog for screen).
 *
 * Every command terminates with a result document and an audit-log entry.
 */
class CommandProcessor(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val processing = Mutex()

    /** Wires the Firestore listener; called from ServiceLocator.onPaired(). */
    fun start() {
        CommandListener.start()
    }

    /**
     * Entry point for both the Firestore snapshot listener and the FCM data
     * fast path. Safe to call concurrently / repeatedly for the same id.
     */
    fun enqueue(commandId: String, data: Map<String, Any?>) {
        scope.launch { processIncoming(commandId, data) }
    }

    /**
     * FCM fast path: the push data carries only {kind, commandId, type,
     * payload(JSON), expiresAtMs} — NOT the full command map the security
     * gates need. So we fetch the authoritative Firestore command doc and
     * run it through the same pipeline (all gates still enforced).
     */
    fun wakeFromFcm(commandId: String) {
        scope.launch {
            val status = runCatching {
                val doc = firestore.collection("devices")
                    .document(ServiceLocator.deviceId)
                    .collection("commands")
                    .document(commandId)
                    .get()
                    .await()
                if (!doc.exists()) null
                else processIncoming(doc.id, doc.data ?: emptyMap())
            }.getOrNull()
            if (status == null) {
                ServiceLocator.auditLogger.log(
                    actorUid = ServiceLocator.auth.childUid.value,
                    action = AuditLogger.ACTION_COMMAND_REJECTED,
                    result = "FCM wake: command $commandId not found/unreachable",
                )
            }
        }
    }

    suspend fun processIncoming(commandId: String, data: Map<String, Any?>): CommandResultStatus {
        return processing.withLock {
            // ---- 1) authenticated ---------------------------------------
            val childUid = ServiceLocator.auth.childUid.value
                ?: return@withLock reject(commandId, "UNKNOWN", "not_signed_in", CommandResultStatus.REJECTED)

            // ---- 2) deviceId match (MANDATORY) ---------------------------
            // A command that does not explicitly name THIS device is rejected
            // — absence of the field must never fall through on trust.
            val commandDeviceId = data["deviceId"] as? String
            if (commandDeviceId == null || commandDeviceId != ServiceLocator.deviceId) {
                return@withLock reject(commandId, "UNKNOWN", "deviceId_missing_or_mismatch", CommandResultStatus.REJECTED)
            }

            // ---- 3) whitelist --------------------------------------------
            val type = data["type"] as? String
            if (type == null || type !in CommandTypes.WHITELIST) {
                return@withLock reject(commandId, type ?: "UNKNOWN", "type_not_whitelisted", CommandResultStatus.REJECTED)
            }

            // ---- 4) TTL (MANDATORY) ---------------------------------------
            // Every legitimate command carries a server-issued expiresAt
            // (lib/commands.ts: +5 min). A MISSING expiry must fail closed —
            // it can never again default to Long.MAX_VALUE (that would let a
            // crafted or replayed push bypass aging entirely).
            val expiresAtMs = when (val raw = data["expiresAt"]) {
                is Timestamp -> raw.toDate().time
                is Number -> raw.toLong()
                else -> null // missing / malformed → rejected below
            }
            if (expiresAtMs == null || System.currentTimeMillis() > expiresAtMs) {
                return@withLock reject(commandId, type, "command_expired_or_missing_ttl", CommandResultStatus.REJECTED)
            }

            // ---- 5) replay protection -------------------------------------
            if (ServiceLocator.secureStore.getProcessedCommandIds().contains(commandId)) {
                return@withLock CommandResultStatus.EXECUTED // already handled earlier
            }
            val alreadyHasResult = try {
                firestore.collection("devices").document(ServiceLocator.deviceId)
                    .collection("commandResults").document(commandId).get().await().exists()
            } catch (e: Exception) {
                false // offline: local cache above still protects us
            }
            if (alreadyHasResult) {
                ServiceLocator.secureStore.rememberProcessedCommandId(commandId)
                return@withLock CommandResultStatus.EXECUTED
            }

            // ---- 6) parent authorization ----------------------------------
            // The Worker historically wrote the parent uid as "createdBy"
            // while the legacy Cloud Functions shape used "issuedBy"/
            // "parentUid" — a doc carrying only "createdBy" was rejected as
            // missing_issuedBy and auto-declined EVERY parent action. Accept
            // all three spellings (Worker now writes issuedBy + createdBy).
            val issuedBy = (data["issuedBy"] as? String)
                ?: (data["parentUid"] as? String)
                ?: (data["createdBy"] as? String)
                ?: return@withLock reject(commandId, type, "missing_issuedBy", CommandResultStatus.REJECTED)
            val authorized = try {
                firestore.collection("devices").document(ServiceLocator.deviceId)
                    .collection("parents").document(issuedBy).get().await().exists()
            } catch (e: Exception) {
                false
            }
            if (!authorized) {
                return@withLock reject(commandId, type, "parent_not_authorized:$issuedBy", CommandResultStatus.REJECTED)
            }

            // Claim locally BEFORE executing (crash-safe: Firestore result may
            // be missing, but the local claim prevents most double-execution).
            ServiceLocator.secureStore.rememberProcessedCommandId(commandId)

            val payload = (data["payload"] as? Map<String, Any?>) ?: emptyMap()

            // ---- 7) dispatch ----------------------------------------------
            val (status, message) = try {
                execute(type, issuedBy, commandId, payload)
            } catch (t: Throwable) {
                CommandResultStatus.FAILED to (t.message ?: "exception")
            }

            writeResult(commandId, type, status, message, issuedBy)
            val auditAction = when (status) {
                CommandResultStatus.UNSUPPORTED -> AuditLogger.ACTION_COMMAND_UNSUPPORTED
                CommandResultStatus.REJECTED -> AuditLogger.ACTION_COMMAND_REJECTED
                else -> AuditLogger.ACTION_COMMAND_EXECUTED
            }
            ServiceLocator.auditLogger.log(
                actorUid = issuedBy,
                action = auditAction,
                result = "$type -> $status: $message",
            )
            status
        }
    }

    // ------------------------------------------------------------------ exec --

    private suspend fun execute(
        type: String,
        issuedBy: String,
        commandId: String,
        payload: Map<String, Any?>,
    ): Pair<CommandResultStatus, String> = when (type) {
        CommandTypes.SYNC_POLICY ->
            if (ServiceLocator.policyRepository.refreshNow()) EXECUTED("policy refreshed")
            else FAILED("policy doc missing or unreachable")

        CommandTypes.REQUEST_STATUS -> {
            ServiceLocator.deviceStatusMonitor.runHeartbeatNow("REQUEST_STATUS")
            EXECUTED("status updated")
        }

        CommandTypes.REQUEST_LOCATION -> {
            val repo = ServiceLocator.locationRepository
            if (!repo.hasFineLocation()) {
                UNSUPPORTED("location permission not granted by child")
            } else if (payload["live"] == true) {
                // Foreground service of type location; visible notification.
                context.startFgServiceCompat(LocationService.startIntent(context))
                EXECUTED("live location started")
            } else {
                if (repo.writeSingleFix("REQUEST_LOCATION")) EXECUTED("one-shot location written")
                else FAILED("no fix available (provider/gps off)")
            }
        }

        CommandTypes.LOCK_DEVICE -> when (val r = ServiceLocator.devicePolicyWrapper.lockNow(issuedBy)) {
            EnforcementResult.Supported -> EXECUTED("screen locked")
            EnforcementResult.UnsupportedNotAdmin ->
                UNSUPPORTED("device not enrolled as admin/owner — remote lock unavailable")
            is EnforcementResult.Failed -> FAILED("lock failed: ${r.message}")
        }

        CommandTypes.SEND_NOTIFICATION -> {
            val title = (payload["title"] as? String).orEmpty().ifBlank {
                context.getString(org.setbd.parentcontrol.R.string.notif_parent_message_title)
            }
            val body = (payload["body"] as? String) ?: ""
            val shown = ParentNotification.showParentMessage(context, title, body, issuedBy)
            if (shown) EXECUTED("notification shown") else UNSUPPORTED("POST_NOTIFICATIONS not granted")
        }

        CommandTypes.SYNC_APPS -> {
            val n = ServiceLocator.installedAppsRepository.syncInstalledApps()
            EXECUTED("synced $n apps")
        }

        CommandTypes.SYNC_USAGE ->
            if (ServiceLocator.usageStatsRepository.syncUsageNow()) EXECUTED("usage synced")
            else UNSUPPORTED("usage access not granted (Apps with usage access)")

        CommandTypes.REQUEST_SCREEN_SESSION -> requestSession(type, commandId, issuedBy, payload, SessionType.SCREEN)
        CommandTypes.REQUEST_CAMERA_SESSION -> requestSession(type, commandId, issuedBy, payload, SessionType.CAMERA)
        CommandTypes.REQUEST_AUDIO_SESSION -> requestSession(type, commandId, issuedBy, payload, SessionType.AUDIO)

        CommandTypes.STOP_SCREEN_SESSION -> stopSession(payload) {
            ServiceLocator.screenShareManager.stopSession(payload["sessionId"] as? String)
        }
        CommandTypes.STOP_CAMERA_SESSION -> stopSession(payload) {
            ServiceLocator.cameraSessionManager.stopSession()
        }
        CommandTypes.STOP_AUDIO_SESSION -> stopSession(payload) {
            ServiceLocator.microphoneSessionManager.stopSession()
        }

        CommandTypes.TRIGGER_SAFETY_CHECK -> {
            ServiceLocator.emergencyManager.showSafetyCheckPrompt(commandId, issuedBy)
            EXECUTED("safety check shown to child")
        }

        CommandTypes.REQUEST_PERMISSION -> {
            val permission = (payload["permission"] as? String).orEmpty()
            val shown = org.setbd.parentcontrol.security.PermissionRequestActivity.show(context, permission)
            if (shown) EXECUTED("permission request notification shown: $permission")
            else UNSUPPORTED("notifications disabled — child cannot be prompted; ask on the device")
        }

        else -> REJECTED("unknown command type") // unreachable: whitelist above
    }

    /**
     * Session requests NEVER start media directly: they raise a visible
     * [ConsentRequest] (MainScreen renders the ConsentDialog). The follow-up
     * result (USER_ACCEPTED / USER_DECLINED) is written by [onConsentResponse].
     */
    private fun requestSession(
        type: String,
        commandId: String,
        issuedBy: String,
        payload: Map<String, Any?>,
        sessionType: SessionType,
    ): Pair<CommandResultStatus, String> {
        val sessionId = (payload["sessionId"] as? String) ?: commandId
        if (ServiceLocator.appState.isSessionActive(sessionId)) {
            return EXECUTED("session already active")
        }
        ServiceLocator.appState.showConsent(
            ConsentRequest(
                commandId = commandId,
                sessionId = sessionId,
                type = sessionType,
                requestedByUid = issuedBy,
                requestedByName = (payload["parentName"] as? String) ?: "Your parent",
            ),
        )
        return PENDING
    }

    private inline fun stopSession(
        payload: Map<String, Any?>,
        stop: () -> Unit,
    ): Pair<CommandResultStatus, String> {
        stop()
        return EXECUTED("session stopped")
    }

    // ------------------------------------------------------- consent follow-up --

    /**
     * Called by the UI when the child answers the ConsentDialog for a media
     * session. Writes the follow-up commandResult + audit entry and starts the
     * requested session ONLY on Allow.
     */
    fun onConsentResponse(request: ConsentRequest, allowed: Boolean) {
        scope.launch {
            ServiceLocator.appState.clearConsent(request.commandId)
            // Map the session type back to the canonical command type name.
            val commandType = when (request.type) {
                SessionType.SCREEN -> CommandTypes.REQUEST_SCREEN_SESSION
                SessionType.CAMERA -> CommandTypes.REQUEST_CAMERA_SESSION
                SessionType.AUDIO -> CommandTypes.REQUEST_AUDIO_SESSION
                SessionType.LOCATION -> "REQUEST_LOCATION"
            }
            writeResult(
                commandId = request.commandId,
                type = commandType,
                status = if (allowed) CommandResultStatus.USER_ACCEPTED else CommandResultStatus.USER_DECLINED,
                message = if (allowed) "child allowed session" else "child declined session",
                issuedBy = request.requestedByUid,
            )
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = if (allowed) AuditLogger.ACTION_CONSENT_GRANTED else AuditLogger.ACTION_CONSENT_DENIED,
                result = "${request.type.name} session=${request.sessionId}",
            )

            if (allowed) {
                when (request.type) {
                    SessionType.SCREEN ->
                        ServiceLocator.screenShareManager.onConsentGranted(request)
                    SessionType.CAMERA ->
                        ServiceLocator.cameraSessionManager.onConsentGranted(request)
                    SessionType.AUDIO ->
                        ServiceLocator.microphoneSessionManager.onConsentGranted(request)
                    SessionType.LOCATION -> Unit // location consent is permission-based, not command-based
                }
            } else {
                // Declined: make sure nothing half-started remains.
                ServiceLocator.appState.sessionEnded(request.sessionId)
            }
        }
    }

    // ----------------------------------------------------------------- writes --

    /**
     * Public hook for session managers: when a consent-granted session cannot
     * actually start (e.g. the child never granted CAMERA permission), we
     * report UNSUPPORTED instead of pretending success.
     */
    fun postUnsupported(commandId: String, type: String, message: String) {
        scope.launch {
            writeResult(commandId, type, CommandResultStatus.UNSUPPORTED, message, issuedBy = null)
            ServiceLocator.auditLogger.log(
                actorUid = ServiceLocator.auth.childUid.value,
                action = AuditLogger.ACTION_COMMAND_UNSUPPORTED,
                result = "$type -> $message",
            )
        }
    }

    private suspend fun reject(
        commandId: String,
        type: String,
        message: String,
        status: CommandResultStatus,
    ): CommandResultStatus {
        writeResult(commandId, type, status, message, issuedBy = null)
        ServiceLocator.auditLogger.log(
            actorUid = ServiceLocator.auth.childUid.value,
            action = AuditLogger.ACTION_COMMAND_REJECTED,
            result = "$type -> $message",
        )
        return status
    }

    private suspend fun writeResult(
        commandId: String,
        type: String,
        status: CommandResultStatus,
        message: String,
        issuedBy: String?,
    ) {
        runCatching {
            firestore.collection("devices").document(ServiceLocator.deviceId)
                .collection("commandResults").document(commandId)
                .set(
                    mapOf(
                        "commandId" to commandId,
                        "type" to type,
                        "status" to status.name,
                        "message" to message,
                        "issuedBy" to issuedBy,
                        "deviceId" to ServiceLocator.deviceId,
                        "processedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                    ),
                    SetOptions.merge(),
                ).await()
        }
        // Trusted-backend mirror (zero-cost deployment): without Cloud
        // Functions there is no result trigger, so the parent-facing command
        // doc + session consent state machine are driven by this explicit
        // call. Best-effort — the device-local trail above is already written.
        runCatching {
            SecureApi.call(
                "commandResult",
                mapOf(
                    "commandId" to commandId,
                    "status" to status.name,
                    "result" to mapOf("message" to message),
                )
            )
        }
    }

    // Shorthand builders to keep `execute` readable.
    private fun EXECUTED(msg: String): Pair<CommandResultStatus, String> = CommandResultStatus.EXECUTED to msg
    private fun FAILED(msg: String): Pair<CommandResultStatus, String> = CommandResultStatus.FAILED to msg
    private fun UNSUPPORTED(msg: String): Pair<CommandResultStatus, String> = CommandResultStatus.UNSUPPORTED to msg
    private fun REJECTED(msg: String): Pair<CommandResultStatus, String> = CommandResultStatus.REJECTED to msg
    private val PENDING: Pair<CommandResultStatus, String> =
        CommandResultStatus.PENDING_USER_CONSENT to "waiting for child consent"
}
