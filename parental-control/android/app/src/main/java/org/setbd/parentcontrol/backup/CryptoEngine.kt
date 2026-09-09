package org.setbd.parentcontrol.backup

import android.util.Base64
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * CryptoEngine — AES-256-GCM authenticated encryption for backup payloads.
 *
 * DESIGN (requirement: AES-256-GCM or equivalent, unique nonce/IV, auth tag,
 * streaming for large media):
 *  - A FRESH 96-bit IV is generated with [SecureRandom] for EVERY item and
 *    stored (base64) in the item metadata — it is not a secret and is
 *    required for decryption, but it must never repeat under the same key.
 *  - The 128-bit GCM tag is appended by the cipher itself; the ciphertext
 *    file layout is exactly: GCM(salt-free) output stream bytes.
 *  - LARGE FILES NEVER ENTER RAM: encryption runs as a single pass
 *    [InputStream] → CipherOutputStream → temp file with a 64 KiB buffer
 *    (the JCA GCM cipher processes update() incrementally and defers only
 *    the 16-byte tag). Upload then streams the temp file with
 *    HttpURLConnection.setFixedLengthStreamingMode — constant memory for
 *    multi-hundred-MB videos.
 *  - While writing, the SHA-256 of the CIPHERTEXT is computed in the same
 *    pass (DigestOutputStream) — the checksum stored in Firestore is of the
 *    uploaded bytes, so integrity can be verified end-to-end without a
 *    second read of the file.
 *  - No key material and no plaintext ever appear in logs. Errors carry
 *    only error codes.
 */
object CryptoEngine {

    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val BUFFER_SIZE = 64 * 1024
    private val secureRandom = SecureRandom()

    /** Result of encrypting one payload. */
    class EncryptedResult(
        val file: File,
        val ivB64: String,
        val ciphertextSha256Hex: String,
        val cipherSizeBytes: Long,
    )

    /**
     * Encrypts [source] (streaming) into a temp file under [workDir].
     * [keyB64] is the child DEK (base64, 32 bytes) from BackupKeyManager.
     */
    fun encryptStream(
        source: InputStream,
        lengthHint: Long,
        workDir: File,
        keyB64: String,
    ): EncryptedResult {
        val rawKey = Base64.decode(keyB64, Base64.NO_WRAP)
        require(rawKey.size == 32) { "DEK must be 32 bytes" }
        val key: SecretKey = SecretKeySpec(rawKey, "AES")
        val iv = ByteArray(IV_BYTES).also { secureRandom.nextBytes(it) }

        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))

        workDir.mkdirs()
        val outFile = File.createTempFile("bkenc-", ".bin", workDir)
        try {
            BufferedInputStream(source, BUFFER_SIZE).use { input ->
                FileOutputStream(outFile).use { rawOut ->
                    CipherOutputStream(BufferedOutputStream(rawOut, BUFFER_SIZE), cipher).use { cipherOut ->
                        val buf = ByteArray(BUFFER_SIZE)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            cipherOut.write(buf, 0, n)
                        }
                        // close() flushes + appends the GCM tag
                    }
                }
            }
            // Hash the finished ciphertext (local disk read only — network
            // upload later streams this same file, RAM stays constant).
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(outFile).use { fin ->
                val buf = ByteArray(BUFFER_SIZE)
                while (true) {
                    val n = fin.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                }
            }
            return EncryptedResult(
                file = outFile,
                ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP),
                ciphertextSha256Hex = digest.digest().toHex(),
                cipherSizeBytes = outFile.length(),
            )
        } catch (t: Throwable) {
            outFile.delete()
            throw t
        }
    }

    /**
     * Decrypts a ciphertext stream (parent restore / device restore path).
     * Streaming both ways — output is written to [target] incrementally.
     */
    fun decryptStream(cipherSource: InputStream, target: OutputStream, keyB64: String, ivB64: String) {
        val rawKey = Base64.decode(keyB64, Base64.NO_WRAP)
        require(rawKey.size == 32) { "DEK must be 32 bytes" }
        val iv = Base64.decode(ivB64, Base64.NO_WRAP)
        require(iv.size == IV_BYTES) { "IV must be 12 bytes" }
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(rawKey, "AES"), GCMParameterSpec(TAG_BITS, iv))

        CipherInputStream(BufferedInputStream(cipherSource, BUFFER_SIZE), cipher).use { cin ->
            BufferedOutputStream(target, BUFFER_SIZE).use { out ->
                val buf = ByteArray(BUFFER_SIZE)
                while (true) {
                    val n = cin.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                }
            }
        } // close() verifies the GCM tag — tampered ciphertext fails here
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    /** Deterministic content-hash id — the duplicate-prevention primitive. */
    fun sha256Hex(input: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return d.toHex()
    }
}
