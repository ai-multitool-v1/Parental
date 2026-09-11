package org.setbd.parentcontrol.ui

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.management.ManagementMode
import org.setbd.parentcontrol.management.ManagementState
import org.setbd.parentcontrol.reliability.ReliabilityHelper

/**
 * Settings: permission transparency dashboard, battery-reliability guidance
 * (with OEM-specific hints) and the unpair flow.
 *
 * v1.4.2 — permission rows are now INTERACTIVE toggles that always mirror the
 * REAL system permission state (re-sampled every 2.5 s while the screen is
 * open, so returning from the system dialog flips the switch immediately).
 * Tapping a toggle routes the child to the exact system dialog/screen that
 * grants it — the app never fakes a state it did not verify from the OS.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onUnpaired: () -> Unit) {
    val context = LocalContext.current
    var showUnpairConfirm by remember { mutableStateOf(false) }
    var showHideIconConfirm by remember { mutableStateOf(false) }
    val permissionState = remember { mutableStateMapOf<String, Boolean>() }
    var iconHidden by remember {
        mutableStateOf(ServiceLocator.devicePolicyWrapper.isSelfHidden())
    }

    // Live snapshot: refresh immediately + every 2.5 s while visible, so a
    // toggle coming back from system settings reflects the new state at once.
    LaunchedEffect(Unit) {
        while (true) {
            val snap = ServiceLocator.permissionReporter.snapshot()
            listOf(
                "locationFine", "locationBackground", "notifications", "camera",
                "microphone", "appUsageAccess", "batteryOptimizationIgnored",
                "deviceAdmin", "accessibilityService", "overlay",
            ).forEach { key -> permissionState[key] = snap[key] == true }
            iconHidden = snap["appIconHidden"] == true
            delay(2_500)
        }
    }

    // Runtime permission requests (location/camera/mic/notifications) — the
    // official system dialog, result re-sampled by the live loop above.
    val runtimeRequest = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* state refreshes via the live snapshot loop */ }

    /** Opens the exact system surface that grants [key]. */
    fun requestPermission(key: String) {
        runCatching {
            when (key) {
                "locationFine" -> runtimeRequest.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                "notifications" -> {
                    if (android.os.Build.VERSION.SDK_INT >= 33) {
                        runtimeRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        ReliabilityHelper.openAppSettings(context)
                    }
                }
                "camera" -> runtimeRequest.launch(Manifest.permission.CAMERA)
                "microphone" -> runtimeRequest.launch(Manifest.permission.RECORD_AUDIO)
                // Background location cannot be requested from the dialog on
                // Android 10+ — the honest route is the app's settings page.
                "locationBackground" -> context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ),
                )
                "appUsageAccess" -> context.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
                "overlay" -> context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:${context.packageName}"),
                    ),
                )
                "deviceAdmin" -> context.startActivity(
                    Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                        putExtra(
                            DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                            ComponentName(context, org.setbd.parentcontrol.management.DeviceAdminReceiver::class.java),
                        )
                        putExtra(
                            DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                            context.getString(R.string.settings_admin_explanation),
                        )
                    },
                )
                "accessibilityService" -> context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(stringResource(R.string.settings_title), fontWeight = FontWeight.Bold) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
        )

        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            // ---------------------- permissions ----------------------------
            Text(
                stringResource(R.string.settings_permissions_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_notifications),
                        granted = permissionState["notifications"],
                        onToggle = { requestPermission("notifications") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_location),
                        granted = permissionState["locationFine"],
                        onToggle = { requestPermission("locationFine") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_background_location),
                        granted = permissionState["locationBackground"],
                        onToggle = { requestPermission("locationBackground") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_camera),
                        granted = permissionState["camera"],
                        onToggle = { requestPermission("camera") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_microphone),
                        granted = permissionState["microphone"],
                        onToggle = { requestPermission("microphone") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_usage_access),
                        granted = permissionState["appUsageAccess"],
                        onToggle = { requestPermission("appUsageAccess") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_overlay),
                        granted = permissionState["overlay"],
                        onToggle = { requestPermission("overlay") },
                    )
                }
            }
            Text(
                text = stringResource(R.string.settings_permissions_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { ReliabilityHelper.openAppSettings(context) }) {
                Text(stringResource(R.string.open_settings))
            }

            Spacer(Modifier.height(20.dp))

            // ---------------- protection & management (parent setup) -------
            Text(
                stringResource(R.string.settings_protection_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            val managementMode = remember { ManagementState.current(context) }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_device_admin),
                        granted = permissionState["deviceAdmin"],
                        onToggle = { requestPermission("deviceAdmin") },
                    )
                    PermissionToggleRow(
                        label = stringResource(R.string.settings_accessibility),
                        granted = permissionState["accessibilityService"],
                        onToggle = { requestPermission("accessibilityService") },
                    )
                    PermissionRow(
                        stringResource(R.string.settings_management_mode),
                        granted = (managementMode != ManagementMode.NONE),
                    )
                    Text(
                        text = ManagementState.describe(managementMode),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Hide app icon — launcher-alias hiding works on EVERY device
            // (no Device Owner enrollment needed), and the *#*#1111#*#* dial
            // code stays functional because the app itself keeps running.
            // (Previously gated behind DEVICE_OWNER — the toggle was invisible
            // for normal installs, i.e. "apps icon hide toggle kaj kore na".)
            Spacer(Modifier.height(8.dp))
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.settings_hide_icon), fontWeight = FontWeight.SemiBold)
                        Text(
                            stringResource(R.string.settings_hide_icon_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = iconHidden,
                        onCheckedChange = { wantHidden ->
                            if (wantHidden) showHideIconConfirm = true else {
                                // unhideSelf() covers BOTH the alias path
                                // and legacy DPM-hidden state.
                                ServiceLocator.devicePolicyWrapper.unhideSelf()
                                iconHidden = false
                            }
                        },
                    )
                }
            }

            // Secret dial code card.
            Spacer(Modifier.height(8.dp))
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(stringResource(R.string.settings_dial_code_title), fontWeight = FontWeight.SemiBold)
                    Text(
                        "*#*#1111#*#*",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        stringResource(R.string.settings_dial_code_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(20.dp))

            // ------------------- battery & reliability ----------------------
            Text(
                stringResource(R.string.settings_battery_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            val manufacturerHint = remember { ReliabilityHelper.manufacturerHint() }
            manufacturerHint?.let {
                Card(Modifier.fillMaxWidth()) {
                    Text(
                        stringResource(R.string.settings_battery_manufacturer_note, it.substringBefore(':')),
                        Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Spacer(Modifier.height(8.dp))
            }
            Button(
                onClick = { ReliabilityHelper.requestIgnoreBatteryOptimizations(context) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.settings_battery_action))
            }

            Spacer(Modifier.height(20.dp))

            // ------------------ cloud backup (v1.3.0) ----------------------
            org.setbd.parentcontrol.backup.BackupSettingsSection()

            Spacer(Modifier.height(20.dp))

            // ---------------- support & contact (v1.2.0) -------------------
            Text(
                stringResource(R.string.support_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        stringResource(R.string.support_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    Button(onClick = { org.setbd.parentcontrol.ui.openTelegramSupport(context) }) {
                        Text(stringResource(R.string.support_open_telegram))
                    }
                }
            }

            Spacer(Modifier.height(20.dp))

            // ------------------------- unpair -------------------------------
            Text(
                stringResource(R.string.settings_unpair_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.settings_unpair_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { showUnpairConfirm = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.settings_unpair_confirm), color = MaterialTheme.colorScheme.error)
            }

            Spacer(Modifier.height(20.dp))

            // v1.2.0: developer credits
            CreditsFooter()
        }
    }

    if (showHideIconConfirm) {
        AlertDialog(
            onDismissRequest = { showHideIconConfirm = false },
            title = { Text(stringResource(R.string.settings_hide_icon), fontWeight = FontWeight.Bold) },
            text = { Text(stringResource(R.string.settings_hide_icon_confirm_body)) },
            confirmButton = {
                TextButton(onClick = {
                    showHideIconConfirm = false
                    // Alias-based self-hide: reliable + dial code keeps working.
                    iconHidden = ServiceLocator.devicePolicyWrapper.setSelfHidden(true)
                }) { Text(stringResource(R.string.consent_allow)) }
            },
            dismissButton = {
                TextButton(onClick = { showHideIconConfirm = false }) { Text(stringResource(R.string.sos_cancel)) }
            },
        )
    }

    if (showUnpairConfirm) {
        AlertDialog(
            onDismissRequest = { showUnpairConfirm = false },
            title = { Text(stringResource(R.string.settings_unpair_title), fontWeight = FontWeight.Bold) },
            text = { Text(stringResource(R.string.settings_unpair_body)) },
            confirmButton = {
                TextButton(onClick = {
                    showUnpairConfirm = false
                    ServiceLocator.pairing.unpair()
                    onUnpaired()
                }) { Text(stringResource(R.string.settings_unpair_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showUnpairConfirm = false }) { Text(stringResource(R.string.sos_cancel)) }
            },
        )
    }
}

/**
 * Interactive permission row — the switch mirrors the REAL OS state
 * (never local-only); tapping it routes to the exact system dialog.
 * When [granted] is null (first sample pending) the row renders read-only.
 */
@Composable
private fun PermissionToggleRow(label: String, granted: Boolean?, onToggle: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(
            text = stringResource(if (granted == true) R.string.settings_granted else R.string.settings_denied),
            style = MaterialTheme.typography.labelMedium,
            color = if (granted == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(end = 8.dp),
        )
        Switch(
            checked = granted == true,
            enabled = granted != null,
            onCheckedChange = { onToggle() },
        )
    }
}

/** Read-only informational row (management mode etc.). */
@Composable
private fun PermissionRow(label: String, granted: Boolean?) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(
            text = stringResource(if (granted == true) R.string.settings_granted else R.string.settings_denied),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (granted == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
    }
}
