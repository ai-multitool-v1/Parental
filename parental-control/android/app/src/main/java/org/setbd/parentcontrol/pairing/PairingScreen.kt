package org.setbd.parentcontrol.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.setbd.parentcontrol.R
import kotlinx.coroutines.delay

/**
 * Pairing screen: shows the 8-character code with a live countdown, plain
 * language instructions, and cancel/retry actions. Deliberately friendly and
 * jargon-free — this screen is shown to a child.
 */
@Composable
fun PairingScreen(viewModel: PairingViewModel) {
    val state by viewModel.state.collectAsState()

    LaunchedEffect(Unit) {
        if (viewModel.isAlreadyPaired.not()) viewModel.startPairing()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.pairing_title),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.pairing_instructions),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))

        when (val s = state) {
            is PairingState.Generating -> CircularProgressIndicator()

            is PairingState.WaitingForApproval -> {
                PairingCodeCard(s.code)
                Spacer(Modifier.height(8.dp))
                CountdownText(s.expiresAtMs)
                Spacer(Modifier.height(16.dp))
                Text(
                    text = stringResource(R.string.pairing_waiting),
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(24.dp))
                OutlinedButton(onClick = viewModel::cancelPairing) {
                    Text(stringResource(R.string.pairing_cancel))
                }
            }

            is PairingState.Approved -> Text(stringResource(R.string.pairing_approved))

            is PairingState.Expired -> {
                Text(
                    stringResource(R.string.pairing_expired),
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = viewModel::startPairing) {
                    Text(stringResource(R.string.pairing_new_code))
                }
            }

            is PairingState.Failed -> {
                Text(
                    s.message,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = viewModel::startPairing) {
                    Text(stringResource(R.string.pairing_new_code))
                }
            }

            PairingState.Idle -> Unit
        }
    }
}

@Composable
private fun PairingCodeCard(code: String) {
    Column(
        modifier = Modifier
            .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(16.dp))
            .padding(horizontal = 32.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = code.chunked(4).joinToString("-"),
            fontSize = 34.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 2.sp,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    }
}

@Composable
private fun CountdownText(expiresAtMs: Long) {
    var remainingSec by remember { mutableLongStateOf((expiresAtMs - System.currentTimeMillis()) / 1000) }
    LaunchedEffect(expiresAtMs) {
        while (remainingSec > 0) {
            delay(1000)
            remainingSec = (expiresAtMs - System.currentTimeMillis()) / 1000
        }
    }
    val mm = remainingSec / 60
    val ss = remainingSec % 60
    Text(
        text = "%02d:%02d".format(mm, ss),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
