# Release v1.4.0 — Free/Premium সিস্টেম ও ড্যাশবোর্ড ক্লিন-আপ

**তারিখ:** ২০২৬-০৯-০৯ · **স্কোপ:** Web Dashboard (parent) + Developer Admin Console + Cloud Functions
**Android app:** কোনো পরিবর্তন নেই (server-side প্রিমিয়াম enforcement-এর কারণে দরকারও হয়নি)

---

## ১. এই রিলিজে যা যা বদলানো হয়েছে (ইউজারের রিকোয়ারমেন্ট অনুযায়ী)

| # | রিকোয়ারমেন্ট | অবস্থা |
|---|---|---|
| ১ | **Free vs Premium ইউজার সিস্টেম** — ডিভাইস কন্ট্রোল, স্ক্রিন শেয়ারিং, ক্যামেরা, অডিও/ভিডিও, ক্লাউড ব্যাকআপ শুধু premium; বাকি সব ফিচার free; premium ইউজার সব পায় | ✅ সম্পন্ন (client + server দুই স্তরে) |
| ২ | **Activity log শুধু admin/developer দেখবে, parent না** | ✅ Parent dashboard থেকে লগ ভিউ সম্পূর্ণ সরানো; লগ সংগ্রহ চালু থাকে এবং শুধু /admin-এ দেখা যায় |
| ৩ | **Security posture tab সরানো** — কেউ দেখবে না | ✅ security-view মুছে ফেলা হয়েছে |
| ৪ | **Child simulator + demo data সরানো** — আসল অ্যাপ্লিকেশন, কোনো demo ডেটা নেই; কন্ট্রোলগুলো ওভারভিউতে দেখানো হয় | ✅ Simulator ট্যাব + ১১টি seed ফাংশন মুছে খালি initial state; ওভারভিউতে সবসময় দ্রুত-নিয়ন্ত্রণ গ্রিড |
| ৫ | **"কীভাবে কাজ করে" বর্ণনা সরানো** — attacker/তৃতীয় পক্ষ যেন logic/database বুঝতে না পারে | ✅ Settings/backup/session/location-এর সব আর্কিটেকচার টেক্সট (Firestore paths, callable নাম, API নাম, retention policy, credential hint) সরানো |
| ৬ | **ব্যাকআপ হওয়া ফাইল ওয়েবসাইট থেকেই পড়া** — ছবি/ভিডিও ভিউয়ার | ✅ মিডিয়া গ্যালারি + বড় ভিউয়ার মোডাল (metadata, UPLOADED ব্যাজ, ডাউনলোড) |
| ৭ | **স্ক্রিন শেয়ার/ক্যামেরা/ভিডিও confirm হলে বড় মোডাল** — স্ট্রিম দেখাবে + End অপশন | ✅ `ActiveSessionModal` — active হলেই অটো-ওপেন, LIVE badge, টাইমার-নেই নোট, বড় "সেশন শেষ করুন" বাটন, মিনিমাইজ |
| ৮ | **Settings-এ শুধু parent settings** — backend/database কিছুই না | ✅ অ্যাকাউন্ট + MFA + প্ল্যান + Telegram সাপোর্ট + অ্যাকাউন্ট ডিলিট |

## ২. Free/Premium প্রয়োগ — কোথায় কোথায় enforce হয়

**Premium-অনলি:** ডিভাইস কন্ট্রোল (remote lock, icon hide, settings protect), স্ক্রিন শেয়ারিং, ক্যামেরা সেশন, অডিও সেশন, safety সেশন, ক্লাউড ব্যাকআপ (policy change + key unwrap + download URL)।
**Free:** ওভারভিউ, ডিভাইস/পেয়ারিং, লোকেশন, অ্যাপস, স্ক্রিন টাইম, রেস্ট্রিকশন, bedtime, নোটিফিকেশন, SOS।

স্তরসমূহ (defense in depth):
1. **UI gate** — ক্রাউন ব্যাজ, disabled টগল, `PremiumUpsellDialog` (ফ্রি + প্রিমিয়াম ফিচার তুলনা + Telegram যোগাযোগ)।
2. **Store gate** — `dispatchCommand` ও `setBackupCategory`/`updatePolicy`-তে `isPremium()` চেক (admin console-এ প্ল্যান বদলালে লগইন রেখেই কার্যকর)।
3. **Cloud Functions gate (production)** —
   - `dispatchCommand`: `PREMIUM_COMMAND_TYPES` → `COMMAND_BLOCKED_PLAN` audit + permission-denied
   - `requestSession`: সব সেশন premium → `SESSION_REQUEST_BLOCKED_PLAN`
   - `backupSetPolicy` / `backupGetKey` (parent) / `backupGetDownloadUrl`: `requirePremiumParent` → `BACKUP_PREMIUM_REQUIRED`
   - নতুন `adminSetPlan` callable (admin claim + App Check + rate limit + audit)
