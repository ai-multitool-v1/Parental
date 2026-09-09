package org.setbd.parentcontrol

import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.notifications.NotificationChannels
import org.setbd.parentcontrol.notifications.TokenRefresher
import org.setbd.parentcontrol.pairing.PairingScreen
import org.setbd.parentcontrol.pairing.PairingState
import org.setbd.parentcontrol.pairing.PairingViewModel
import org.setbd.parentcontrol.reliability.ReliabilityHelper
import org.setbd.parentcontrol.security.PermissionReporter
import org.setbd.parentcontrol.ui.ConsentDialog
import org.setbd.parentcontrol.ui.MainScreen
import org.setbd.parentcontrol.ui.SafetyCheckDialog
import org.setbd.parentcontrol.ui.SettingsScreen
import org.setbd.parentcontrol.ui.SplashCreditsOverlay
import org.setbd.parentcontrol.ui.theme.FamilySafetyTheme
import kotlinx.coroutines.launch

/**
 * Single-activity Compose app.
 *
 * Hosts: Onboarding/Pairing → Main dashboard → Settings, plus the global
 * overlays that make our consent model visible:
 *  * [ConsentDialog] — Allow/Decline for screen/camera/mic requests,
 *  * [SafetyCheckDialog] — "Are you OK?" answer UI,
 *  * the system MediaProjection dialog, launched here because only an
 *    Activity can launch it (result is routed back to the screen-share flow).
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Foreground services (location etc.) may hand us intents with extras.
        handleExtras(intent)

        setContent {
            FamilySafetyTheme {
                // v1.2.0: splash screen with developer credits — shows once per
                // app start, tap-through overlay above the active route.
                var splashShowing by remember { mutableStateOf(true) }
                Box(modifier = Modifier) {
                    FamilySafetyApp(
                        startOnPaired = ServiceLocator.secureStore.isPaired(),
                        bedtimeRequested = intent?.getBooleanExtra(EXTRA_BEDTIME_ACTIVE, false) ?: false,
                    )
                    if (splashShowing) {
                        SplashCreditsOverlay(onFinished = { splashShowing = false })
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleExtras(intent)
        setIntent(intent)
    }

    /** Routes service/notification extras into shared app state. */
    private fun handleExtras(intent: Intent?) {
        intent ?: return
        if (intent.getBooleanExtra(EXTRA_BEDTIME_ACTIVE, false)) {
            ServiceLocator.appState.setBedtimeActive(true)
        }
        intent.getStringExtra(EXTRA_SAFETY_CHECK)?.let {
            ServiceLocator.appState.showSafetyCheck(it)
        }
    }

    companion object {
        const val EXTRA_BEDTIME_ACTIVE = "org.setbd.parentcontrol.extra.BEDTIME_ACTIVE"
        const val EXTRA_SAFETY_CHECK = "org.setbd.parentcontrol.extra.SAFETY_CHECK"
    }
}

@Composable
private fun FamilySafetyApp(startOnPaired: Boolean, bedtimeRequested: Boolean) {
    val navController = rememberNavController()
    val context = LocalContext.current
    val appState = ServiceLocator.appState

    // ---------------- one-time app-start housekeeping ----------------
    LaunchedEffect(Unit) {
        NotificationChannels.ensureAll(context)
        if (startOnPaired) {
            ServiceLocator.onPaired()
            ServiceLocator.deviceStatusMonitor.enqueueImmediateHeartbeat()
            TokenRefresher.refresh(context)
            PermissionReporter(context).report()
            ServiceLocator.policyRepository.refreshNow() // offline cache fallback path
        }
        if (bedtimeRequested) appState.setBedtimeActive(true)
    }

    // ---- POST_NOTIFICATIONS runtime request (Android 13+), user visible ----
    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _ ->
        // Result only feeds the permission dashboard; we never nag repeatedly.
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            ServiceLocator.permissionReporter.report()
        }
    }
    LaunchedEffect(Unit) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notifLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // ---- system MediaProjection dialog (only an Activity may launch it) ----
    val projectionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val req = pendingProjectionRequest
        pendingProjectionRequest = null
        req?.onResult(result.resultCode, result.data)
    }
    LaunchedEffect(Unit) {
        appState.projectionRequests.collect { req ->
            pendingProjectionRequest = req
            val pm = context.getSystemService(MediaProjectionManager::class.java)
            // The child just tapped Allow — launching the system dialog now is
            // both expected and foreground-legal.
            projectionLauncher.launch(pm.createScreenCaptureIntent())
        }
    }

    // ------------------------------ overlays -------------------------------
    val pendingConsent by appState.pendingConsent.collectAsState()
    val safetyCheckId by appState.safetyCheckCommandId.collectAsState()

    pendingConsent?.let { request ->
        ConsentDialog(
            request = request,
            onRespond = { allowed ->
                ServiceLocator.commandProcessor.onConsentResponse(request, allowed)
            },
        )
    }

    safetyCheckId?.let { commandId ->
        SafetyCheckDialog(
            onAnswer = { response ->
                ServiceLocator.emergencyManager.answerSafetyCheck(commandId, response, null)
            },
        )
    }

    // ---------------------------- navigation -------------------------------
    NavHost(navController = navController, startDestination = if (startOnPaired) "main" else "onboarding") {
        composable("onboarding") {
            OnboardingRoute(
                onPaired = {
                    ServiceLocator.onPaired()
                    navController.navigate("main") { popUpTo("onboarding") { inclusive = true } }
                },
            )
        }
        composable("main") {
            MainScreen(
                onOpenSettings = { navController.navigate("settings") },
            )
        }
        composable("settings") {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onUnpaired = {
                    navController.navigate("onboarding") { popUpTo(0) { inclusive = true } }
                },
            )
        }
    }
}

/** Holder for the projection request while the system dialog is on screen. */
private var pendingProjectionRequest: org.setbd.parentcontrol.di.ProjectionRequest? = null

/** Onboarding = welcome + auth + pairing; calls back once pairing completes. */
@Composable
private fun OnboardingRoute(onPaired: () -> Unit) {
    val viewModel = remember { PairingViewModel(ServiceLocator.pairing) }
    val state by viewModel.state.collectAsState()
    LaunchedEffect(state) {
        if (state is PairingState.Approved) onPaired()
    }
    org.setbd.parentcontrol.ui.OnboardingScreen(
        pairingContent = { PairingScreen(viewModel) },
    )
}
