package org.setbd.parentcontrol.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Material 3 theme for the child app. Calm greens communicate "safe", the SOS
 * affordance stays red. Follows the system dark setting.
 */
private val LightColors = lightColorScheme(
    primary = Color(0xFF2E7D32),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFB9F0BC),
    onPrimaryContainer = Color(0xFF002106),
    secondary = Color(0xFF52634F),
    secondaryContainer = Color(0xFFD5E8CF),
    error = Color(0xFFBA1A1A),
    errorContainer = Color(0xFFFFDAD6),
    background = Color(0xFFF6FBF4),
    surface = Color(0xFFF6FBF4),
    surfaceVariant = Color(0xFFDDE5D8),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF9CD67D),
    onPrimary = Color(0xFF0A390F),
    primaryContainer = Color(0xFF205123),
    onPrimaryContainer = Color(0xFFB9F0BC),
    secondary = Color(0xFFB9CCB4),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF93000A),
)

@Composable
fun FamilySafetyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}
