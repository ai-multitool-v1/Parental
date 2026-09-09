package org.setbd.parentcontrol.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.setbd.parentcontrol.R

/**
 * Branding helpers (v1.2.0): splash screen with developer credits,
 * the Telegram support modal, and a reusable credits footer.
 *
 * Everything here is purely visual — no behavior, no permissions.
 */

/** Official support channel (user requirement v1.2.0). */
const val SUPPORT_TELEGRAM_URL = "https://t.me/setbd_ceo"

/** Opens the Telegram support channel via ACTION_VIEW (no permission needed). */
fun openTelegramSupport(context: android.content.Context) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SUPPORT_TELEGRAM_URL)))
    }
    // Unknown browser/Telegram installed-out case: silently ignored — the
    // dialog stays open so the user can copy the link from the handle text.
}

/**
 * Full-screen splash overlay shown once at app start (~2.6 s).
 * Drawn above whatever route is active so it also covers cold-start
 * work (pairing restore etc.) — tap anywhere to skip.
 */
@Composable
fun SplashCreditsOverlay(onFinished: () -> Unit) {
    var visible by remember { mutableStateOf(true) }
    var started by remember { mutableStateOf(false) }
    val alpha by animateFloatAsState(
        targetValue = if (started) 1f else 0.35f,
        animationSpec = tween(durationMillis = 700),
        label = "splashAlpha",
    )

    LaunchedEffect(Unit) {
        started = true
        delay(2600)
        visible = false
        onFinished()
    }

    if (!visible) return

    Surface(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        listOf(Color(0xFF047857), Color(0xFF065F46), Color(0xFF134E4A)),
                    ),
                )
                .graphicsLayer { this.alpha = alpha },
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(32.dp),
            ) {
                Icon(
                    Icons.Filled.Shield,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(88.dp),
                )
                Spacer(Modifier.height(20.dp))
                Text(
                    stringResource(R.string.splash_app_title),
                    color = Color.White,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    stringResource(R.string.splash_app_subtitle),
                    color = Color(0xFFD1FAE5),
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
            }
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 32.dp),
            ) {
                Text(
                    stringResource(R.string.credit_develop_by),
                    color = Color(0xFFD1FAE5),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    stringResource(R.string.credit_powered_by),
                    color = Color(0xFFA7F3D0).copy(alpha = 0.75f),
                    style = MaterialTheme.typography.labelSmall,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * Telegram support modal — visible, one-tap access to the official support
 * channel. Nothing is sent automatically; the user opens the chat themselves.
 */
@Composable
fun TelegramSupportDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                Icons.Filled.Send,
                contentDescription = null,
                tint = Color(0xFF0288D1),
            )
        },
        title = {
            Text(
                stringResource(R.string.support_title),
                fontWeight = FontWeight.Bold,
            )
        },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    stringResource(R.string.support_body),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(12.dp))
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                ) {
                    Text(
                        stringResource(R.string.support_telegram_handle),
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    openTelegramSupport(context)
                    onDismiss()
                },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0288D1)),
            ) { Text(stringResource(R.string.support_open_telegram)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.support_close)) }
        },
    )
}

/** Small credits footer — reusable at the bottom of screens. */
@Composable
fun CreditsFooter(modifier: Modifier = Modifier) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 16.dp, top = 8.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.credit_full_line),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}
