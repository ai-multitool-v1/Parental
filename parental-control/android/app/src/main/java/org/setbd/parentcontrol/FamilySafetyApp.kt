package org.setbd.parentcontrol

import android.app.Application
import android.util.Log
import androidx.work.Configuration
import androidx.work.WorkManager
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.AppCheckProviderFactory
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory

/**
 * Application entry point.
 *
 * Responsibilities:
 *  1. Initialize the manual DI graph ([ServiceLocator]).
 *  2. Initialize Firebase + **Firebase App Check** (Play Integrity in release,
 *     Debug provider in debug builds) so only genuine app instances can hit
 *     Firestore — an important anti-tamper control for a child-facing app.
 *  3. Provide on-demand WorkManager configuration (boot receiver only
 *     reschedules jobs; it never starts capture services).
 */
class FamilySafetyApp : Application(), Configuration.Provider {

    override fun onCreate() {
        super.onCreate()

        // 1) Firebase core. google-services.json (see google-services.json.example)
        //    supplies the project configuration.
        FirebaseApp.initializeApp(this)

        // 2) App Check — rejects requests from non-genuine clients.
        try {
            val factory: AppCheckProviderFactory = if (BuildConfig.APP_CHECK_PROVIDER == "debug") {
                DebugAppCheckProviderFactory.getInstance()
            } else {
                PlayIntegrityAppCheckProviderFactory.getInstance()
            }
            FirebaseAppCheck.getInstance().installAppCheckProviderFactory(factory)
        } catch (t: Throwable) {
            // App Check must never crash the child app at startup; Firestore
            // rules still enforce authorization server-side.
            Log.w(TAG, "App Check init skipped: ${t.message}")
        }

        // 3) Manual DI + shared state.
        ServiceLocator.init(this)
        ServiceLocator.auth.observeAuthState()
    }

    /** On-demand WorkManager configuration (manifest default initializer removed). */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(Log.INFO)
            .build()

    /** Ensures WorkManager is initialized eagerly (safe for receivers at boot). */
    fun ensureWorkManager() = WorkManager.getInstance(this)

    private companion object { const val TAG = "FamilySafetyApp" }
}
