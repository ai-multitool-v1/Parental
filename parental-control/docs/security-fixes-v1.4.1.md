# Security Fixes Report — v1.4.1

তারিখ: ২০২৬-০৯-০৯ · স্কোপ: ওয়েব ড্যাশবোর্ড (src/), Firebase backend
(parental-control/functions + firebase/), Android child app
(parental-control/android/)

---

## CRITICAL FIX #1 — Parent "লগইন" আসলে কোনো যাচাই-ই করত না

**ভালগুলাবিলিটি (সংক্ষেপে):**
- `src/lib/family/store.ts → login()`: যেকোনো non-empty email + যেকোনো
  password দিলেই `"ok"` রিটার্ন হতো — পাসওয়ার্ড কখনো verify হতো না।
- প্রথম লগইনেই `registerLogin()` নতুন অ্যাকাউন্ট auto-তৈরি করত
  (কোনো signup flow নেই)।
- ফলাফল: একজন attacker যেকোনো existing user-এর email দিয়ে (পাসওয়ার্ড
  না জেনেই) সরাসরি সেই অ্যাকাউন্টে ঢুকে যেতে পারত — সম্পূর্ণ
  authentication bypass, যার মধ্যে ব্যানকৃত ব্যবহারকারীর ড্যাশবোর্ডও ছিল।

**ফিক্স:**
- আলাদা **Sign up** ফর্ম (নাম + ইমেইল + পাসওয়ার্ড + পাসওয়ার্ড কনফার্ম) এবং
  **Log in** ফর্ম — `login-screen.tsx` ট্যাব-ভিত্তিক দুটি স্ক্রিন।
- **সার্ভার-সাইড ক্রেডেনশিয়াল ভেরিফিকেশন**:
  - `POST /api/auth/signup` → ইমেইল ফরম্যাট, নামের দৈর্ঘ্য, পাসওয়ার্ড
    নীতি (≥ ৮ অক্ষর) যাচাই; ডুপ্লিকেট ইমেইলে `ALREADY_EXISTS`।
  - `POST /api/auth/login` → **scrypt (N=16384, r=8, p=1, 16-byte salt,
    64-byte key)** দিয়ে hash compare — `timingSafeEqual`; কখনো plaintext
    সংরক্ষণ নেই। স্টোর: `.server/auth-users.json` (mode 0600, gitignored,
    server-only)।
- **Brute-force লকআউট**: প্রতি email + প্রতি IP বাকেটে ৫ বার ভুল → ৫ মিনিট
  লক (admin console-এর প্যাটার্ন অনুসরণ)। Ledger **file-backed**
  (`.server/attempt-ledger.json`) — dev hot-reload/রিস্টার্টেও টিকে থাকে।
