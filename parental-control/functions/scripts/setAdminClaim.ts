/**
 * setAdminClaim.ts — bootstrap script: grant/revoke the `admin` custom claim.
 *
 * Usage (from functions/):
 *   npx ts-node scripts/setAdminClaim.ts <user-email-or-uid> [--revoke]
 *
 * This is the ONLY way an account becomes a platform admin. The claim is
 * stored inside the Auth token — it can never be edited from any client,
 * dashboard, or Firestore write. Every adminSetBanState call verifies
 * request.auth.token.admin === true.
 *
 * SECURITY: run this with a service account that has Firebase Admin
 * privileges; never ship the key to a client or commit it to the repo.
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

async function main() {
  const [target, flag] = process.argv.slice(2);
  if (!target) {
    console.error("Usage: npx ts-node scripts/setAdminClaim.ts <email|uid> [--revoke]");
    process.exit(1);
  }
  const revoke = flag === "--revoke";

  initializeApp({ credential: applicationDefault() });

  let uid = target;
  if (target.includes("@")) {
    const user = await getAuth().getUserByEmail(target);
    uid = user.uid;
  }

  await getAuth().setCustomUserClaims(uid, { admin: !revoke });
  // Force existing sessions to re-evaluate claims within the hour.
  await getAuth().revokeRefreshTokens(uid);

  console.log(
    revoke
      ? `admin claim REMOVED from ${uid}`
      : `admin claim GRANTED to ${uid} — verify via getAuth().getUser(${uid}).customClaims`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
