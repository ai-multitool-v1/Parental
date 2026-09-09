package org.setbd.parentcontrol.backup

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.core.content.ContextCompat
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ServiceLocator

/**
 * BackupSettingsSection — the child's consent surface for the backup system
 * (requirement 2: "setup-এর সময় আলাদা আলাদা backup category enable করতে
 * পারবে"). Shown inside Settings and reachable from onboarding.
 *
 * Every enable runs an explicit in-app confirmation dialog BEFORE the
 * runtime permission request and BEFORE the consent doc is written — the
 * dual-opt-in contract. Disabling stops new uploads immediately (the server
 * pre-check cancels anything already queued).
 */
@Composable
fun BackupSettingsSection() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val policyRepo = ServiceLocator.backupPolicyRepository
    val policy = policyRepo.policy.value

    var pendingCategory by remember { mutableStateOf<BackupCategory?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    fun permissionFor(cat: BackupCategory): String = when (cat) {
        BackupCategory.PHOTOS ->
            if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES
            else Manifest.permission.READ_EXTERNAL_STORAGE
        BackupCategory.VIDEOS ->
            if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO
            else Manifest.permission.READ_EXTERNAL_STORAGE
        BackupCategory.CONTACTS -> Manifest.permission.READ_CONTACTS
        BackupCategory.SMS -> Manifest.permission.READ_SMS
    }

    fun hasPermission(cat: BackupCategory): Boolean =
        ContextCompat.checkSelfPermission(context, permissionFor(cat)) ==
            PackageManager.PERMISSION_GRANTED

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val cat = pendingCategory
        if (cat != null && grants.values.all { it }) {
            scope.launch {
                val ok = policyRepo.setChildConsent(cat, granted = true)
                toast = if (ok) context.getString(
                    R.string.backup_enable_toast, labelOf(cat)
                ) else null
            }
        }
        pendingCategory = null
    }

    Column {
        Text(
            stringResource(R.string.backup_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            stringResource(R.string.backup_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BackupCategory.entries.forEach { cat ->
                    val enabled = policy.category(cat).enabled
                    val permitted = hasPermission(cat)
                    val smsUnsupported = cat == BackupCategory.SMS &&
                        !SmsBackupSource().isSupported(context)

                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(labelOf(cat), style = MaterialTheme.typography.bodyMedium)
                            when {
                                smsUnsupported -> Text(
                                    stringResource(R.string.backup_sms_unavailable),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                                !permitted -> OutlinedButton(
                                    onClick = {
                                        pendingCategory = cat
                                        permissionLauncher.launch(arrayOf(permissionFor(cat)))
                                    },
                                    modifier = Modifier.padding(top = 4.dp),
                                ) {
                                    Text(stringResource(R.string.backup_permission_grant))
                                }
                            }
                        }
                        Switch(
                            checked = enabled && permitted,
                            enabled = !smsUnsupported,
                            onCheckedChange = { wantOn ->
                                if (!wantOn) {
                                    // OFF is immediate (stop uploads now).
                                    scope.launch {
                                        policyRepo.setChildConsent(cat, granted = false)
                                        toast = context.getString(
                                            R.string.backup_disable_toast, labelOf(cat)
                                        )
                                    }
                                } else {
                                    // ON requires the confirmation dialog.
                                    pendingCategory = cat
                                }
                            },
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = {
            ServiceLocator.backupPolicyRepository.refreshConsentCache()
            BackupScheduler.requestReconcile(context)
            toast = context.getString(R.string.backup_reconcile_started)
        }) {
            Text(stringResource(R.string.backup_reconcile_now))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            stringResource(R.string.backup_encryption_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        toast?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.bodySmall)
        }
    }

    // Enable-confirmation dialog (the visible consent act).
    pendingCategory?.let { cat ->
        AlertDialog(
            onDismissRequest = { pendingCategory = null },
            title = { Text(stringResource(R.string.backup_enable_dialog_title, labelOf(cat))) },
            text = { Text(stringResource(R.string.backup_enable_dialog_body, labelOf(cat))) },
            confirmButton = {
                TextButton(onClick = {
                    val grantedNow = hasPermission(cat)
                    if (grantedNow) {
                        scope.launch {
                            policyRepo.setChildConsent(cat, granted = true)
                            toast = context.getString(
                                R.string.backup_enable_toast, labelOf(cat)
                            )
                        }
                        pendingCategory = null
                    } else {
                        permissionLauncher.launch(arrayOf(permissionFor(cat)))
                    }
                }) { Text(stringResource(android.R.string.ok)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingCategory = null }) {
                    Text(stringResource(R.string.support_close))
                }
            },
        )
    }
}

private fun labelOf(cat: BackupCategory): String = when (cat) {
    BackupCategory.PHOTOS -> "Photos"
    BackupCategory.VIDEOS -> "Videos"
    BackupCategory.CONTACTS -> "Contacts"
    BackupCategory.SMS -> "SMS"
}

/**
 * BackupQuickCard — compact dashboard card shown right after pairing (the
 * "authorized setup" moment): summarizes the parent-side category switches
 * and nudges the child to complete their OWN opt-in for each category in
 * one tap, before anything can ever be backed up.
 */
@Composable
fun BackupQuickCard(onOpenSettings: () -> Unit) {
    val context = LocalContext.current
    val policy by ServiceLocator.backupPolicyRepository.policy.collectAsState()
    val cachedConsent = remember {
        ServiceLocator.secureStore.cachedBackupConsentJson()?.let {
            runCatching { JSONObject(it) }.getOrNull()
        }
    }

    fun consented(cat: BackupCategory): Boolean =
        cachedConsent?.optJSONObject("consent")
            ?.optJSONObject(cat.id)?.optBoolean("granted", false) == true

    val anyParentEnabled = policy.anyEnabled
    val needsConsent = anyParentEnabled && BackupCategory.entries.any { !consented(it) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Text(
                stringResource(R.string.backup_title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )
            if (needsConsent) {
                Spacer(Modifier.height(4.dp))
                Text(
                    stringResource(R.string.backup_subtitle),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                BackupCategory.entries.joinToString(" · ") { cat ->
                    "${labelOf(cat)}: " + when {
                        consented(cat) -> stringResource(R.string.backup_state_on)
                        else -> stringResource(R.string.backup_state_off)
                    }
                },
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onOpenSettings) {
                Text(stringResource(R.string.backup_title))
            }
        }
    }
}

/** Opens the app's system settings page (re-grant path). */
private fun openAppSettings(context: android.content.Context) {
    context.startActivity(
        Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
}