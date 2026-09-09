/**
 * generatePairingCode.ts — callable: parent requests a pairing code.
 *
 * Flow:
 *   1. Caller must be a signed-in parent (App Check enforced).
 *   2. Rate limited (10 codes/hour) and capped at 5 ACTIVE codes.
 *   3. Generates a cryptographically random 8-character code
 *      (32-symbol alphabet without 0/O/1/I → 40 bits, unbiased because 32
 *      divides 256).
 *   4. Writes top-level pairingCodes/{code}:
 *        { code, parentUid, used: false, usedByDeviceId: null,
 *          createdAt, expiresAt = now + 5 min }
 *      NOTE: clients can NEVER read or write pairingCodes (rules deny all);
 *      only Admin SDK touches them. The parent dashboard receives the code
 *      in the callable RESULT (parent then reads it aloud / types it into
 *      the child device).
 *   5. Audits PAIRING_CODE_GENERATED.
 *
 * The child device confirms via confirmPairing(code, deviceId, deviceName).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { assertAppCheck, db, enforceRateLimit, requireSignedIn } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import {
  MAX_ACTIVE_PAIRING_CODES_PER_PARENT,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  REGION,
} from "../lib/constants";

export const generatePairingCode = onCall(
  { region: REGION, timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const uid = requireSignedIn(request);
    assertAppCheck(request);
    await enforceRateLimit(
      `pairing-code:${uid}`,
      { max: 10, windowMs: 60 * 60 * 1000 },
      "Too many pairing codes requested. Please wait before trying again."
    );

    // Cap concurrent active codes per parent (limits shoulder-surf exposure).
    const activeCount = await db()
      .collection("pairingCodes")
      .where("parentUid", "==", uid)
      .where("used", "==", false)
      .count()
      .get();
    if ((activeCount.data().count ?? 0) >= MAX_ACTIVE_PAIRING_CODES_PER_PARENT) {
      throw new HttpsError(
        "resource-exhausted",
        `You already have ${MAX_ACTIVE_PAIRING_CODES_PER_PARENT} active pairing codes. Wait for them to expire.`
      );
    }

    const code = generateUnbiasedCode();
    const expiresAt = Timestamp.fromMillis(Date.now() + PAIRING_CODE_TTL_MS);

    await db().doc(`pairingCodes/${code}`).set({
      code,
      parentUid: uid,
      used: false,
      usedByDeviceId: null,
      usedByChildUid: null,
      usedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    await writeAudit({
      functionName: "generatePairingCode",
      actorUid: uid,
      actorType: "PARENT",
      action: "PAIRING_CODE_GENERATED",
      result: "ALLOWED",
      details: { expiresAt: expiresAt.toMillis() },
    });

    return {
      code,
      expiresAt: expiresAt.toMillis(),
      ttlSeconds: PAIRING_CODE_TTL_MS / 1000,
    };
  }
);

/**
 * randomBytes-based code. With a 32-symbol alphabet, byte % 32 is UNBIASED
 * because 256 % 32 == 0 (no modulo bias). 40 bits of entropy means a
 * brute-force attempt at 1000 guesses/second needs ~35 years on average —
 * and codes die after 5 minutes and are single-use.
 */
function generateUnbiasedCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}
