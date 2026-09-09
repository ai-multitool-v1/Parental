package org.setbd.parentcontrol.di

import android.content.Context
import org.setbd.parentcontrol.apps.InstalledAppsRepository
import org.setbd.parentcontrol.auth.AuthRepository
import org.setbd.parentcontrol.backup.BackupItemRepository
import org.setbd.parentcontrol.backup.BackupKeyManager
import org.setbd.parentcontrol.backup.BackupPolicyRepository
import org.setbd.parentcontrol.backup.MediaStoreObserver
import org.setbd.parentcontrol.backup.RestoreClient
import org.setbd.parentcontrol.camera.CameraSessionManager
import org.setbd.parentcontrol.commands.CommandProcessor
import org.setbd.parentcontrol.device.DeviceStatusMonitor
import org.setbd.parentcontrol.emergency.EmergencyManager
import org.setbd.parentcontrol.location.LocationRepository
import org.setbd.parentcontrol.management.DevicePolicyManagerWrapper
import org.setbd.parentcontrol.microphone.MicrophoneSessionManager
import org.setbd.parentcontrol.pairing.PairingManager
import org.setbd.parentcontrol.policies.PolicyRepository
import org.setbd.parentcontrol.screenshare.ScreenShareSessionManager
import org.setbd.parentcontrol.security.AuditLogger
import org.setbd.parentcontrol.security.PermissionReporter
import org.setbd.parentcontrol.security.SecureStore
import org.setbd.parentcontrol.usage.UsageStatsRepository
import org.setbd.parentcontrol.webrtc.WebRtcClient
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

// ============================================================================
// Shared UI-facing state models (Consent flows, active sessions, safety check)
// ============================================================================

/** Kind of consent-gated media session (LOCATION = live location sharing). */
enum class SessionType { SCREEN, CAMERA, AUDIO, LOCATION }

/**
 * A pending consent request raised by a parent command. Rendered by
 * [org.setbd.parentcontrol.ui.ConsentDialog]; nothing starts until the child
 * taps Allow (and, for screen sharing, additionally accepts the system
 * MediaProjection dialog).
 */
data class ConsentRequest(
    val commandId: String,
    val sessionId: String,
    val type: SessionType,
    val requestedByUid: String,
    val requestedByName: String,
    val createdAtMs: Long = System.currentTimeMillis(),
)

/** A currently active media session (drives the always-visible banner). */
data class ActiveSession(
    val sessionId: String,
    val type: SessionType,
    val startedAtMs: Long = System.currentTimeMillis(),
)

/** The child's answer to a TRIGGER_SAFETY_CHECK prompt. */
enum class SafetyCheckResponse { IM_OK, NEED_HELP }

// ============================================================================
// ServiceLocator — tiny manual DI container
// ============================================================================

/**
 * Manual dependency container (no Hilt by design: fewer moving parts, easy to
 * audit). Initialized once from [org.setbd.parentcontrol.FamilySafetyApp].
 *
 * All cross-component app state (pending consent, active sessions, pending
 * MediaProjection launches, safety check prompts) lives in [appState] so the
 * Compose UI can observe a single object.
 */
object ServiceLocator {

    private lateinit var appContext: Context

    /** Observable, consent-centric application state. */
    val appState: AppState = AppState()

    lateinit var secureStore: SecureStore
        private set
    lateinit var auditLogger: AuditLogger
        private set
    lateinit var auth: AuthRepository
        private set
    lateinit var pairing: PairingManager
        private set
    lateinit var policyRepository: PolicyRepository
        private set
    lateinit var deviceStatusMonitor: DeviceStatusMonitor
        private set
    lateinit var locationRepository: LocationRepository
        private set
    lateinit var usageStatsRepository: UsageStatsRepository
        private set
    lateinit var installedAppsRepository: InstalledAppsRepository
        private set
    lateinit var devicePolicyWrapper: DevicePolicyManagerWrapper
        private set
    lateinit var commandProcessor: CommandProcessor
        private set
    lateinit var emergencyManager: EmergencyManager
        private set
    lateinit var permissionReporter: PermissionReporter
        private set
    lateinit var screenShareManager: ScreenShareSessionManager
        private set
    lateinit var cameraSessionManager: CameraSessionManager
        private set
    lateinit var microphoneSessionManager: MicrophoneSessionManager
        private set
    lateinit var webRtcClient: WebRtcClient
        private set
    lateinit var backupPolicyRepository: BackupPolicyRepository
        private set
    lateinit var backupItems: BackupItemRepository
        private set
    lateinit var backupKeys: BackupKeyManager
        private set
    lateinit var restoreClient: RestoreClient
        private set
    private var mediaStoreObserver: MediaStoreObserver? = null

    /** Stable random deviceId (UUID) — never IMEI or other hardware identity. */
    val deviceId: String by lazy { secureStore.getOrCreateDeviceId() }

