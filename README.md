# 🛡️ Parental Control & Family Safety Platform

> **Develop By Silent Exploit Team Bd · Powered By AI MultiTool**
> Telegram Support: [t.me/setbd_ceo](https://t.me/setbd_ceo)

একটি সম্পূর্ণ, production-ready, **consent-based** ফ্যামিলি সেফটি / প্যারেন্টাল কন্ট্রোল প্ল্যাটফর্ম — তিনটি অংশে:

| অংশ | প্রযুক্তি | লোকেশন |
|------|-----------|--------|
| 🌐 Parent Web Dashboard (বাংলা UI) | Next.js 16 · React 19 · TypeScript · Tailwind 4 | repo root (`src/`) |
| 📱 Child Android App | Kotlin · minSdk 21 → latest · `org.setbd.parentcontrol` | `parental-control/android/` |
| ☁️ Firebase Backend | Cloud Functions v2 (nodejs20) · Firestore · FCM · App Check | `parental-control/functions/` + `parental-control/firebase/` |

**বর্তমান সংস্করণ: v1.4.1** (real auth + server-side admin + security hardening)

---

## ✨ ফিচারসমূহ

- **ডিভাইস পেয়ারিং** — ৬ ডিজিটের single-use, ৫ মিনিট TTL কোড, server-side claim যাচাই
- **রিয়েল-টাইম লোকেশন** ও লোকেশন হিস্ট্রি
- **অ্যাপ তালিকা + ব্লক/অনুমতি** (Accessibility-based App Guard)
- **স্ক্রিন টাইম মনিটরিং** (UsageStats) ও গ্রাফ
- **বেডটাইম শিডিউল** — device admin দিয়ে স্ক্রিন লক
- **রিমোট লক / রিলায়েবিলিটি** — uninstall protection (Device Admin), boot-এ Work পুনঃনির্ধারণ
- **SOS ইমার্জেন্সি** — সন্তান ৩ সেকেন্ড চেপে ধরলে parent-এর কাছে alert + escalation
- **স্ক্রিন শেয়ার / ক্যামেরা / অডিও** (WebRTC, বড় Live Modal + End বাটন, স্ক্রিন শেয়ারে টাইমার নেই)
- **Consent-based ক্লাউড ব্যাকআপ** — ছবি/ভিডিও/কন্টাক্ট (+SMS আলাদা মডিউল), AES-256-GCM on-device encryption, Cloudflare R2 private bucket, dedup, phone-reset restore, ওয়েবসাইট থেকে ছবি/ভিডিও দেখা ও ডাউনলোড
- **Developer Admin Console** (`/admin`) — সব রেজিস্টার্ড ইউজার/UID, লগইন স্ট্যাটাস, লাইভ ইউজার, অডিট লগ, ইউজার/ডিভাইস **ban/unban**, force logout, **Free ↔ Premium** প্ল্যান পরিবর্তন — parent ড্যাশবোর্ড থেকে সম্পূর্ণ আলাদা, কোনো লিংক নেই

### Free vs Premium

| ফিচার | Free | Premium |
|-------|:----:|:-------:|
| পেয়ারিং, লোকেশন, অ্যাপ তালিকা, স্ক্রিন টাইম, বেডটাইম, নোটিফিকেশন, SOS | ✅ | ✅ |
| ডিভাইস কন্ট্রোল (remote lock ইত্যাদি) | ❌ | ✅ |
| স্ক্রিন শেয়ার | ❌ | ✅ |
| ক্যামেরা / অডিও-ভিডিও | ❌ | ✅ |
| ক্লাউড ব্যাকআপ | ❌ | ✅ |

> 🔒 Plan/ban state **Firestore + custom claims-এ** থাকে — client শুধু পড়তে পারে, লিখতে পারে না। প্রতিটি Cloud Function-এ App Check + rate limit + plan/ban যাচাই + audit log।

---

## 🏗️ Architecture

```
┌─────────────────────┐   WebRTC (Firestore signaling)   ┌──────────────────────┐
│  Parent Dashboard   │◄────────────────────────────────►│   Child Android App  │
│  (Next.js / Vercel) │        FCM commands              │ org.setbd.parentcontrol│
└─────────┬───────────┘                                  └──────────┬───────────┘
          │ Firebase Auth (email/password) + App Check              │
          ▼                                                         ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  Firebase:  Firestore (metadata only)  ·  Cloud Functions v2  ·  Auth claims  │
│  dispatchCommand · requestSession · backup* · adminSetBanState/Plan · SOS     │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ short-lived presigned URLs (SigV4)
                                        ▼
                        ┌───────────────────────────────┐
                        │  Cloudflare R2 (private)      │
                        │  encrypted blobs (AES-256-GCM)│
                        └───────────────────────────────┘
```

**মূল নীতি:** ব্রাউজার/APK-তে কখনোই privileged secret থাকে না। R2 credential শুধু Functions-এ (Secret Manager), TURN credential per-session ephemeral, ব্যাকআপের encryption key শুধু ডিভাইসের Keystore-এ।

## 📁 Repo Structure

```
Parental/
├── src/                        ← ওয়েবসাইট (Next.js) — এটাই Vercel-এ deploy হয়
│   ├── app/                    ← pages + /admin + /api/auth/* + /api/admin/*
│   ├── components/family/      ← ড্যাশবোর্ড views (বাংলা UI)
│   └── lib/
│       ├── family/             ← store, types, engine, firebase bridge
│       └── server/             ← scrypt auth, admin auth, attempt ledger (server-only)
├── parental-control/
│   ├── android/                ← Kotlin child app (package: org.setbd.parentcontrol)
│   ├── functions/              ← Cloud Functions v2 source (TypeScript)
│   ├── firebase/               ← firestore.rules (T01–T50 matrix), indexes, storage rules
│   └── docs/                   ← deployment, security, architecture, backup, permissions
├── package.json                ← ওয়েবসাইট dependencies
└── README.md                   ← এই ফাইল
```

## 🧰 Requirements (প্রয়োজনীয় সফটওয়্যার)

| টুল | সংস্করণ | কেন |
|-----|---------|-----|
| Node.js | **20+** | ওয়েবসাইট + Functions |
| npm বা bun | latest | package install |
| Firebase CLI | latest | `npm i -g firebase-tools` |
| Firebase project | **Blaze (pay-as-you-go)** plan | Functions + Secret Manager এর জন্য Spark plan যথেষ্ট নয় |
| Cloudflare account | free tier চলবে | R2 ব্যাকআপ স্টোরেজ |
| Android Studio | latest + JDK 17 | শুধু অ্যাপ বানাতে চাইলে |

---

## 🚀 দ্রুত শুরু (Local)

```bash
git clone https://github.com/ai-multitool-v1/Parental.git
cd Parental
npm install          # অথবা: bun install
npm run dev          # → http://localhost:3000
```

- প্রথমবার **Sign up** ট্যাব থেকে নাম + ইমেইল + পাসওয়ার্ড দিয়ে parent অ্যাকাউন্ট খুলুন (পাসওয়ার্ড ন্যূনতম ৮ অক্ষর)।
- Admin console: `http://localhost:3000/admin` — প্রথম চালু হলে server console-এ **একবার** bootstrap password print হয় (নিচে "Admin Console" সেকশন দেখুন)।
- Firebase ছাড়াই সাইট চলবে (demo mode); Firebase env দিলে live mode-এ যায়।

---

## ☁️ Firebase Setup — ধাপে ধাপে (বিস্তারিত)

> ### 💰 ZERO-COST পথ (Blaze লাগবে না)
> Spark (free) plan-ই যথেষ্ট: **Auth + Firestore ফ্রি**; Cloud Functions-এর
> privileged logic-এর বদলে এখন **Cloudflare Worker** (`worker/` ফোল্ডার) ব্যবহৃত হয়
> — deploy guide: [`worker/README.md`](worker/README.md)। Blaze plan ছাড়াই
> পুরো প্ল্যাটফর্ম (pairing, command, live session, encrypted backup on R2,
> admin) চলে। Worker deploy করার পর দুটি env বসাতে হবে:
> - Web: `NEXT_PUBLIC_SECURE_API_BASE=https://parental-control-api.<sub>.workers.dev`
> - Android: GitHub repo **Variables** → `SECURE_API_BASE` (CI APK-তে বসে যাবে)
>
> নিচের ধাপ ৬–৭ (Cloud Functions + Secrets) শুধু তখনই দরকার যখন Blaze-ঘেঁষা
> ক্লাসিক deployment চান — free deployment-এ বাদ দিতে পারেন।

### ধাপ ১: Firebase project তৈরি

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → নাম দিন (যেমন `setbd-parental`)।
2. **Free Spark plan-এই থাকুন** — ZERO-COST architecture-এ (উপরের বক্স দেখুন) Blaze দরকার নেই। Cloud Functions না চালিয়ে `worker/` deploy করুন।
3. Project settings ⚙️ → **General** → নিচে **Your apps**।

### ধাপ ২: Web app register করুন (ওয়েবসাইটের জন্য)

1. **Your apps** → `</>` (Web) আইকন → নাম দিন → **Register app**।
2. যে config snippet দেখাবে সেখান থেকে ৫টি মান কপি করুন:

| Config value | Env var নাম |
|--------------|-------------|
| `apiKey` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
| `authDomain` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
| `projectId` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
| `messagingSenderId` | `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` |
| `appId` | `NEXT_PUBLIC_FIREBASE_APP_ID` |

### ধাপ ৩: Authentication চালু

1. বাম মেনু → **Build → Authentication → Get started**।
2. **Sign-in method** ট্যাব → **Email/Password** → Enable → Save।
3. **Users** ট্যাব → **Add user** → নিজের ইমেইল + পাসওয়ার্ড দিয়ে **প্রথম parent অ্যাকাউন্ট** বানান (এটাই পরে admin claim পাবে)।

### ধাপ ৪: Firestore তৈরি

1. **Build → Firestore Database → Create database**।
2. **Production mode** বেছে নিন, location দিন (যেমন `asia-south1`)।
3. Schema নিজে বানাতে হবে না — rules + Functions সব সামলায়।

### ধাপ ৫: Security Rules + Indexes deploy

```bash
cd Parental/parental-control/firebase
firebase login                     # একবার ব্রাউজারে লগইন
firebase use --add                 # আপনার project id সিলেক্ট করুন (alias: default)
firebase deploy --only firestore:rules,firestore:indexes,storage
```

এতে `firestore.rules` (T01–T50 adversarial matrix — client কখনো `plan`/`role`/`banned`-জাতীয় field লিখতে পারবে না) ও সব composite index চলে যাবে।

### ধাপ ৬: Cloud Functions deploy

```bash
cd ../functions          # parental-control/functions
npm ci
npm run build            # tsc — 0 error হতে হবে
firebase deploy --only functions
```

### ধাপ ৭: Functions-এর Secrets সেট করুন

প্রতিটি কমান্ড `parental-control/functions/` ডিরেক্টরি থেকে চালান:

```bash
firebase functions:secrets:set R2_ACCOUNT_ID
firebase functions:secrets:set R2_ACCESS_KEY_ID
firebase functions:secrets:set R2_SECRET_ACCESS_KEY
firebase functions:secrets:set R2_BUCKET_NAME
firebase functions:secrets:set BACKUP_KEK
firebase functions:secrets:set TURN_SECRET        # TURN ব্যবহার করলে (optional)
```

| Secret | কোথা থেকে পাবেন |
|--------|------------------|
| `R2_ACCOUNT_ID` | Cloudflare dashboard ডান সাইডবার → Account ID |
| `R2_ACCESS_KEY_ID` | নিচে R2 সেকশনে দেখানো API token থেকে |
| `R2_SECRET_ACCESS_KEY` | ঐ একই token থেকে |
| `R2_BUCKET_NAME` | আপনার R2 bucket-এর নাম |
| `BACKUP_KEK` | নিজে বানাবেন: `openssl rand -base64 32` |
| `TURN_SECRET` | নিজে বানাবেন: `openssl rand -hex 32` (নিজস্ব coturn থাকলে) |

> Secrets পরিবর্তনের পর functions আবার deploy করতে হয়: `firebase deploy --only functions`

### ধাপ ৮: App Check

1. **Build → App Check → Apps**।
2. **Web app**: reCAPTCHA v3 বা Enterprise দিয়ে register করুন → site key পেলে ওয়েব env-এ যোগ করুন।
3. **Android app**: **Play Integrity** দিয়ে register করুন।
4. শুরুতে **Monitoring (ি.e., non-enforcing)** রাখুন — traffic ঠিক আছে দেখে তারপর **Enforced** করুন।

### ধাপ ৯: Admin claim দিন (Developer Admin Console-এর জন্য)

Admin হওয়ার **একমাত্র** উপায় — server-side custom claim (client-এ কোনো admin password নেই):

```bash
cd parental-control/functions
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"   # Project settings → Service accounts → Generate new private key
npx ts-node scripts/setAdminClaim.ts you@example.com        # claim GRANT
npx ts-node scripts/setAdminClaim.ts someone@example.com --revoke   # বাতিল
```

> এই ইমেইলটি অবশ্যই Firebase Auth-এ আগে থেকে থাকতে হবে (ধাপ ৩)। Claim দেওয়ার পর সেই ইউজার re-login করলে `/admin`-এ প্রবেশ করতে পারবে।

### ধাপ ১০ (optional): Emulator দিয়ে লোকাল টেস্ট

```bash
cd parental-control/firebase
firebase emulators:start
```

---

## 🗄️ Cloudflare R2 Setup (ব্যাকআপ স্টোরেজ)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → নিবন্ধন/লগইন।
2. বাম মেনু → **R2 Object Storage** → **Create bucket** → নাম দিন (যেমন `setbd-parental-backups`)।
3. ⚠️ Bucket **private** রাখুন — public access দেবেন না। Downloads হবে Functions-এর ৫-মিনিট presigned URL দিয়ে।
4. **Account ID** কপি করুন (ডান সাইডবার) → এটাই `R2_ACCOUNT_ID`।
5. **R2 → Manage API Tokens → Create API Token** → permission: **Object Read & Write** (নির্দিষ্ট bucket-এ scope করুন) → তৈরি হলে:
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY` (একবারই দেখাবে!)
6. Bucket নাম → `R2_BUCKET_NAME`।

---

## 🌐 Website Credentials সেট করা (বিস্তারিত)

### লোকাল ডেভেলপমেন্ট

প্রজেক্ট root-এ `.env.local` ফাইল বানান (`.env*` git-এ কখনো যায় না):

```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=setbd-parental.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=setbd-parental
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=000000000000
NEXT_PUBLIC_FIREBASE_APP_ID=1:000000000000:web:xxxxxxxxxxxxxxxx
```

### Admin Console (`/admin`) credential

- **পদ্ধতি ১ (auto):** সার্ভার প্রথমবার চালু হলে console-এ (টার্মিনাল / Vercel Function logs) `ADMIN_BOOTSTRAP_CREDENTIALS` লেখা একটি JSON print হয় — তাতে ২৪-অক্ষরের random password থাকে। Username ডিফল্ট `admin` (বদলাতে `ADMIN_USERNAME` env)।
- **পদ্ধতি ২ (env দিয়ে নিজের পাসওয়ার্ড):** নিজের পছন্দের পাসওয়ার্ডের scrypt hash বানিয়ে env-এ দিন:

```bash
node -e "const c=require('node:crypto');const s=c.randomBytes(16);const h=c.scryptSync('আপনার_পাসওয়ার্ড',s,64,{N:16384,r:8,p:1});console.log('16384\$8\$1\$'+s.toString('base64')+'\$'+h.toString('base64'))"
```

আউটপুটটি (ফরম্যাট: `16384$8$1$<saltB64>$<hashB64>`) বসান:

```env
ADMIN_USERNAME=ciadmin
ADMIN_PASSWORD_HASH=16384$8$1$ZLGL...==...$4Ti4...==
```

- Server-only store (`.server/`) কোথায় হবে নিয়ন্ত্রণ করতে: `AUTH_STORE_DIR=/absolute/path` env ব্যবহার করুন।

### Server-side store ফাইলসমূহ (auto-created, কখনো commit হয় না)

| ফাইল | কাজ |
|------|-----|
| `.server/auth-users.json` | parent অ্যাকাউন্ট + scrypt password hash |
| `.server/admin-credentials.json` | admin credential hash |
| `.server/admin-registry.json` | ব্যান/প্ল্যান/অডিট রেজিস্ট্রি (demo mode) |
| `.server/attempt-ledger.json` | brute-force lockout ledger (৫ বার ভুল → ৫ মিনিট লক) |
| `.server/session-secret.json` | HMAC session cookie secret |

> 🔐 এই ফাইলগুলোতে password hash আছে — **কখনো কারও সাথে শেয়ার বা commit করবেন না।** নিয়মিত ব্যাকআপ করলে ইউজার/রেজিস্ট্রি ডেটা টিকে থাকে।

---

## ▲ Vercel Deployment — ধাপে ধাপে (বিস্তারিত)

1. এই repo টি আপনার GitHub-এ থাকতে হবে (আপনার জন্য আপলোড করা আছে: `ai-multitool-v1/Parental`)।
2. [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → `ai-multitool-v1/Parental` সিলেক্ট করুন।
3. Configure পেজে:
   - **Framework Preset:** Next.js (অটো-ডিটেক্ট)
   - **Root Directory:** খালি রাখুন (repo root ই ওয়েবসাইট)
   - **Build Command:** `next build` (default — package.json-এ ঠিক করা আছে)
   - **Node.js Version:** 20.x
4. **Environment Variables** সেকশনে নিচেরগুলো যোগ করুন (Production ও Preview দুটোতেই):

   | Name | Value | কোথা থেকে |
   |------|-------|-----------|
   | `NEXT_PUBLIC_FIREBASE_API_KEY` | `AIzaSy...` | Firebase console → Web app config |
   | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `....firebaseapp.com` | 〃 |
   | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `parental-control-31fb5` | 〃 |
   | `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `000000000000` | 〃 |
   | `NEXT_PUBLIC_FIREBASE_APP_ID` | `1:...:web:...` | 〃 |
   | `NEXT_PUBLIC_SECURE_API_BASE` | `https://parental-control-api.<sub>.workers.dev` | **বাধ্যতামূলক (zero-cost backend)** — এটা না দিলে dashboard demo mode-এ থাকবে |
   | `ADMIN_USERNAME` | আপনার পছন্দের admin নাম | optional (ডিফল্ট `admin`) |
   | `ADMIN_PASSWORD_HASH` | উপরের generator থেকে hash | **Vercel-এ বাধ্যতামূলক** (নিচের নোট দেখুন) |

   > Real mode চালু হওয়ার শর্ত: `NEXT_PUBLIC_FIREBASE_API_KEY` + `NEXT_PUBLIC_FIREBASE_PROJECT_ID` + `NEXT_PUBLIC_FIREBASE_APP_ID` + `NEXT_PUBLIC_SECURE_API_BASE` — চারটিই থাকতে হবে।

5. **Deploy** চাপুন — ২–৩ মিনিটে লাইভ।

### ⚠️ Vercel serverless limitation (অবশ্যই পড়ুন)

Vercel-এর ফাইলসিস্টেম **read-only + per-instance ephemeral**। এর প্রভাব:

- Signup/login ইত্যাদি ফাইল-backed store গুলো (`AUTH_STORE_DIR` fallback-এ `/tmp` ব্যবহার করে) প্রতিটি serverless instance-এ **আলাদা ও সাময়িক** — cold start-এ হারাতে পারে। এটি **demo mode** হিসেবে দারুণ কাজ করে, কিন্তু আসল production অ্যাকাউন্ট ডেটার জন্য নয়।
- `ADMIN_PASSWORD_HASH` env **অবশ্যই** দিন — নাহলে প্রতিটি instance-এ আলাদা bootstrap password তৈরি হবে এবং `/admin` লগইন অনির্ভরযোগ্য হবে।
- **Production-grade ব্যবহারের দুটি পথ:**
  1. **Self-host (সুপারিশকৃত):** যেকোনো VPS-এ `npm run build:standalone && node .next/standalone/server.js` — তখন `.server/` স্থায়ী থাকে (এই মোডে ওয়েবসাইট নিজেই সব কন্ট্রোল সামলায়)।
  2. **Firebase live mode:** উপরের Firebase setup করে env গুলো দিন — তখন identity ও সব privileged mutation Firebase Auth + Cloud Functions + Firestore-এ যায় (এটাই প্ল্যাটফর্মের আসল production পথ; web demo store শুধু fallback)।

### Admin bootstrap password Vercel-এ কোথায় দেখবেন

Vercel Dashboard → আপনার project → **Deployments → Functions** (বা **Observability → Logs**) → `ADMIN_BOOTSTRAP_CREDENTIALS` search করুন। তবে env দিয়ে hash সেট করলে এটি দরকারই হয় না।

### Custom domain (optional)

Project → **Settings → Domains** → নিজের ডোমেইন যোগ করুন → DNS এ CNAME/A record দিন। HTTPS স্বয়ংক্রিয়। Security headers (CSP, HSTS, X-Frame-Options...) `next.config.ts` থেকে সব পেজে বসানো আছে।

---

## 📱 Android App Setup ও Build (বিস্তারিত)

### ধাপ ১: Firebase-এ Android app register

1. Firebase console → Project settings → **Your apps** → Android আইকন।
2. **Android package name:** `org.setbd.parentcontrol` (হুবহু এটাই)।
3. App nickname দিন → **Register app** → **Download google-services.json**।
4. ফাইলটি বসান:

```
parental-control/android/app/google-services.json     ← এখানে
```

> ⚠️ `google-services.json` `.gitignore`-এ আছে — এটি কখনো commit হবে না। Repo-তে `google-services.json.example` আছে শুধু ফরম্যাট বোঝার জন্য।

### ধাপ ২: Build

```bash
cd parental-control/android

# Debug APK (টেস্টের জন্য)
./gradlew assembleDebug
# আউটপুট: app/build/outputs/apk/debug/app-debug.apk

# Release APK
keytool -genkey -v -keystore release.keystore -alias parental -keyalg RSA -keysize 2048 -validity 10000
./gradlew assembleRelease
# আউটপুট: app/build/outputs/apk/release/app-release.apk
```

- `minSdk 21` (Android 5.0) থেকে লেটেস্ট Android পর্যন্ত চলবে।
- APK সন্তানের ফোনে **সরাসরি install** করতে হবে (SMS backup মডিউলসহ parental control অ্যাপ Play Store policy-র বাইরে)।

### ধাপ ৩: ফোনে প্রথম চালু (Onboarding)

অ্যাপ খুললে ধাপে ধাপে এই permission গুলো চাইবে — প্রতিটি ছাড়া সংশ্লিষ্ট ফিচার বন্ধ থাকবে:

| Permission | ফিচার |
|-----------|-------|
| Device Admin | remote lock, uninstall protection, bedtime lock |
| Accessibility | App Guard (অ্যাপ ব্লক), protect settings |
| Location (foreground + background) | লোকেশন ট্র্যাকিং |
| Phone / Contacts / SMS | ব্যাকআপ মডিউল (আলাদা consent) |
| Notification | FCM কমান্ড + SOS |
| Camera / Microphone | শুধু parent অনুমোদন করলে (consent) |

- **Device Owner mode** (icon-hide ফিচারের জন্য প্রয়োজন, fresh device বা factory reset-এর পর):

```bash
adb shell dpm set-device-owner org.setbd.parentcontrol/.management.DeviceAdminReceiver
```

- **Secret dial code:** ফোনের ডায়ালারে `*#*#1111#*#*` → অ্যাপ খুলবে (icon লুকানো থাকলে এভাবেই ঢুকবেন)।
- App icon hide: অ্যাপের ভেতরে Settings → Device-Owner mode চালু থাকলে "Hide app icon" switch (official DevicePolicyManager path)।

### ধাপ ৪: Pairing (সন্তানের ফোন ↔ ওয়েবসাইট)

1. ওয়েবসাইটে parent লগইন → **ডিভাইসসমূহ** → **পেয়ারিং কোড তৈরি করুন** (৬ ডিজিট, ৫ মিনিট)।
2. সন্তানের ফোনে অ্যাপ খুলে কোডটি দিন।
3. Server-side যাচাই হয়ে device claim সেট হবে — ওয়েবসাইটের ডিভাইস তালিকায় দেখা যাবে।

### APK-তে কোনো secret নেই (by design)

- R2 credentials শুধু Cloud Functions-এ — APK-তে নেই।
- TURN credential প্রতি session-এ Functions থেকে ephemeral জারি হয়।
- ব্যাকআপের AES key ডিভাইসের Android Keystore / EncryptedSharedPreferences-এ।
- Cleartext traffic সম্পূর্ণ বন্ধ (`network_security_config.xml`)।

---

## 👑 Developer Admin Console ব্যবহার

`/admin` — parent ড্যাশবোর্ড থেকে কোনো লিংক নেই, সরাসরি URL দিয়ে ঢুকতে হয়:

- **Overview:** মোট ইউজার, premium সংখ্যা, লাইভ সেশন
- **Users:** search, plan toggle (Free ↔ Premium), **ban/unban**, force logout
- **Devices:** device ban/unban (ব্যান হলে সন্তানের ফোন কমান্ড পাবে না)
- **Audit:** ADMIN_* + PLATFORM লগ (parent কোনো activity log দেখতে পায় না — শুধু admin)

প্রতিটি admin কাজ audit log-এ যায় এবং server-এ যাচাই হয় (custom claim `admin: true` — শুধু Admin SDK দিয়ে সেট হয়, client থেকে কখনোই নয়)।

---

## 🔐 Security Model (সংক্ষেপ)

| Layer | ব্যবস্থা |
|-------|---------|
| ওয়েব লগইন | Sign up / Log in আলাদা; scrypt (N=16384) hash; ভুল পাসওয়ার্ডে স্পষ্ট error; **৫ বার ভুল → ৫ মিনিট lockout** |
| Admin | কোনো client-side password নেই; server-side scrypt + httpOnly signed cookie; production-এ Firebase custom claim |
| Firestore Rules | `affectedKeys().hasOnly(...)` whitelist সর্বত্র — client কখনো `plan`/`role`/`banned` লিখতে পারে না (T01–T50 test matrix) |
| Cloud Functions | App Check + distributed rate limit + plan/ban check + audit hash-chain — প্রতিটি callable-এ |
| ব্যাকআপ | ডিভাইসে AES-256-GCM encryption; Firestore-এ শুধু metadata; R2 fully private + ৫-মিনিট presigned URL |
| Android | EncryptedSharedPreferences, cleartext বন্ধ, APK-তে zero secret, সব কিছু consent-based |

বিস্তারিত: [`parental-control/docs/security.md`](parental-control/docs/security.md) · [`security-audit-v1.1.1.md`](parental-control/docs/security-audit-v1.1.1.md) · [`security-fixes-v1.4.1.md`](parental-control/docs/security-fixes-v1.4.1.md)

> ⚖️ **নৈতিক ব্যবহার:** এই প্ল্যাটফর্ম শুধুমাত্র নিজের সন্তানের যত্নের জন্য, সন্তানের জানমতে (consent flow + disclosure notification সহ)। Stealth/stalkerware ব্যবহারের জন্য নয় — icon-hide ইচ্ছাকৃতভাবে Device-Owner official path-এই সীমাবদ্ধ।

---

## 📚 বিস্তারিত ডকুমেন্টেশন

| ডক | বিষয় |
|----|------|
| [`parental-control/docs/deployment.md`](parental-control/docs/deployment.md) | পুরো ব্যাকএন্ড deploy রানবুক |
| [`parental-control/docs/architecture.md`](parental-control/docs/architecture.md) | সিস্টেম ডিজাইন |
| [`parental-control/docs/backup.md`](parental-control/docs/backup.md) | ব্যাকআপ আর্কিটেকচার + key model |
| [`parental-control/docs/permissions.md`](parental-control/docs/permissions.md) | প্রতিটি permission কেন দরকার |
| [`parental-control/docs/privacy.md`](parental-control/docs/privacy.md) | ডেটা privacy |
| [`parental-control/docs/testing.md`](parental-control/docs/testing.md) | টেস্ট ম্যাট্রিক্স |
| [`parental-control/android/README.md`](parental-control/android/README.md) | Android build + enrollment |

## 🩺 Troubleshooting

| সমস্যা | সমাধান |
|--------|--------|
| Android build fail: `google-services.json not found` | ধাপ ১ অনুযায়ী ফাইলটি `parental-control/android/app/`-এ বসান |
| Functions deploy fail: secrets | `firebase functions:secrets:set NAME` দিয়ে সব ৬টি secret সেট করে আবার deploy |
| `PERMISSION_DENIED` (Firestore) | rules deploy করা আছে কি? `firebase deploy --only firestore:rules`; ইউজারের claim/plan যাচাই করুন |
| App Check 403 | প্রথমে Monitoring mode-এ রাখুন; web app-এ reCAPTCHA key ঠিক আছে কি দেখুন |
| ব্যাকআপ UPLOADED হচ্ছে না | Premium plan + parent policy ON + সন্তানের consent ON + runtime permission — চারটাই লাগবে |
| Vercel-এ লগইন কাজ করছে না | env ভ্যারিয়েবলগুলো Production+Preview দুটোতেই দিন; redeploy করুন |
| `/admin` লগইন হচ্ছে না (Vercel) | `ADMIN_PASSWORD_HASH` env দিন; না দিলে Function logs-এ bootstrap password খুঁজুন |
| স্ক্রিন শেয়ারের ভিডিও আসছে না | strict NAT হলে নিজস্ব TURN (coturn) লাগবে — `TURN_SECRET` সেট করুন |

## 📬 Support

- Telegram: **[t.me/setbd_ceo](https://t.me/setbd_ceo)**
- ওয়েবসাইটের Settings ট্যাবেও "সাপোর্ট" কার্ড আছে; অ্যাপের ভেতরে Telegram support modal আছে।

---

**Develop By Silent Exploit Team Bd · Powered By AI MultiTool** · v1.4.1
