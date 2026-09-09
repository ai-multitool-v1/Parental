# Deployment Guide

> Step-by-step: Firebase project setup → services → rules & functions deploy →
> custom claims verification → web env → Android build & enrollment → emulator
> test run → production hardening → Play Store notes.

---

## 1. Prerequisites

* Node.js 20.x (functions runtime `nodejs20`), npm ≥ 10
* Firebase CLI ≥ 13 (`npm i -g firebase-tools`)
* Java 17+ (Firestore emulator for the rules tests)
* An Android device/emulator for the child app (Task 2-a artifacts)
* Owner access on a Google account for the Firebase project

## 2. Create the Firebase project

1. console.firebase.google.com → **Add project** → name it (e.g.
   `family-safety-prod`) → enable Google Analytics *optional*.
2. **Upgrade to Blaze** (required for Cloud Functions v2 + Scheduler).
3. Project settings → **Add app: Web** (for the dashboard) → copy the
   `firebaseConfig` values; **Add app: Android** (package id from the Android
   project) → download `google-services.json` into the Android app module.

## 3. Enable services

| Service | Where | Notes |
|---|---|---|
| Authentication | Auth → Sign-in method | Enable **Email/Password** (parents) and **Anonymous** (child device identities). Optional: **MFA (TOTP)** |
| Firestore | Firestore Database → Create | **Production mode**, pick region (e.g. `us-central1` — must match functions `REGION`) |
| Cloud Functions | via CLI deploy (Blaze) | nodejs20 runtime |
| Cloud Scheduler | automatic with scheduled functions | first deploy creates jobs |
| FCM | automatic | upload APNs key only if iOS ever added |
| App Check | App Check → register | Web: reCAPTCHA Enterprise · Android: Play Integrity. Start in **monitor** mode |

## 4. Deploy rules, indexes, functions

All commands run from the firebase config directory (paths in
`firebase.json` are relative to it):

```bash
cd parental-control/firebase
firebase login
firebase use --add                     # alias your project
firebase deploy --only firestore:rules,firestore:indexes
cd ../functions && npm install && cd ../firebase
firebase deploy --only functions
```

* `functions` predeploy runs `npm run build` (tsc) automatically.
* Expected exports: `generatePairingCode, confirmPairing, dispatchCommand,
  onCommandResult, cleanupExpired, requestSession, onSessionUpdate,
  cleanupSessions, onSosCreated, escalationCheck, sendParentNotification,
  onParentLogin, onUserDeleted, retentionPurge`.
* After deploy, set the App Check mode:

```bash
firebase functions:secrets:set APP_CHECK_MODE   # value: soft  (rollout)
# later: hard
```

(`APP_CHECK_MODE` is a defined param with default `soft`; re-deploy after
changing.)

## 5. Custom claims flow (verification)

Claims are set automatically by `confirmPairing` — nothing to provision
manually. Verify after a real pairing:

```bash
# 1) call generatePairingCode from the dashboard, note the code
# 2) in the child app, enter the code (device is signed-in anonymously)
# 3) check claims:
node -e '
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault() });
admin.auth().getUser("<childUid>").then(u => console.log(u.customClaims));
'
# expect: { deviceRole: "childDevice", deviceId: "<uuid>" }
```

If the device seems unresponsive to rules after pairing, force a token
refresh in the app (`getIdToken(true)`) — claims ride on refreshed tokens.

## 6. Web dashboard environment

Create `.env.local` at the **repo root** (Next.js):

```dotenv
NEXT_PUBLIC_FIREBASE_API_KEY=AIza...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=family-safety-prod.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=family-safety-prod
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=family-safety-prod.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=000000000000
NEXT_PUBLIC_FIREBASE_APP_ID=1:000:web:abc
NEXT_PUBLIC_FIREBASE_VAPID_KEY=...        # optional: web push for parents
```

Notes:

* These values are public by design; protection comes from rules + App Check,
  never from hiding the config.