    fun init(context: Context) {
        if (this::secureStore.isInitialized) return
        appContext = context.applicationContext
        secureStore = SecureStore(appContext)
        auditLogger = AuditLogger(appContext)
        auth = AuthRepository(appContext)
        devicePolicyWrapper = DevicePolicyManagerWrapper(appContext)
        policyRepository = PolicyRepository(appContext)
        deviceStatusMonitor = DeviceStatusMonitor(appContext)
        locationRepository = LocationRepository(appContext)
        usageStatsRepository = UsageStatsRepository(appContext)
        installedAppsRepository = InstalledAppsRepository(appContext)
        permissionReporter = PermissionReporter(appContext)
        webRtcClient = WebRtcClient(appContext)
        screenShareManager = ScreenShareSessionManager(appContext)
        cameraSessionManager = CameraSessionManager(appContext)
        microphoneSessionManager = MicrophoneSessionManager(appContext)
        emergencyManager = EmergencyManager(appContext)
        pairing = PairingManager(appContext)
        commandProcessor = CommandProcessor(appContext)
        backupPolicyRepository = BackupPolicyRepository(appContext)
        backupItems = BackupItemRepository()
        backupKeys = BackupKeyManager()
        restoreClient = RestoreClient(appContext)
    }

    fun context(): Context = appContext

    /**
     * Called when the device becomes paired & the app is fully configured.
     * Starts the Firestore listeners and periodic WorkManager jobs.
     */
    fun onPaired() {
        commandProcessor.start()
        policyRepository.start()
        deviceStatusMonitor.schedulePeriodicHeartbeat()
        usageStatsRepository.schedulePeriodicSync()

        // v1.3.0 — backup pipeline: policy listener, observers, periodic
        // workers. The pipeline itself re-checks the triple gate (parent
        // policy + child consent + permission) before ANY content read.
        backupPolicyRepository.start()
        ensureBackupObservers()
        org.setbd.parentcontrol.backup.BackupScheduler.ensurePeriodic(appContext)
    }

    /**
     * Starts the ContentObservers when at least one backup category is
     * enabled+consented; stops them otherwise (graceful stop on revoke).
     * Called on pairing and after every policy/consent flip from the UI.
     */
    fun ensureBackupObservers() {
        val policy = backupPolicyRepository.policy.value
        if (policy.anyEnabled && secureStore.isPaired()) {
            if (mediaStoreObserver == null) mediaStoreObserver = MediaStoreObserver(appContext)
            mediaStoreObserver?.start()
        } else {
            mediaStoreObserver?.stop()
        }
    }
}

/**
 * Observable state shared between command processing, foreground services and
 * the Compose UI. Kept separate from [ServiceLocator] so UI code depends on a
 * minimal, clearly consent-focused surface.
 */
class AppState {

    /** Consent request currently waiting for the child's Allow/Decline. */
    private val _pendingConsent = MutableStateFlow<ConsentRequest?>(null)
    val pendingConsent: StateFlow<ConsentRequest?> = _pendingConsent.asStateFlow()

    /** Sessions that are actually streaming right now (banner + settings). */
    private val _activeSessions = MutableStateFlow<List<ActiveSession>>(emptyList())
    val activeSessions: StateFlow<List<ActiveSession>> = _activeSessions.asStateFlow()

    /**
     * One-shot events asking MainActivity to launch the system
     * MediaProjection consent dialog (must be launched from an Activity).
     * Carries (sessionId, resultCode/data consumer) pairs.
     */
    val projectionRequests = MutableSharedFlow<ProjectionRequest>(extraBufferCapacity = 1)

    /** TRIGGER_SAFETY_CHECK prompt awaiting a child response. */
    private val _safetyCheckCommandId = MutableStateFlow<String?>(null)
    val safetyCheckCommandId: StateFlow<String?> = _safetyCheckCommandId.asStateFlow()

    /** True while the bedtime window from the latest policy is active. */
    private val _bedtimeActive = MutableStateFlow(false)
    val bedtimeActive: StateFlow<Boolean> = _bedtimeActive.asStateFlow()

    /** Local connectivity/health flag mirrored from the heartbeat worker. */
    private val _connected = MutableStateFlow(true)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    fun showConsent(request: ConsentRequest) { _pendingConsent.value = request }
    fun clearConsent(commandId: String) {
        if (_pendingConsent.value?.commandId == commandId) _pendingConsent.value = null
    }

    fun sessionStarted(session: ActiveSession) {
        _activeSessions.value = _activeSessions.value + session
    }

    fun sessionEnded(sessionId: String) {
        _activeSessions.value = _activeSessions.value.filterNot { it.sessionId == sessionId }
    }

    fun isSessionActive(sessionId: String): Boolean =
        _activeSessions.value.any { it.sessionId == sessionId }

    fun showSafetyCheck(commandId: String) { _safetyCheckCommandId.value = commandId }
    fun clearSafetyCheck() { _safetyCheckCommandId.value = null }

    fun setBedtimeActive(active: Boolean) { _bedtimeActive.value = active }
    fun setConnected(up: Boolean) { _connected.value = up }
}

/** Payload for launching the system screen-capture consent from the Activity. */
data class ProjectionRequest(
    val sessionId: String,
    val onResult: (resultCode: Int, data: android.content.Intent?) -> Unit,
)
