# parental-worker — Trusted Backend (ZERO-COST / Spark plan)

Cloudflare Workers-এর উপর চলা প্ল্যাটফর্মের trusted backend. **Firebase Blaze
plan লাগে না** — Auth (Email/Password + Anonymous) আর Firestore Spark free tier-এই
চলে; শুধু privileged logic এই Worker-এ সরিয়ে আসা হয়েছে (Cloud Functions
Blaze-only বলে)।

## Architecture

```
Android app / Web dashboard
   │
   ├── Firebase Auth  (Spark, free — identity + custom claims)
   ├── Firestore      (Spark, free — rules T01–T50 gate ALL client access)
   │
   └── HTTPS → this Worker  (free: 100k req/day)
                ├── verifies EVERY request's Firebase ID token (Admin SDK,
                │   checkRevoked=true) — "trusted" ≠ "assumed": per-request
                │   authentication + authorization (pairing links, ban gates,
                │   premium plan gates, sliding-window rate limits, audits)
                ├── drives consent state machine / command lifecycle
                ├── pushes FCM (commands, notifications, SOS escalation)
                └── PRIVATE R2 bucket via NATIVE BINDING — no R2 access keys
                    exist anywhere; backup objects move through short-lived
                    HMAC-signed single-object URLs (10-min PUT / 5-min GET)
```

## Endpoints

| Endpoint | Caller | Purpose |
|---|---|---|
| `POST /api/secure/generatePairingCode` | parent | 8-char single-use pairing code (5-min TTL) |
| `POST /api/secure/confirmPairing` | device | consume code → device doc + parent link + claims |
| `POST /api/secure/dispatchCommand` | parent | whitelisted command + FCM push |
| `POST /api/secure/commandResult` | device | replay-protected result + consent machine |
| `POST /api/secure/requestSession` | parent | consent-gated SCREEN/CAMERA/AUDIO session |
| `POST /api/secure/endSession` | device | child stops a session |
| `POST /api/secure/sendParentNotification` | parent | message + FCM to device |
| `POST /api/secure/backupSetPolicy` | parent | per-category backup switches (premium) |
| `POST /api/secure/backupGetKey` | device/parent | DEK unwrap (audited, premium for parent) |
| `POST /api/secure/backupCreateUploadUrl` | device | eligibility gate + signed PUT URL |
| `POST /api/secure/backupCompleteUpload` | device | HEAD-verify then UPLOADED |
| `POST /api/secure/backupGetDownloadUrl` | parent | signed GET URL (premium) |
| `POST /api/secure/backupListForChild` | device | phone-reset restore listing |
| `POST /api/secure/adminSetBanState` / `adminSetPlan` | admin (`admin:true` claim) | admin console |
| `PUT /backup/put?k&e&s` / `GET /backup/get?k&e&s` | signed | R2 proxy (HMAC-verified, expiring) |
| cron `0 3 * * *` | — | sweep: expire commands/codes, close sessions, retention purge, SOS escalation |

## Deploy — two ways (both FREE)

### Way A (recommended — GitHub Actions, kono local tool lagbe na)

1. Cloudflare dashboard → top-right avatar → **My Profile → API Tokens →
   Create Token** → template **"Edit Cloudflare Workers"** → permissions-এ
   আরও যোগ করুন: **Account · R2 · Edit** → Account Resources: আপনার account →
   **Continue → Create Token** → token copy করুন (একবারই দেখাবে)।
2. GitHub repo → **Settings → Secrets and variables → Actions → Secrets →
   New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = ওই token
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = Firebase console → Project settings →
     Service accounts → **Generate new private key** → পুরো JSON ফাইলের ভেতরের
     text (Admin SDK — token verify / Firestore / FCM-এর জন্য)
   - (optional) `BACKUP_KEK` + `BACKUP_URL_SECRET` — না দিলে প্রথম deploy-এ
     নিজে থেকেই সুরক্ষিতভাবে তৈরি হয়ে যাবে, পরে স্থায়ীভাবে থাকবে।
3. GitHub **Actions → Deploy Cloudflare Worker → Run workflow** → শেষ হলে
   deploy log-এ Worker URL দেখবেন:
   `https://parental-control-api.<your-subdomain>.workers.dev`

### Way B (local CLI)

```bash
cd worker
npm install
npx wrangler login

# 1. Backup bucket (free: 10 GB + free egress) — না থাকলেই তৈরি হবে
npx wrangler r2 bucket create parental

# 2. Secrets (NEVER in wrangler.jsonc / git / APK)
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # Firebase console → Project settings → Service accounts → Generate new private key
npx wrangler secret put BACKUP_KEK                      # openssl rand -base64 32
npx wrangler secret put BACKUP_URL_SECRET               # openssl rand -hex 32

# 3. Deploy
npx wrangler deploy
```

Worker URL পাবেন: `https://parental-control-api.<your-subdomain>.workers.dev`

## Wire the clients

1. **Android APK**: GitHub repo → **Settings → Secrets and variables → Actions →
   Variables** → `SECURE_API_BASE = https://parental-control-api.<sub>.workers.dev`
   → Actions-এ re-run করলেই নতুন APK-তে URL বসে যাবে (অথবা লোকালে
   `./gradlew assembleDebug -PSECURE_API_BASE=...`).
2. **Web dashboard** (`.env`):
   ```
   NEXT_PUBLIC_FIREBASE_API_KEY=…
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=parental-control-31fb5
   NEXT_PUBLIC_FIREBASE_APP_ID=…
   NEXT_PUBLIC_SECURE_API_BASE=https://parental-control-api.<sub>.workers.dev
   ```
3. **CORS**: browser থেকে dashboard চালালে `wrangler.jsonc`-এর
   `ALLOWED_ORIGINS` আপনার dashboard origin দিয়ে replace করুন (`*` শুধু test-এ)।

## Security model (per-request, never assumed)

- Identity: Bearer Firebase ID token — Admin `verifyIdToken(token, checkRevoked=true)`;
  client-supplied uid/claims are never trusted.
- Authorization: parent = `devices/{id}/parents/{uid}` link (written ONLY by
  `confirmPairing`); device = custom claims `{deviceRole:"childDevice", deviceId}`.
- Ban gates on every request (user + device), premium gates on plan-gated ops,
  Firestore sliding-window rate limits, append-only audit log.
- App Check: soft by default; `ENFORCE_APP_CHECK="1"` var flips it to hard.
- BACKUP_KEK wraps each child's DEK (AES-256-GCM, WebCrypto) — plaintext key
  material exists only in Worker memory + the device; never in Firestore/R2/logs.

## Troubleshooting

- **"Server is not configured"** → `FIREBASE_SERVICE_ACCOUNT_JSON` secret সেট নেই।
- **Backup UNAVAILABLE** → R2 bucket তৈরি না হয়েছে বা `BACKUP_URL_SECRET`/`BACKUP_KEK` নেই।
- **Live logs**: `npx wrangler tail`।
- firestore rules/indexes আগে deploy করা থাকতেই হবে
  (`parental-control/firebase/` — `firebase deploy --only firestore:rules,firestore:indexes`
  — এটা free plan-এও চলে)।