* Without the variables the dashboard runs in **demo mode** (mock data) —
  documented in the root README.

## 7. Android build & enrollment

1. Place `google-services.json` in the app module; `cd parental-control/android`
   (Task 2-a) and build `./gradlew :app:assembleDebug`.
2. Install: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
3. Sign in path: the app auto-creates its **anonymous** device identity at
   first run and generates the `deviceId` UUID.
4. Pair: dashboard → "Add device" → read the 8-char code into the child app.
5. **Device-owner enrollment (testing kiosk-like lock only):**

```bash
adb shell dpm set-device-owner com.family.safety/.admin.DeviceAdminReceiver
```

* Not required for normal operation; the consent-based lock uses a full-screen
  activity, not device-admin lockdown. Remove with
  `adb shell dpm remove-active-admin ...` before Play builds.
6. Play build: use the `flavourPlaySafe` flavour (omits
   QUERY_ALL_PACKAGES) until the sensitive-permission declaration is
   approved (see §11).

## 8. Emulator test run

```bash
cd parental-control/firebase
npm install                     # rules-testing deps
npm test                        # boots Firestore emulator, runs §38 suite
```

Functions + full stack locally:

```bash
cd parental-control/firebase
firebase emulators:start        # auth 9099, firestore 8080, functions 5001, UI 4000
# another shell:
cd ../functions && npm run serve
```

Point the web dashboard + Android app at emulators (10.0.2.2 from the
emulator). Emulator data is ephemeral — perfect for §38 regression runs.

## 9. Production hardening checklist

- [ ] `APP_CHECK_MODE=hard` after ≥1 week ≥99 % verified traffic
- [ ] MFA (TOTP) enforced for parent accounts
- [ ] Enable the `onParentLogin` blocking function in Console → Auth →
      Blocking functions (email/password provider only; leave anonymous off)
- [ ] Firestore daily backups enabled (console → Firestore → PITR/backups)
- [ ] Budget alert + quota alerts (FCM, function invocations)
- [ ] Cloud Logging alerts on DENIED audit spikes (`COMMAND_REPLAY_BLOCKED`,
      `LOGIN_BLOCKED`, `PAIRING_CODE_*` anomalies)
- [ ] BigQuery export extension for `auditLogs` (long-term immutable trail)
- [ ] Review IAM: project has minimal editors; service-account keys unused
      (functions use built-in credentials)
- [ ] Verify `storage.rules` deny-all deployed (no buckets writable)
- [ ] Run `docs/testing.md` §38 suite against **staging project** with the
      production rules bundle
- [ ] Confirm retention job ran: top-level `auditLogs` contains
      `RETENTION_PURGE` summary after day 1

## 10. Operational runbook (quick)

| Task | Command / place |
|---|---|
| Function logs | `firebase functions:log` or Cloud Logging |
| Force command expiry now | scheduled `cleanupExpired` runs every 5 min; or console → run function |
| Immediate erasure (one device) | console → delete parent auth user (triggers cascade) or `db.recursiveDelete(devices/{id})` |
| Rotate App Check mode | `firebase functions:secrets:set APP_CHECK_MODE` + redeploy |
| Change escalation default | `users/{uid}/settings.escalationMinutes` (per parent) |

## 11. Play Store notes (parental control category)

1. **Permissions declaration**: App content → Sensitive permissions → request
   QUERY_ALL_PACKAGES with a demo video (inventory, usage, blocking).
2. **Data safety form**: declare location, app interactions, device IDs;
   state collection is user-facing with deletion available; encryption in
   transit = yes.
3. **Target audience**: must be consistent with a *parent*-installed
   monitoring app; include the child-facing consent disclosure screenshots.
4. **Foreground service types** (Android 14): declare location/dataSync/
   mediaProjection/camera/microphone in the Play "FGS permissions" declaration
   with demos of the consent overlay.
5. **Account deletion URL**: required by Play — point it at the dashboard
   "Delete account" flow (drives `onUserDeleted`).
