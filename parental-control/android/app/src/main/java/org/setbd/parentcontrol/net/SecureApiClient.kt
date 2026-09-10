package org.setbd.parentcontrol.net

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.appcheck.FirebaseAppCheck
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.setbd.parentcontrol.BuildConfig
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * SecureApi — HTTP client for the trusted backend (Cloudflare Worker).
 *
 * Replaces the Firebase Callable Functions channel on the ZERO-COST
 * deployment (Cloud Functions require the Blaze plan; the Worker is free):
 *
 *   POST {SECURE_API_BASE}/api/secure/<name>
 *   Authorization: Bearer <Firebase ID token>     identity, verified
 *                             server-side via Admin SDK (checkRevoked)
 *   X-Firebase-Appcheck: <token>                  optional attestation
 *   body: JSON payload (same shape the callables used)
 *
 *   2xx → { "ok": true,  "data": { …result… } }   → returns data map
 *   err → { "error": { "code": "…", "message": "…" } } → SecureApiException
 *
 * SECURITY:
 *  - NO backend credentials exist in the APK: identity = the device's own
 *    Firebase Auth token; backup upload/download URLs are short-lived,
 *    HMAC-signed, single-object grants issued by the Worker.
 *  - The base URL is a build-time constant (gradle property / CI variable
 *    SECURE_API_BASE) — it carries no secret.
 *  - Every response code maps to the same friendly messages the callable
 *    channel produced (see PairingManager.describeError).
 */
object SecureApi {

    /** True when this build carries a backend URL (gradle/CI injects it). */
    val isConfigured: Boolean
        get() = BuildConfig.SECURE_API_BASE.isNotBlank()

    /**
     * Calls a privileged endpoint. Returns the `data` map on success.
     * Throws [SecureApiException] for server-defined errors, [IOException]
     * for transport failures (offline, DNS, timeout).
     *
     * SELF-HEALING: if the first attempt dies with 401 `unauthenticated` and
     * the request used a cached ID token, the call is retried ONCE with a
     * force-refreshed token. This kills the whole class of "sign in expired"
     * failures caused by a stale cached token (app sitting on a screen for
     * >1 h, or a device clock running behind so the SDK believes an expired
     * token is still fresh).
     *
     * @param forceRefreshToken always mint a fresh ID token first (use for
     *   rare, security-sensitive calls like confirmPairing).
     */
    suspend fun call(
        name: String,
        data: Map<String, Any?>,
        forceRefreshToken: Boolean = false,
    ): Map<String, Any?> = withContext(Dispatchers.IO) {
        try {
            callOnce(name, data, forceRefreshToken)
        } catch (e: SecureApiException) {
            if (e.code == "unauthenticated" && !forceRefreshToken) {
                callOnce(name, data, forceRefreshToken = true)
            } else {
                throw e
            }
        }
    }

    private suspend fun callOnce(
        name: String,
        data: Map<String, Any?>,
        forceRefreshToken: Boolean,
    ): Map<String, Any?> = withContext(Dispatchers.IO) {
            val base = BuildConfig.SECURE_API_BASE.trim().trimEnd('/')
            if (base.isBlank()) {
                throw SecureApiException(
                    "unavailable",
                    "Backend URL is not configured in this build (SECURE_API_BASE)."
                )
            }

            val user = FirebaseAuth.getInstance().currentUser
                ?: throw SecureApiException(
                    "unauthenticated",
                    "Not signed in yet."
                )
            // forceRefreshToken=true mints a fresh token even if the cached
            // one looks valid (defeats stale-token + device-clock skew);
            // otherwise the cached token is fine — the server verifies it
            // (and checks revocation) anyway, and the 401 retry above heals.
            val idToken = user.getIdToken(forceRefreshToken).await().token
                ?: throw SecureApiException("unauthenticated", "No ID token.")

            val appCheckToken = runCatching {
                FirebaseAppCheck.getInstance().getAppCheckToken(false).await().token
            }.getOrNull()

            val conn = URL("$base/api/secure/$name").openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.setRequestProperty("Authorization", "Bearer $idToken")
                if (!appCheckToken.isNullOrBlank()) {
                    conn.setRequestProperty("X-Firebase-Appcheck", appCheckToken)
                }

                conn.outputStream.use { out ->
                    out.write(JSONObject(data).toString().toByteArray(Charsets.UTF_8))
                }

                val code = conn.responseCode
                val body = runCatching {
                    (conn.errorStream ?: conn.inputStream).bufferedReader().readText()
                }.getOrDefault("{}")

                if (code in 200..299) {
                    val root = JSONObject(body)
                    val ok = root.optBoolean("ok", false)
                    val dataObj = root.optJSONObject("data")
                    if (!ok || dataObj == null) {
                        throw SecureApiException("internal", "Malformed server response.")
                    }
                    return@withContext dataObj.toMutableMap()
                }

                // Error shape: { error: { code, message } }
                val err = runCatching { JSONObject(body).optJSONObject("error") }.getOrNull()
                val errCode = err?.optString("code").takeUnless { it.isNullOrBlank() } ?: "internal"
                val errMsg = err?.optString("message").takeUnless { it.isNullOrBlank() }
                    ?: "Request failed (HTTP $code)."
                throw SecureApiException(errCode, errMsg)
            } catch (e: SecureApiException) {
                throw e
            } catch (e: Exception) {
                if (e is IOException) throw e
                throw SecureApiException("internal", e.message ?: "Unexpected error.")
            } finally {
                conn.disconnect()
            }
        }

    private fun JSONObject.toMutableMap(): MutableMap<String, Any?> {
        val out = mutableMapOf<String, Any?>()
        for (key in keys()) {
            out[key] = when (val v = opt(key)) {
                is JSONObject -> v.toMutableMap()
                is org.json.JSONArray -> v
                JSONObject.NULL -> null
                else -> v
            }
        }
        return out
    }
}

/** Server-defined error — [code] mirrors the callable error codes. */
class SecureApiException(val code: String, message: String) : Exception(message)
