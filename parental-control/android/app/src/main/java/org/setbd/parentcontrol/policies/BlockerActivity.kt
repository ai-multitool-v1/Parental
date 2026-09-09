package org.setbd.parentcontrol.policies

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.setbd.parentcontrol.ui.theme.FamilySafetyTheme

/**
 * Full-screen blocker shown by [AppGuardAccessibilityService] when the child
 * opens an app that the family policy does not allow (blocked app / bedtime /
 * protected Settings). Always shows WHY it appeared — the child is never left
 * guessing — and always offers an obvious way out ("Go to home screen").
 */
class BlockerActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val reason = intent?.getStringExtra(EXTRA_REASON) ?: REASON_BLOCKED_APP

        setContent {
            FamilySafetyTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .background(MaterialTheme.colorScheme.background)
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .background(
                                    MaterialTheme.colorScheme.errorContainer,
                                    RoundedCornerShape(20.dp),
                                )
                                .padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                text = "🚫",
                                fontSize = 48.sp,
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = when (reason) {
                                    REASON_BEDTIME -> stringFor(org.setbd.parentcontrol.R.string.blocker_bedtime_title)
                                    REASON_PROTECTED -> stringFor(org.setbd.parentcontrol.R.string.blocker_protected_title)
                                    else -> stringFor(org.setbd.parentcontrol.R.string.blocker_app_title)
                                },
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = when (reason) {
                                    REASON_BEDTIME -> stringFor(org.setbd.parentcontrol.R.string.blocker_bedtime_body)
                                    REASON_PROTECTED -> stringFor(org.setbd.parentcontrol.R.string.blocker_protected_body)
                                    else -> stringFor(org.setbd.parentcontrol.R.string.blocker_app_body)
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                        Spacer(Modifier.height(24.dp))
                        Button(
                            onClick = {
                                goHome()
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(52.dp),
                        ) {
                            Text(
                                stringFor(org.setbd.parentcontrol.R.string.blocker_go_home),
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }
        }
    }

    private fun goHome() {
        runCatching {
            startActivity(
                Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
        finish()
    }

    private fun stringFor(res: Int): String = getString(res)

    companion object {
        const val EXTRA_REASON = "reason"
        const val EXTRA_PACKAGE = "package"
        const val REASON_BLOCKED_APP = "BLOCKED_APP"
        const val REASON_BEDTIME = "BEDTIME"
        const val REASON_PROTECTED = "PROTECTED_SETTINGS"
    }
}
