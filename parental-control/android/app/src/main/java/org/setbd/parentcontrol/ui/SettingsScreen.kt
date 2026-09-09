package org.setbd.parentcontrol.ui

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.provider.Settings
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
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.management.ManagementMode
import org.setbd.parentcontrol.management.ManagementState
import org.setbd.parentcontrol.reliability.ReliabilityHelper

/**
 * Settings: permission transparency dashboard, battery-reliability guidance
 * (with OEM-specific hints) and the unpair flow. Everything here is
 * user-initiated; there are no hidden toggles.
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

    // Snapshot + upload the permission state for the parent dashboard too.
    LaunchedEffect(Unit) {
        val snap = ServiceLocator.permissionReporter.snapshot()
        listOf(
            "locationFine", "locationBackground", "notifications", "camera",
            "microphone", "appUsageAccess", "batteryOptimizationIgnored",
            "deviceAdmin", "accessibilityService",
        ).forEach { key -> permissionState[key] = snap[key] == true }
        iconHidden = snap["appIconHidden"] == true
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
                    PermissionRow(stringResource(R.string.settings_notifications), permissionState["notifications"])
                    PermissionRow(stringResource(R.string.settings_location), permissionState["locationFine"])
                    PermissionRow(stringResource(R.string.settings_background_location), permissionState["locationBackground"])
                    PermissionRow(stringResource(R.string.settings_camera), permissionState["camera"])
                    PermissionRow(stringResource(R.string.settings_microphone), permissionState["microphone"])
                    PermissionRow(stringResource(R.string.settings_usage_access), permissionState["appUsageAccess"])
                }
            }
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
                    PermissionRow(stringResource(R.string.settings_device_admin), permissionState["deviceAdmin"])
                    PermissionRow(stringResource(R.string.settings_accessibility), permissionState["accessibilityService"])
                    PermissionRow(
                        stringResource(R.string.settings_management_mode),
                        granted = (managementMode != ManagementMode.NONE),
                    )
                    Text(
                        text = ManagementState.describe(managementMode),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))

                    // Device admin activation (visible system dialog).
                    if (managementMode == ManagementMode.NONE) {
                        OutlinedButton(
                            onClick = {
                                runCatching {
                                    context.startActivity(
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
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(stringResource(R.string.settings_activate_admin)) }
                    }

                    // Accessibility (App Guard) enable shortcut.
                    if (permissionState["accessibilityService"] != true) {
                        OutlinedButton(
                            onClick = {
                                runCatching {
                                    context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(stringResource(R.string.settings_enable_accessibility)) }
                    }
                }
            }

            // Hide app icon — official Device Owner capability (API 28+).
            if (managementMode == ManagementMode.DEVICE_OWNER || managementMode == ManagementMode.PROFILE_OWNER) {
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
                                    ServiceLocator.devicePolicyWrapper.setApplicationHidden(context.packageName, false)
                                    iconHidden = false
                                }
                            },
                        )
                    }
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
                    val r = ServiceLocator.devicePolicyWrapper.setApplicationHidden(context.packageName, true)
                    iconHidden = r == org.setbd.parentcontrol.management.EnforcementResult.Supported
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
