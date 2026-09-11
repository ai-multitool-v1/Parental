package org.setbd.parentcontrol.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Looper
import androidx.core.content.ContextCompat
import org.setbd.parentcontrol.di.ServiceLocator
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

/**
 * Location repository — the ONLY place in the app that touches location APIs.
 *
 * CONSENT MODEL:
 *  * One-shot fixes run only for an explicit REQUEST_LOCATION command or an
 *    SOS event, and only if the child granted location permission during
 *    onboarding.
 *  * Live tracking additionally runs [LocationService] — a foreground service
 *    of type `location` with a persistent, visible notification; the child can
 *    stop it from the notification or the dashboard banner at any time.
 *
 * All writes go to `devices/{deviceId}/locations/{id}` with
 * `{lat, lng, accuracyMeters, speedMps, source, reason, timestamp}`.
 */
class LocationRepository(private val context: Context) {

    private val firestore = FirebaseFirestore.getInstance()
    private val fusedClient: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context)

    /** Last fix kept in memory for the SOS snapshot (never persisted). */
    @Volatile
    var lastKnown: Location? = null
        private set

    // ------------------------------ permissions ------------------------------

    fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    fun hasBackgroundLocation(): Boolean =
        hasFineLocation() &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    val isLiveTracking: Boolean get() = liveCallback != null

    private var liveCallback: LocationCallback? = null

    // ------------------------------ one-shot fix -----------------------------

    /**
     * Fetches a single current fix and writes it. Returns true when a fix was
     * written. Reports gracefully (no crash, no bypass) when permission is
     * missing or the provider is unavailable.
     */
    @SuppressLint("MissingPermission") // permission re-checked inside
    suspend fun writeSingleFix(reason: String): Boolean = withContext(Dispatchers.IO) {
        if (!hasFineLocation()) return@withContext false
        try {
            val location = fusedClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
                ?: fusedClient.lastLocation.await()
            location?.let { writeFix(it, source = "oneshot", reason = reason); true } ?: false
        } catch (e: Exception) {
            false
        }
    }

    // ------------------------------ live tracking ----------------------------

    /**
     * Starts live updates. MUST be called from [LocationService] (foreground)
     * or while the app is visible; the service owns the visible notification.
     */
    @SuppressLint("MissingPermission") // permission re-checked inside
    fun startLiveUpdates(intervalMs: Long = 30_000L): Boolean {
        if (!hasFineLocation() || liveCallback != null) return false
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateDistanceMeters(10f)
            .build()
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let {
                    // Fire-and-forget writes; never block the location thread.
                    kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                        writeFix(it, source = "live", reason = "live_tracking")
                    }
                }
            }
        }
        liveCallback = callback
        fusedClient.requestLocationUpdates(request, callback, Looper.getMainLooper())
        return true
    }

    fun stopLiveUpdates() {
        liveCallback?.let { fusedClient.removeLocationUpdates(it) }
        liveCallback = null
    }

    // --------------------------------- writes --------------------------------

    /** Persists one fix to Firestore and mirrors it into [lastKnown]. */
    private suspend fun writeFix(location: Location, source: String, reason: String) {
        lastKnown = location
        // v1.4.2 — parent's locationTracking policy gate: OFF stops CONTINUOUS
        // ("live") tracking. One-shot parent requests and SOS always pass —
        // they are explicit, visible and safety-relevant.
        if (source == "live") {
            val trackingOn = try {
                ServiceLocator.policyRepository.currentPolicy()?.locationTracking ?: true
            } catch (e: Exception) {
                true
            }
            if (!trackingOn) return
        }
        val deviceId = ServiceLocator.deviceId
        try {
            firestore.collection("devices").document(deviceId)
                .collection("locations")
                .add(
                    mapOf(
                        "deviceId" to deviceId,
                        "lat" to location.latitude,
                        "lng" to location.longitude,
                        "accuracyMeters" to location.accuracy.toDouble(),
                        "speedMps" to if (location.hasSpeed()) location.speed.toDouble() else null,
                        "altitudeMeters" to if (location.hasAltitude()) location.altitude else null,
                        "source" to source,          // "oneshot" | "live" | "sos"
                        "reason" to reason,
                        "timestamp" to FieldValue.serverTimestamp(),
                    ),
                ).await()
        } catch (e: Exception) {
            // Offline: drop the fix (location history is not worth queueing).
        }
    }

    /** Snapshot map used by EmergencyManager for SOS events. */
    fun snapshotMap(): Map<String, Any?>? {
        val loc = lastKnown ?: return null
        return mapOf(
            "lat" to loc.latitude,
            "lng" to loc.longitude,
            "accuracyMeters" to loc.accuracy.toDouble(),
        )
    }

    companion object {
        /** Convenience intents for [LocationService]. */
        fun startIntent(context: Context): Intent =
            Intent(context, LocationService::class.java).setAction(LocationService.ACTION_START)

        fun stopIntent(context: Context): Intent =
            Intent(context, LocationService::class.java).setAction(LocationService.ACTION_STOP)
    }
}
