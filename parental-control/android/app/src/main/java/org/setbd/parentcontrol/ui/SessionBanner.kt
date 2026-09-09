package org.setbd.parentcontrol.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.setbd.parentcontrol.R
import org.setbd.parentcontrol.di.ActiveSession
import org.setbd.parentcontrol.di.SessionType

/**
 * Always-visible banner shown for EVERY active sharing session — the second
 * half of the visible-indicator promise (the first half being the ongoing
 * notification of each foreground service).
 *
 * The Stop button ends the session directly — the child never has to wait for
 * or ask the parent.
 */
@Composable
fun SessionBanner(
    activeSessions: List<ActiveSession>,
    onStop: (ActiveSession) -> Unit,
) {
    activeSessions.forEach { session ->
        val (colorRes, label) = when (session.type) {
            SessionType.SCREEN -> 0xFFF57C00 to stringResource(R.string.banner_screen_active)
            SessionType.CAMERA -> 0xFFC62828 to stringResource(R.string.banner_camera_active)
            SessionType.AUDIO -> 0xFF6A1B9A to stringResource(R.string.banner_audio_active)
            SessionType.LOCATION -> 0xFF00695C to stringResource(R.string.banner_location_active)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(colorRes), RoundedCornerShape(12.dp))
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = label,
                color = Color.White,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { onStop(session) }) {
                Text(
                    stringResource(R.string.banner_stop),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}