6. Keep the `flavourPlaySafe` build as the release fallback so a declaration
   delay never blocks ship.

---

*After your first end-to-end pairing on staging, capture `devices/{id}` and
one audit entry in the deployment ticket — that is the "green light" record
that claims + rules + functions all agree.*

## 12. Developer Admin system (v1.2.0)

The platform ships a Developer Admin Console for moderation: registered
users (UID, email, last login, live sessions), device registry, user/device
ban-unban, force logout, and a merged platform + admin audit trail.

### 12.1 Surfaces

| Surface | Path / entry | Notes |
|---|---|---|
| Web console | `/admin` (this repo, `src/app/admin/`) | separate credentials, no link from the parent dashboard by design |
| Ban callable | `adminSetBanState` (`functions/src/admin/`) | custom-claim guarded, App Check + rate limited |
| Claim bootstrap | `functions/scripts/setAdminClaim.ts` | the ONLY way to become admin |
| Android | — | child app has no admin surface by design |

### 12.2 Granting an admin (production)

```bash
cd functions
npx ts-node scripts/setAdminClaim.ts admin@yourdomain.com
# revoke:
npx ts-node scripts/setAdminClaim.ts admin@yourdomain.com --revoke
```

The `admin: true` custom claim lives inside the Auth token; it cannot be
forged by any client, document write, or rules path. Granting also revokes
existing refresh tokens so claims take effect immediately.

### 12.3 Enforcement chain (defense in depth)

1. **Login** — `onParentLogin` blocking function refuses `users/{uid}.banned == true`
   (audits `LOGIN_BLOCKED/banned_by_admin`).
2. **Commands** — `dispatchCommand` refuses when `devices/{id}.banned` or
   `users/{uid}.banned` (audits `COMMAND_BLOCKED_*`).
3. **Telemetry** — Firestore rules deny ALL device writes while
   `devices/{id}.banned == true` (T42); the flag itself is SDK-writable only.
4. **Sessions** — banning a user revokes their refresh tokens.
5. **Rules** — admin claim grants additive READ on `users` + `devices` and
   read-only on `adminAudit`; clients can never write either
   (T39–T41 in the rules test matrix).

### 12.4 Demo-mode notes (web console without Firebase) — v1.4.1 SECURITY REWRITE

⚠️ v1.4.0-এর in-browser simulation (hardcoded `admin / setbd-admin-2025`
ক্রেডেনশিয়াল + sessionStorage registry) **সরানো হয়েছে** — client bundle-এ
কোনো privileged secret আর থাকে না। নতুন মডেল (server-authoritative):

- **Credentials live only on the server** (`.server/admin-credentials.json`,
  mode 0600, gitignored — scrypt hash). On first boot a 24-char random
  bootstrap password is generated and printed ONCE to the server console
  (`ADMIN_BOOTSTRAP_CREDENTIALS` log line). Retrieve it from the server
  log, or set `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` env (format:
  `16384$8$1$<salt b64>$<hash b64>`, scrypt-64) before first login.
  Rotate/regenerate: delete `.server/admin-credentials.json` and restart.
- **Login** → `POST /api/admin/login` (server-side verify, 5 fails → 5 min
  durable lockout via `.server/attempt-ledger.json`) → httpOnly signed
  session cookie (`fs_admin_session`, 1 h TTL).
- **Registry** (users/devices/ban/plan/audit) persists server-side at
  `.server/admin-registry.json`; the client zustand store is a hydrated
  read-mostly mirror. Every mutation (`banUser`, `setPlan`, …) is verified
  and audited server-side (`POST /api/admin/registry`).
- Parent accounts are REAL now too: `/api/auth/signup` + `/api/auth/login`
  with scrypt-hashed passwords (`.server/auth-users.json`) — no
  auto-registration, per-email+IP lockout, distinct error states. These
  demo stores map 1:1 to Firebase Auth + Firestore in production.