4. **Firestore rules** — আগের T01–T50 ম্যাট্রিক্স অপরিবর্তিত (plan রিড functions/rules-এর মাধ্যমেই)।

**প্রিমিয়াম অ্যাক্টিভেশন:** ডেভেলপার অ্যাডমিন কনসোল → ইউজার ট্যাব → "প্রিমিয়াম করুন" (real mode: `adminSetPlan` callable, `users/{uid}.plan = "premium"`)। পেমেন্ট গেটওয়ে ডিজাইনে নেই — অ্যাক্টিভেশন ম্যানুয়ালি অ্যাডমিনের মাধ্যমে।

## ৩. Simulator/demo সরানোর পর কী অবস্থা

- ড্যাশবোর্ড এখন **খালি অবস্থায়** শুরু হয় — কোনো ভুয়া চাইল্ড/লোকেশন/অ্যাপ/ব্যাকআপ ডেটা নেই। প্রতিটি ভিউতে সৎ empty state আছে।
- **স্যান্ডবক্স প্রিভিউ পরীক্ষার জন্য** devices view-এর নিচে একটি ছোট, মিউটেড, collapsible **"স্যান্ডবক্স ডিভাইস-শেল"** প্যানেল আছে — consent Allow/Decline, permission টগল, নতুন মিডিয়া ইভেন্ট, নেটওয়ার্ক টগল। **Firebase env vars সেট করা production build-এ এই প্যানেল রেন্ডারই হয় না** (`isFirebaseConfigured()` গেট) — production-এ চাইল্ডের আসল Android অ্যাপই এই ভূমিকা নেয়।
- পেয়ারিং এখন devices view থেকেই সম্পন্ন হয় (কোড তৈরি → চাইল্ড অ্যাপে প্রবেশ → লিংক) — আগের "সিমুলেটরে গিয়ে কোড দিন" ধাপ বাদ।

## ৪. Functions/src/lib পুনর্গঠন

আগের সেশনে হারানো `functions/src/lib/` (৬ ফাইল) সম্পূর্ণ পুনর্লিখন হয়েছে — সব consumer-এর exact signature মিলিয়ে:
`constants.ts` (সব limit/TTL + R2 secret params + PREMIUM_COMMAND_TYPES), `verify.ts` (db/requireSignedIn/assertAppCheck/requireParent/requireDeviceId/requireString/optionalString/enforceRateLimit — hashed-key Firestore ledger), `audit.ts` (append-only auditLogs), `commands.ts` (whitelist + payload validation + createAndDispatchCommand + FCM + clampDurationMs), `users.ts` (FCM token registry + escalation), `backupKey.ts` (per-child DEK, KEK-wrapped AES-256-GCM escrow), `turn.ts` (ephemeral HMAC TURN creds), `r2.ts` (dependency-free SigV4 presign PUT/GET + HEAD)।
পাশাপাশি `adminSetPlan.ts` নতুন। `tsc --noEmit` = **0 error**।

## ৫. Browser E2E ভেরিফিকেশন (agent-browser) — সবই sandbox-এ প্রমাণিত

