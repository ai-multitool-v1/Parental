package org.setbd.parentcontrol.util

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * API 21+ compatibility helpers.
 *
 * The app supports Android 5.0 (API 21) through the latest Android release.
 * Several platform entry points only exist on newer APIs:
 *  * [Context.startForegroundService] — API 26+ (below that, [Context.startService]
 *    while the app is foreground is the correct call; our capture services are
 *    ALWAYS started from the foreground consent flow, so this is safe).
 *  * [Service.stopForeground] — API 24+ (below that, `stopForeground(true)`).
 *
 * Every caller must use these helpers instead of the raw APIs so the whole
 * app remains API-21-safe in one audited place.
 */
fun Context.startFgServiceCompat(intent: Intent) {
    if (Build.VERSION.SDK_INT >= 26) {
        startForegroundService(intent)
    } else {
        startService(intent)
    }
}

fun Service.stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= 24) {
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
    } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
    }
}