- **নির্দিষ্ট error স্টেট**: `NO_ACCOUNT` ("অ্যাকাউন্ট নেই — সাইন আপ
  করুন"), `WRONG_PASSWORD`, `LOCKED` (retryAfterMs সহ), `BANNED`,
  `ALREADY_EXISTS`, `WEAK_PASSWORD`, `PASSWORD_MISMATCH`।
- **Auto-register সম্পূর্ণ অপসারিত** — unregistered email দিয়ে লগইন
  অসম্ভব।
- Ban + plan সিদ্ধান্ত এখন সার্ভারের registry থেকে (login route), client
  শুধু UX mirror।
- Production mapping: Firebase Auth (email/password) + onParentLogin
  blocking function — `firebase.ts` mapping docs হালনাগাদ।

**যাচাই:** curl contract test ×১১ কেস + browser E2E (signup → login →
ভুল পাসওয়ার্ড error → no-account error → ৫-বার lockout 429)।

---

## CRITICAL FIX #2 — Admin ক্রেডেনশিয়াল client bundle-এ hardcoded

**ভালগুলাবিলিটি:**
- `src/lib/family/admin-store.ts`-এ `ADMIN_USERNAME = "admin"` এবং
  `ADMIN_PASSWORD = "setbd-admin-2025"` client কোডে hardcoded — production
  JS bundle-এ shipped হতো। DevTools → Sources খুললেই যে কেউ পাসওয়ার্ড পেয়ে
  admin panel-এ ঢুকতে পারত।
- Ban/plan/registry স্টেট sessionStorage-এ persist হতো — client-এ
  edit/forge করা যেত; নিরাপত্তা boundary ছিল না।

**ফিক্স:**
- Client bundle থেকে ক্রেডেনশিয়াল **সম্পূর্ণ অপসারিত**। এখন:
  - `POST /api/admin/login` (server route) একমাত্র ভেরিফায়ার — scrypt
    hash `.server/admin-credentials.json` (0600, gitignored) থেকে।
  - **Bootstrap**: প্রথমবার ২৪-অক্ষরের cryptographically random পাসওয়ার্ড
    তৈরি হয়ে hash হয়ে সার্ভারে থাকে; plaintext একবার সার্ভার কনসোলে ছাপা
    হয় (`ADMIN_BOOTSTRAP_CREDENTIALS` লগ লাইন)। `ADMIN_USERNAME` /
    `ADMIN_PASSWORD_HASH` env দিয়ে override করা যায়।
  - সফল লগইনে **httpOnly + signed (HMAC-SHA256) session cookie**
    (`fs_admin_session`, ১ ঘণ্টা TTL)। Client কুকি পড়তে পারে না;
    প্রতিটি mutation-এ সার্ভারই verify করে।
- **Registry সার্ভারে সরানো হয়েছে** (`.server/admin-registry.json`):
  users/devices/ban/plan/audit সব সিদ্ধান্ত সার্ভারে; client zustand এখন
  hydrate-করা read-mostly mirror। sessionStorage persistence সম্পূর্ণ বাদ।
- API: `GET/POST /api/admin/registry` — ban/unban/forceLogout/setPlan
  admin-cookie বাধ্যতামূলক; self/admin-target protection ও সব action-এর
  audit সার্ভারে (`applyAdminAction`)।
- ডিভাইস রেজিস্ট্রেশন (pairing flow) admin অথবা **owner-matched parent
  session cookie** ছাড়া 401 — anonymous registry pollution বন্ধ।
- Production mapping: `admin: true` custom claim (Admin SDK/CLI —
  `functions/scripts/setAdminClaim.ts`) + Firestore rules `isAdmin()` +
  `adminSetBanState`/`adminSetPlan` callables — client-এ কোনো privileged
  secret নেই।

**যাচাই:** no-cookie registry access → 401; admin login → bootstrap
password; client bundle-এ ক্রেডেনশিয়াল নেই (constants অপসারিত)।

---

## ব্যাকএন্ড রি-ভেরিফিকেশন (defense-in-depth)

- **CRITICAL: `functions/src/lib/` সম্পূর্ণ অনুপস্থিত ছিল** — verify/audit/
  commands/constants/users/turn/backupKey/r2 মডিউল না থাকায় পুরো backend
  compile-ই হতো না (deploy অসম্ভব)। v1.4.1-এ ৮টি মডিউল hardened আকারে
  rebuild করা হয়েছে (tsc 0 errors):
  - `verify.ts` — fail-closed `requireParent` (devices/{id}/parents/{uid}
    link-only), App Check gate, transaction-ভিত্তিক distributed rate-limit
    ledger (hashed keys — PII-free doc ids), timing-safe compare।
  - `audit.ts` — append-only platform log + ADMIN_* action-এর adminAudit
    mirror + **hash-chain digests** (prevDigest → digest) tamper evidence।
  - `commands.ts` — ১৪-command whitelist, per-type payload whitelist
    (unknown key drop, size cap, control-char strip), single-use command
    docs, FCM TTL-bound push, duration clamp (≤ ১ ঘণ্টা, SCREEN বাদ —
    no-timer product rule)।
  - `constants.ts` — PREMIUM_COMMAND_TYPES এখন web-এর `PREMIUM_COMMANDS`
    (LOCK_DEVICE, ৩×REQUEST_*_SESSION, TRIGGER_SAFETY_CHECK) এর সাথে
    সঠিকভাবে synced।
  - `r2.ts` — dependency-free SigV4 presign (≤ ৯০০ সেকেন্ড clamp) +
    signed HEAD verification; server-generated keys (client কখনো key
    বাছে না)।
  - `backupKey.ts` — KEK (Secret Manager) দিয়ে wrapped per-child DEK;
    plaintext কখনো persist হয় না, buffer zeroize।
- `dispatchCommand.ts` — plan/ban gate আগে rate limit, পরে whitelist;
  অর্ডার ঠিক ✓; `requestSession.ts` — সব লাইভ সেশন premium-gated ✓;
  `backup.ts` — parent path-এ `requirePremiumParent` + device path-এ
  policy/consent/ban re-check (server pre-check) ✓; `adminSetPlan.ts` —
  self-target/admin-target DENIED + rate limit ✓।
- **firestore.rules**:
  - `users` update whitelist (`hasOnly`) — `plan`/`role`/`banned`/`admin`
    কোনোটা client-writable নয় ✓ (T29/T30)।
  - `devices` update — identity fields বাদ, banned-freeze বজায় ✓ (T42)।
  - **FIX: `devices/{id}/auditLogs` read এখন `isAdmin()`-only** — আগে
    `parentOfDevice()` দিয়ে parent read সম্ভব ছিল (v1.4.0 রিকোয়ারমেন্ট
    শুধু UI-তে enforce হয়েছিল, rules ফাঁক ছিল)। T27 ম্যাট্রিক্স আপডেট +
    T27a যোগ।

---

## Android রিভিউ (v1.4.1)

1. **Hardcoded secrets grep** (`AIza|api_key|secret|token = "…"`): পরিষ্কার
   — শুধু `google-services.json.example`-এ স্পষ্ট REPLACE-ME placeholder।
   কোনো TURN/R2/API secret APK-তে নেই।
2. **Network security config**: `usesCleartextTraffic="false"` ছিল; নতুন
   `res/xml/network_security_config.xml` যোগ হয়েছে — global cleartext
   deny + **system CAs only** (user-added CA দিয়ে MITM বন্ধ)। Manifest-এ
   `android:networkSecurityConfig` wired। **Cert pinning evaluation**
   (decision: এখন নয়, কারণ ডকুমেন্টেড): Firebase/GMS traffic Google-নিয়ন্ত্রিত
   cert rotation ভাঙবে; R2-তে authorization presigned URL-ই (≤ ১০ মিনিট) —
   pinning এখানে অপ্রয়োজনীয় ঝুঁকি। ভবিষ্যৎ self-hosted endpoint-এ scoped
   pin-set গাইডসহ ডকুমেন্টেড।
3. **Local storage**: `SecureStore` = EncryptedSharedPreferences (API 23+,
   AES256_GCM master key) — deviceId, pairing state, replay cache, policy
   cache, **backup DEK cache** সব এনক্রিপ্টেড; API 21/22 fallback honest
   ও dashboard-এ visible (`secureStorage: "plain"`)। Temp ciphertext
   `cacheDir`-এ, ব্যবহারের পরেই delete ✓।

---

## নতুন client-trust bug এড়ানোর নিয়ম (ভবিষ্যতের জন্য)

নতুন কোনো ফিচার/callable যোগ করার সময় এই চার স্তরের প্যাটার্ন বাধ্যতামূলক:
1. **App Check** — `assertAppCheck`/`requireParent` ভিতরে centrally।
2. **Rate limit** — `enforceRateLimit` (durable ledger)।
3. **Server-side plan/ban/ownership check** — client value কখনো trusted নয়।
4. **Audit log** — allow ও deny উভয় পাথ।

কোনো নতুন UI state কখনো নিরাপত্তা সিদ্ধান্তের উৎস হবে না (client = UX only)।

---

## ভেরিফিকেশন সামারি

| চেক | ফলাফল |
| --- | --- |
| `functions` tsc --noEmit | 0 errors |
| Web `tsc --noEmit` | 0 errors |
| `eslint .` | clean |
| `next build` (typed) | ✓ compiled, API routes registered |
| Auth API contract (11 কেস) | সব পাস |
| Lockout (parent + admin, durable) | ৫-বার → 429 LOCKED, সঠিক সময় |
| Registry authorization | no-cookie 401, parent-scope enforced |
| Browser E2E (signup/login/ban/premium/pairing/session modal) | সব পাস, zero console errors |
| Client bundle secrets | নেই (hardcoded অপসারিত) |

## এখনও রিভিউ/পরবর্তী ধাপ দরকার

1. **Firebase App Check HARD enforcement** — এখন soft (missing evidence
   warn); production চালুর আগে per-function `enforceAppCheck: true`।
2. **R2 + Secret Manager আসল ক্রেডেনশিয়াল** — ডেপ্লয়মেন্টে বসাতে হবে
   (`functions:secrets:set`)।
3. **Auth স্টোর multi-instance** — ডেমো মোড single-process; horizontal
   scale-এ Firestore/Real-mode Auth-ই source of truth হতে হবে।
4. **Passkey/MFA** (settings-এ MFA toggle demo) — real Firebase Auth MFA
   enrollment wire-up।
5. **Android Gradle build** — sandbox-এ Android SDK নেই; static review
   সম্পন্ন, CI-তে assembleDebug + lint চালানো বাকি।