1. লগইন (free auto-register) → ড্যাশবোর্ড; nav-এ security/logs/simulator **নেই**; premium ভিউতে ক্রাউন ✓
2. ওভারভিউ: খালি-ডিভাইস state + **সবসময় দৃশ্যমান নিয়ন্ত্রণ গ্রিড** ✓
3. ফ্রি ইউজার "লক করুন" চাপলে premium upsell ডায়ালগ ✓ (store-ও DENY করে, audit-এ যায়)
4. Settings: শুধু অ্যাকাউন্ট/MFA/প্ল্যান/সাপোর্ট/ডিলিট — কোনো backend তথ্য নেই ✓
5. Backup (free): premium ব্যানার, টগল disabled ✓; Backup (premium): টগল কাজ করে ✓
6. Admin: লগইন → ইউজার ট্যাবে plan বাটন → "প্রিমিয়াম করুন" → audit `ADMIN_SET_PLAN → OK → PREMIUM` ✓; audit tab-এ "শুধু ডেভেলপার অ্যাডমিন দেখতে পারে" নোট ✓
7. পেয়ারিং: কোড তৈরি → লিংক → paired shell + admin devices রেজিস্ট্রিতে নিবন্ধন ✓
8. স্ক্রিন শেয়ারিং (premium): অনুরোধ → permission না থাকলে PERMISSION_REQUIRED fail (সঠিক) → sandbox-এ screenCapture গ্রান্ট → অনুরোধ → **waiting_child** → sandbox Allow → **ACTIVE → বড় মোডাল অটো-ওপেন** (LIVE badge, "টাইমার নেই", End বাটন) → **সেশন শেষ করুন** → সেশন ended + মোডাল বন্ধ ✓
9. ব্যাকআপ পাইপলাইন (premium): Photos/Videos ON → sandbox মিডিয়া ইভেন্ট → permission ছাড়া `CANCELLED (CONSENT_MISSING)` = dual-opt-in প্রমাণ → permission দিয়ে আবার → PENDING → UPLOADING → UPLOADED, stats বাড়ে (142 MB) ✓
10. মিডিয়া গ্যালারি: ছবির tile + ভিউয়ার মোডাল (metadata, UPLOADED, ডাউনলোড) ✓
11. মোবাইল 390px রেসপনসিভ, **console/page error শূন্য**, dev.log পরিষ্কার ✓
12. lint (eslint) শূন্য error ✓; functions `tsc --noEmit` শূন্য error ✓

## ৬. আংশিক / সীমাবদ্ধতা (সৎ রিপোর্ট)

- **WebRTC লাইভ স্ট্রিম পিক্সেল**: sandbox-এ আসল চাইল্ড ডিভাইস নেই বলে মোডালে connecting/placeholder অবস্থা দেখায়; production-ে Firestore signaling থেকে remote stream `<video>`-তে বসবে (কম্পোনেন্টে video element প্রস্তুত)।
- **ব্যাকআপ ফাইলের আসল bytes**: প্রিভিউয়ার production-এ `backupGetDownloadUrl` (৫ মিনিট presigned GET) + ডিভাইস-সাইড DEK দিয়ে ডিক্রিপ্ট করা কনটেন্ট দেখাবে; sandbox-এ কনটেন্ট না থাকায় সৎ placeholder + metadata দেখায়।
- **পেমেন্ট ইন্টিগ্রেশন নেই** — প্রিমিয়াম অ্যাক্টিভেশন অ্যাডমিন-ম্যানুয়াল (ডিজাইন অনুযায়ী)।
- **Android app**: v1.3.0 থেকে অপরিবর্তিত; নতুন কিছু যোগ করার দরকার হয়নি (premium enforcement সম্পূর্ণ server-side; চাইল্ড অ্যাপ শুধু অনুমোদিত command-ই পায়)। APK compile Android Studio/SDK প্রয়োজন — sandbox-ে SDK নেই।
- **Firebase production enforcement**: `dispatchCommand`/`requestSession`/backup callables-এ plan check কোড-ভেরিফাইড (tsc clean), কিন্তু লাইভ Firestore ছাড়া runtime E2E সম্ভব নয় — deploy-এর পর docs/deployment.md অনুযায়ী যাচাই করতে হবে।
- **Admin console credentials**: UI থেকে credential hint সরানো হয়েছে (নিরাপত্তা)। Sandbox credential: `admin` / `setbd-admin-2025` — production-ে custom claim + Admin SDK দিয়ে প্রতিস্থাপিত হবে।

## ৭. পরিবর্তিত ফাইল (সারাংশ)

- `src/components/family/`: app-shell (nav পরিষ্কার + plan badge + modal), overview (কন্ট্রোল গ্রিড), sessions (premium gate), backup (গ্যালারি+ভিউয়ার+premium), control (premium), devices (pairing+sandbox host), settings (নতুন), **session-modal.tsx (নতুন)**, **sandbox-panel.tsx (নতুন)**, ui-bits (PremiumTag/UpsellDialog), login-screen (পরিষ্কার), emergency/notifications/screen-time/location/apps (internal text সরানো); **security-view.tsx ও child-simulator.tsx মুছে ফেগেছে**
- `src/lib/family/`: types (UserPlan/PREMIUM_COMMANDS, SimSettings বাদ), seed (empty state), store (premium gates + sandboxConsent + pairedDeviceShell + isPremium), admin-store (setPlan/registerDevice), admin-types (plan), branding (v1.4.0)
- `functions/src/`: **lib/ ৮টি মডিউল পুনর্গঠন**, dispatchCommand + requestSession (premium gate), backup.ts (requirePremiumParent), **adminSetPlan.ts (নতুন)**, index.ts
- Screenshots: `download/v14-*.png`
