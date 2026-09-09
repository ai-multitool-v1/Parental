package org.setbd.parentcontrol.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ActiveSession
import org.setbd.parentcontrol.di.ServiceLocator
import org.setbd.parentcontrol.device.DeviceStatusMonitor
import org.setbd.parentcontrol.device.DeviceSnapshot
import org.setbd.parentcontrol.emergency.EmergencyContacts
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Child dashboard: honest device status, the big red SOS button (with a
 * 3-second countdown confirmation), live session banners, bedtime indicator
 * and emergency contacts. Everything shown here mirrors what the parent sees
 * — transparency is the product.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(onOpenSettings: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val appState = ServiceLocator.appState

    val activeSessions by appState.activeSessions.collectAsState()
    val bedtimeActive by appState.bedtimeActive.collectAsState()
    val connected by appState.connected.collectAsState()

    var snapshot by remember { mutableStateOf<DeviceSnapshot?>(null) }
    var showSosConfirm by remember { mutableStateOf(false) }
    // v1.2.0: Telegram support modal
    var showSupport by remember { mutableStateOf(false) }

    // Refresh the status card every 30 s and push a heartbeat on open.
    LaunchedEffect(Unit) {
        ServiceLocator.deviceStatusMonitor.enqueueImmediateHeartbeat()
        while (true) {
            snapshot = ServiceLocator.deviceStatusMonitor.currentSnapshot()
            delay(30_000)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        TopAppBar(
            title = { Text(stringResource(R.string.dashboard_title), fontWeight = FontWeight.Bold) },
            actions = {
                IconButton(onClick = { showSupport = true }) {
                    Icon(
                        Icons.Filled.Send,
                        contentDescription = stringResource(R.string.support_title),
                    )
                }
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings_title))
                }
            },
        )

        Column(Modifier.padding(horizontal = 16.dp)) {
            // ---- visible session banners (ALWAYS on top) ----
            SessionBanner(activeSessions = activeSessions, onStop = { session: ActiveSession ->
                when (session.type) {
                    org.setbd.parentcontrol.di.SessionType.SCREEN ->
                        ServiceLocator.screenShareManager.stopSession(session.sessionId)
                    org.setbd.parentcontrol.di.SessionType.CAMERA ->
                        ServiceLocator.cameraSessionManager.stopSession()
                    org.setbd.parentcontrol.di.SessionType.AUDIO ->
                        ServiceLocator.microphoneSessionManager.stopSession()
                    org.setbd.parentcontrol.di.SessionType.LOCATION ->
                        context.startService(
                            org.setbd.parentcontrol.location.LocationService.stopIntent(context),
                        )
                }
            })

            if (bedtimeActive) {
                BedtimeBanner()
            }

            Spacer(Modifier.height(12.dp))

            // ---- device status card ----
            StatusCard(snapshot, connected)

            Spacer(Modifier.height(12.dp))

            // v1.3.0 — cloud backup setup card (child opt-in, one tap to
            // the full consent surface in Settings).
            org.setbd.parentcontrol.backup.BackupQuickCard(onOpenSettings = onOpenSettings)

            Spacer(Modifier.height(16.dp))

            // ---- SOS ----
            SosButton(onClick = { showSosConfirm = true })

            Spacer(Modifier.height(16.dp))

            // ---- emergency contacts ----
            val contacts = remember { EmergencyContacts.current() }
            if (contacts.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        contacts.forEach { contact ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(contact.name, fontWeight = FontWeight.SemiBold)
                                    contact.relation?.let {
                                        Text(it, style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                                TextButton(onClick = {
                                    // ACTION_DIAL needs no permission; the
                                    // child confirms the call in the dialer.
                                    context.startActivity(
                                        Intent(Intent.ACTION_DIAL, Uri.parse("tel:${contact.phone}")),
                                    )
                                }) { Text(contact.phone) }
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))

            // ---- support (Telegram) card ----
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(stringResource(R.string.support_title), fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        stringResource(R.string.support_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = { showSupport = true }) {
                        Icon(Icons.Filled.Send, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.height(0.dp))
                        Text("  " + stringResource(R.string.support_open_telegram))
                    }
                }
            }

            Spacer(Modifier.height(12.dp))

            // v1.2.0: developer credits
            CreditsFooter()
        }
    }

    if (showSupport) {
        TelegramSupportDialog(onDismiss = { showSupport = false })
    }

    if (showSosConfirm) {
        SosConfirmDialog(
            onConfirm = {
                showSosConfirm = false
                scope.launch { ServiceLocator.emergencyManager.triggerSos() }
            },
            onDismiss = { showSosConfirm = false },
        )
    }
}

@Composable
private fun StatusCard(snapshot: DeviceSnapshot?, connected: Boolean) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(
                text = if (connected) stringResource(R.string.service_status_ok)
                else stringResource(R.string.service_status_offline),
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(8.dp))
            if (snapshot == null) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                StatusRow(
                    stringResource(R.string.battery_label),
                    if (snapshot.charging) {
                        "${snapshot.batteryPercent}% (${stringResource(R.string.charging_label)})"
                    } else {
                        "${snapshot.batteryPercent}%"
                    },
                )
                StatusRow(
                    stringResource(R.string.network_label),
                    stringResource(
                        when (snapshot.networkType) {
                            "wifi" -> R.string.network_wifi
                            "mobile" -> R.string.network_mobile
                            else -> R.string.network_offline
                        },
                    ),
                )
                StatusRow("Android", snapshot.androidVersion)
                StatusRow("App", snapshot.appVersion)
            }
        }
    }
}

@Composable
private fun StatusRow(label: String, value: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
    }
}

/** The one big red button — 3-second confirmation dialog guards it. */
@Composable
private fun SosButton(onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp),
        shape = RoundedCornerShape(20.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.error,
            contentColor = Color.White,
        ),
    ) {
        Text(
            stringResource(R.string.sos_button),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun SosConfirmDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    // 3-2-1 countdown to prevent accidental triggers (pocket taps etc.).
    var secondsLeft by remember { mutableIntStateOf(3) }
    LaunchedEffect(Unit) {
        while (secondsLeft > 0) {
            delay(1000)
            secondsLeft -= 1
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sos_confirm_title), fontWeight = FontWeight.Bold) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.sos_confirm_body), textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "${maxOf(secondsLeft, 0)}",
                    style = MaterialTheme.typography.displayMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = secondsLeft <= 0, // enabled only after the countdown
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            ) { Text(stringResource(R.string.sos_button)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.sos_cancel)) }
        },
    )
}

@Composable
private fun BedtimeBanner() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF3949AB), RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.bedtime_active_banner),
            color = Color.White,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

/**
 * Full-screen bedtime overlay (the "blocking screen") — shown when the app is
 * opened during the bedtime window. It is an informational screen, not a
 * lock: real restriction enforcement uses the supported device-owner APIs
 * (see policies/BedtimeReceiver).
 */
@Composable
fun BedtimeOverlay() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF1A237E)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                stringResource(R.string.notif_bedtime_title),
                color = Color.White,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                stringResource(R.string.notif_bedtime_text),
                color = Color.White.copy(alpha = 0.85f),
                textAlign = TextAlign.Center,
            )
        }
    }
}
