package org.setbd.parentcontrol.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ConsentRequest
import org.setbd.parentcontrol.di.SafetyCheckResponse
import org.setbd.parentcontrol.di.SessionType

/**
 * THE consent gate for all media sessions (screen / camera / microphone).
 *
 * Plain-language explanation of who is asking and what they will see/hear,
 * with exactly two outcomes: Allow or Decline. Nothing starts until a button
 * is pressed, and every outcome is written to the command results + audit log.
 * The child is reminded they can stop any time from the session banner.
 */
@Composable
fun ConsentDialog(
    request: ConsentRequest,
    onRespond: (allowed: Boolean) -> Unit,
) {
    val (title, body) = when (request.type) {
        SessionType.SCREEN ->
            stringResource(R.string.consent_title_screen) to
                stringResource(R.string.consent_body_screen, request.requestedByName)
        SessionType.CAMERA ->
            stringResource(R.string.consent_title_camera) to
                stringResource(R.string.consent_body_camera, request.requestedByName)
        SessionType.AUDIO ->
            stringResource(R.string.consent_title_audio) to
                stringResource(R.string.consent_body_audio, request.requestedByName)
        SessionType.LOCATION ->
            stringResource(R.string.consent_title_screen) to
                stringResource(R.string.consent_body_screen, request.requestedByName)
    }

    AlertDialog(
        onDismissRequest = { /* must choose Allow or Decline explicitly */ },
        title = {
            Text(title, fontWeight = FontWeight.Bold)
        },
        text = {
            Column {
                Text(body, style = MaterialTheme.typography.bodyLarge)
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.consent_stoppable_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onRespond(true) }) {
                Text(stringResource(R.string.consent_allow), fontWeight = FontWeight.Bold)
            }
        },
        dismissButton = {
            TextButton(onClick = { onRespond(false) }) {
                Text(stringResource(R.string.consent_decline))
            }
        },
    )
}

/**
 * Parent-initiated safety check ("Are you OK?") with the child's two
 * possible answers. Answer is recorded to the command result + audit log.
 */
@Composable
fun SafetyCheckDialog(onAnswer: (SafetyCheckResponse) -> Unit) {
    AlertDialog(
        onDismissRequest = { /* explicit answer required; timeout handles absence */ },
        title = { Text(stringResource(R.string.safety_check_title), fontWeight = FontWeight.Bold) },
        text = { Text(stringResource(R.string.safety_check_body)) },
        confirmButton = {
            TextButton(onClick = { onAnswer(SafetyCheckResponse.IM_OK) }) {
                Text(stringResource(R.string.safety_check_im_ok), fontWeight = FontWeight.Bold)
            }
        },
        dismissButton = {
            TextButton(onClick = { onAnswer(SafetyCheckResponse.NEED_HELP) }) {
                Text(stringResource(R.string.safety_check_need_help))
            }
        },
    )
}
