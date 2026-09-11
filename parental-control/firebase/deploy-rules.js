/**
 * Deploys firestore.rules via the Firebase Admin SDK (SecurityRules API).
 *
 * WHY NOT `firebase deploy --only firestore:rules`:
 *   firebase-tools runs a serviceusage.googleapis.com preflight
 *   ("is the Firestore API enabled") that requires
 *   roles/serviceusage.serviceUsageViewer — a permission the deploy
 *   service account intentionally does NOT have (403 in CI, run 15d9b1a).
 *   The Admin SDK talks to firebaserules.googleapis.com directly and
 *   skips that preflight entirely.
 *
 * Usage (from parental-control/firebase/):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json \
 *     node deploy-rules.js firestore.rules <PROJECT_ID>
 *
 * Requires firebase-admin (CI installs it with `npm i --no-save firebase-admin`).
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

async function main() {
  const [rulesFile, projectId] = process.argv.slice(2);
  if (!rulesFile || !projectId) {
    console.error("usage: node deploy-rules.js <rulesFile> <projectId>");
    process.exit(2);
  }

  const source = fs.readFileSync(path.resolve(rulesFile), "utf8");
  if (!source.includes("service cloud.firestore")) {
    console.error(`refusing to deploy: ${rulesFile} does not look like a Firestore rules file`);
    process.exit(2);
  }

  const app = admin.initializeApp({ projectId });
  const rulesetName = await admin.securityRules(app).releaseFirestoreRulesetFromSource(source);
  console.log(`Released Firestore ruleset: ${rulesetName}`);
  await app.delete();
}

main().catch((err) => {
  console.error("RULES DEPLOY FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
