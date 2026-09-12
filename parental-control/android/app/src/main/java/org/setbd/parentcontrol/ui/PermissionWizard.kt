package org.setbd.parentcontrol.ui

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.reliability.ReliabilityHelper

/**
 * v1.4.5 — POST-PAIRING PERMISSION WIZARD.
 *
 * WHY THIS EXISTS (the "child app e kono permission e ney na" bug): until
 * v1.4.5 the app only ever requested POST_NOTIFICATIONS. Fine location,
 * background location, camera, microphone, usage access, overlay, battery
 * exemption, device admin and accessibility were ALL opt-in via a Settings
 * screen the child was never directed to — so the child device effectively
 * ran with zero permissions and every parent action came back UNSUPPORTED
 * (location "no permission", lock "not admin", usage "not granted",
 * camera/mic sessions denied…).
 *
 * This wizard is shown ONCE right after pairing (and can be reopened from
 * Settings). For each permission it shows the real OS state and routes to the
 * exact system dialog/screen that grants it. Nothing is granted silently —
 * every step is the official, visible Android consent surface. The wizard can
 * be skipped; the Settings screen remains the full transparency dashboard.
 *
 * Boot-receiver note for support: RECEIVE_BOOT_COMPLETED is a normal install-
 * time permission — it never appears in App Info → Permissions. The wizard
 * lists it as an information row so nobody reports it "missing" again.
 */
@Composable
fun PermissionWizardScreen(
    onDone: () -> Unit,
    onSkip: () -> Unit,
) {
    val context = LocalContext.current
    val permissionState = remember { mutableStateMapOf<String, Boolean>() }

    // Live snapshot — re-sample right away and every 2 s so returning from a
    // system screen flips the row to "granted" immediately.
    LaunchedEffect(Unit) {
        while (true) {
            val snap = ServiceLocator.permissionReporter.snapshot()
            listOf(
                "locationFine", "locationBackground", "notifications", "camera",
                "microphone", "appUsageAccess", "batteryOptimizationIgnored",
                "deviceAdmin", "accessibilityService", "overlay",
            ).forEach { key -> permissionState[key] = snap[key] == true }
            delay(2_000)
        }
    }

    // Official runtime permission dialogs (location/camera/mic/notifications).
    val runtimeRequest = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* state refreshes via the live snapshot loop */ }

    /** Opens the exact system surface that grants [key]. */
    fun requestPermission(key: String) {
        runCatching {
            when (key) {
                "notifications" ->
                    if (Build.VERSION.SDK_INT >= 33) {
                        runtimeRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        ReliabilityHelper.openAppSettings(context)
                    }
                "locationFine" -> runtimeRequest.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                // Background location cannot be requested from the dialog on
                // Android 10+ — the honest route is the app's settings page.
                "locationBackground" -> context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                "camera" -> runtimeRequest.launch(Manifest.permission.CAMERA)
                "microphone" -> runtimeRequest.launch(Manifest.permission.RECORD_AUDIO)
                // v1.4.5 FIX: with PACKAGE_USAGE_STATS now declared in the
                // manifest, our own entry appears inside this list and the
                // child can finally grant it (previously the app was absent
                // from the list entirely).
                "appUsageAccess" -> context.startActivity(
                    Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                "overlay" -> context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:${context.packageName}"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                "batteryOptimizationIgnored" ->
                    ReliabilityHelper.requestIgnoreBatteryOptimizations(context)
                "deviceAdmin" -> context.startActivity(
                    Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                        putExtra(
                            DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                            ComponentName(
                                context,
                                org.setbd.parentcontrol.management.DeviceAdminReceiver::class.java,
                            ),
                        )
                        putExtra(
                            DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                            context.getString(R.string.settings_admin_explanation),
                        )
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    },
                )
                "accessibilityService" -> context.startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }

    val grantedCount = WIZARD_KEYS.count { permissionState[it] == true }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        Text(
            text = stringResource(R.string.wizard_title),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = stringResource(R.string.wizard_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            text = stringResource(R.string.wizard_progress, grantedCount, WIZARD_KEYS.size),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(12.dp))

        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(14.dp)) {
                WIZARD_KEYS.forEach { key -> WizardRow(key, permissionState[key]) { requestPermission(key) } }
                // Informational row — RECEIVE_BOOT_COMPLETED is normal
                // (install-time) and intentionally absent from App Info.
                Spacer(Modifier.height(6.dp))
                Text(
                    text = stringResource(R.string.wizard_boot_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(18.dp))
        Button(
            onClick = {
                ServiceLocator.secureStore.setPermissionWizardDone(true)
                onDone()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.wizard_done))
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                ServiceLocator.secureStore.setPermissionWizardDone(true)
                onSkip()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.wizard_skip))
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** Ordered wizard steps — key matches PermissionReporter.snapshot() keys. */
private val WIZARD_KEYS = listOf(
    "notifications",
    "locationFine",
    "locationBackground",
    "camera",
    "microphone",
    "appUsageAccess",
    "overlay",
    "batteryOptimizationIgnored",
    "deviceAdmin",
    "accessibilityService",
)

@Composable
private fun WizardRow(key: String, granted: Boolean?, onGrant: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = wizardLabel(key),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = wizardDescription(key),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (granted == true) {
            Text(
                text = stringResource(R.string.settings_granted),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(end = 8.dp),
            )
        } else {
            Button(onClick = onGrant, enabled = granted != null) {
                Text(stringResource(R.string.wizard_grant))
            }
        }
    }
}

/** Localized labels are resolved in the composable layer: */
@Composable
private fun wizardLabel(key: String) = when (key) {
    "notifications" -> stringResource(R.string.wizard_notifications)
    "locationFine" -> stringResource(R.string.wizard_location)
    "locationBackground" -> stringResource(R.string.wizard_background_location)
    "camera" -> stringResource(R.string.wizard_camera)
    "microphone" -> stringResource(R.string.wizard_microphone)
    "appUsageAccess" -> stringResource(R.string.wizard_usage_access)
    "overlay" -> stringResource(R.string.wizard_overlay)
    "batteryOptimizationIgnored" -> stringResource(R.string.wizard_battery)
    "deviceAdmin" -> stringResource(R.string.wizard_device_admin)
    "accessibilityService" -> stringResource(R.string.wizard_accessibility)
    else -> key
}

@Composable
private fun wizardDescription(key: String) = when (key) {
    "notifications" -> stringResource(R.string.wizard_notifications_desc)
    "locationFine" -> stringResource(R.string.wizard_location_desc)
    "locationBackground" -> stringResource(R.string.wizard_background_location_desc)
    "camera" -> stringResource(R.string.wizard_camera_desc)
    "microphone" -> stringResource(R.string.wizard_microphone_desc)
    "appUsageAccess" -> stringResource(R.string.wizard_usage_access_desc)
    "overlay" -> stringResource(R.string.wizard_overlay_desc)
    "batteryOptimizationIgnored" -> stringResource(R.string.wizard_battery_desc)
    "deviceAdmin" -> stringResource(R.string.wizard_device_admin_desc)
    "accessibilityService" -> stringResource(R.string.wizard_accessibility_desc)
    else -> ""
}
