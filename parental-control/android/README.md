# SET BD Parent Control — Child Device App (Android, Kotlin)

Package: `org.setbd.parentcontrol` — supports **API 21 (Android 5.0) → latest**.

Consent-based child-side app for the Family Safety parental control platform.
**Every** monitoring capability (location, screen, camera, microphone, usage)
is gated behind a visible, explicit consent flow on this device, shows a
persistent visible indicator while active, and can be stopped by the child at
any time. Only official/public Android APIs are used — no root, no
no self-concealment on unmanaged devices, no accessibility content-reading, no hidden persistence, no permission bypass.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Language / min SDK | Kotlin, `minSdk 21`, `targetSdk/compileSdk 34` (all newer-API call sites guarded — see `util/Compat.kt`) |
| UI | Jetpack Compose, Material 3 (single `MainActivity`, no XML layouts) |
| Backend | Firebase Auth (anonymous), Firestore, FCM, App Check (Play Integrity / Debug) |
| Jobs | WorkManager (heartbeat, usage sync, bedtime fallback) |
| Location | Google Play Services `FusedLocationProviderClient` |
| Realtime media | WebRTC (`io.getstream:stream-webrtc-android`, Google libwebrtc) |
| DI | Manual `ServiceLocator` (deliberately no Hilt — smaller, auditable) |
| Secure storage | `EncryptedSharedPreferences` (deviceId, replay cache, policy cache) |

## Repository layout

```
android/
├── build.gradle.kts / settings.gradle.kts / gradle.properties
├── README.md                          ← you are here
└── app/
    ├── build.gradle.kts               ← all dependencies + versions
    ├── proguard-rules.pro
    ├── google-services.json.example   ← rename to google-services.json
    └── src/main/
        ├── AndroidManifest.xml        ← exact permission set + typed FGS services
        ├── res/ (strings en + bn, themes, device_admin_sample.xml, icons)
        └── java/org/setbd/parentcontrol/
            ├── FamilySafetyApp.kt / MainActivity.kt
            ├── auth/ pairing/ device/ location/ usage/ apps/
            ├── policies/ management/ commands/ notifications/
            ├── emergency/ screenshare/ camera/ microphone/ webrtc/
            ├── reliability/ security/ ui/ di/
```

## Build

1. **Prerequisites**: Android Studio (Hedgehog+), JDK 17, Android SDK 34.
2. Copy `app/google-services.json.example` → `app/google-services.json` and
   fill in your Firebase project values (package must be `org.setbd.parentcontrol`).
   For debug builds also register the App Check **debug token** in the console.
3. Generate the Gradle wrapper (binaries are not committed):

   ```bash
   cd android && gradle wrapper --gradle-version 8.5
   ```

4. Build & install:

   ```bash
   ./gradlew :app:assembleDebug
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```

Firestore data model used by the app (secure these with rules — see
`../functions` / `../docs`): `pairingCodes/{code}`,
`devices/{deviceId}` + subcollections `status`, `locations`, `appUsage`,
`installedApps`, `policies/current`, `commands`, `commandResults`,
`auditLogs`, `emergencyEvents`, `permissions`, `sessions/{id}/signals`,
`parents/{parentUid}`.

## Device enrollment (management mode)

Remote **lock** and kiosk-style bedtime app-hiding only work when the device
is properly enrolled. There is **no silent provisioning** in this app.

* Testing / manual provisioning (first, unmanaged install):

  ```bash
  adb shell dpm set-device-owner org.setbd.parentcontrol/.management.DeviceAdminReceiver
  ```

  Run this on a device **without any Google account** (or after
  `adb shell settings put global device_provisioned 0` on a test device).

* Production: use managed Google Play / EMM enrollment (Profile Owner) or
  QR provisioning at device setup — both are standard, visible flows.

* Classic Device Admin: the user can activate via
  *Settings → Security → Device admin apps → Family Safety* (system dialog).

When not enrolled, `LOCK_DEVICE` and bedtime app-hiding return **UNSUPPORTED**
in `commandResults` — visible on the parent dashboard instead of silently
"working" via dubious means.

## Permission onboarding walkthrough (child UX)

1. **Welcome/Transparency screen** — plain-language description of every
   capability; nothing runs before pairing.
2. **Pairing** — random 8-char code (`pairingCodes/{code}`, TTL 5 min,
   single use). Parent enters it in the dashboard and approves.
3. **POST_NOTIFICATIONS** (Android 13+) — requested once, right after launch,
   because session indicators and parent messages need it.
4. **Location (fine → background)** — child grants from the system dialog or
   `Settings → App permissions` when enabling live tracking. Denied location
   ⇒ location features report UNSUPPORTED.
5. **Apps with usage access** — child must enable it in system settings
   (checked via `AppOpsManager`); denied ⇒ usage sync reports UNSUPPORTED.
6. **Battery exemption** — optional, user-initiated from Settings, with
   OEM-specific guidance (Xiaomi/Huawei/OPPO/vivo/Samsung).

The current state of all of the above is uploaded to
`devices/{deviceId}/permissions/current` for the parent's Permission
Dashboard — gaps are visible, never hidden.

## Consent flows (the core safety design)

| Feature | Gate 1 | Gate 2 | Visible while active | Stop controls |
| --- | --- | --- | --- | --- |
| Screen share | In-app Allow/Decline dialog | System MediaProjection dialog | FGS notification + in-app banner | Banner / notification / parent STOP |
| Camera | In-app Allow/Decline dialog | CAMERA runtime permission | FGS `camera` notification + banner | same |
| Microphone | In-app Allow/Decline dialog | RECORD_AUDIO permission | FGS `microphone` notification + banner | same |
| Live location | Policy or child-initiated | Location permission | FGS `location` notification + banner | same |

All sessions are foreground services started **from the foreground** with
correct `foregroundServiceType` (Android 14 requirements), and never
auto-started at boot (`BootReceiver` only reschedules WorkManager jobs).

Commands (`devices/{deviceId}/commands`) are **whitelist-only** (14 types) and
pass: auth → deviceId match → TTL → replay check → parent-authorization
(`devices/{deviceId}/parents/{parentUid}`) → execution → `commandResults` +
`auditLogs`. IMEI/telephony identifiers are never used; device identity is a
stored random UUID.

## Testing checklist (maps to spec §38 — safety & consent verification)

| # | Scenario | Expected result |
| --- | --- | --- |
| 38.1 | Pairing code reuse after approval | Second approval blocked (`used:true` + rules) |
| 38.2 | Pairing code after 5 min | Expired locally; doc deleted; new code required |
| 38.3 | Command from uid not in `parents/` | `REJECTED parent_not_authorized` + audit entry |
| 38.4 | Expired command replay (same id, FCM + listener) | Processed once; second delivery short-circuited |
| 38.5 | REQUEST_SCREEN_SESSION → Decline | `USER_DECLINED`; no capture; system dialog never shown |
| 38.6 | REQUEST_SCREEN_SESSION → Allow → deny system dialog | `UNSUPPORTED user declined system screen-capture dialog` |
| 38.7 | Camera session with CAMERA permission revoked mid-flow | Service stops / `UNSUPPORTED` — never silent |
| 38.8 | Active session indicator | FGS notification + banner visible; Stop works from both |
| 38.9 | LOCK_DEVICE without admin | `UNSUPPORTED device not enrolled` |
| 38.10 | LOCK_DEVICE as device owner | Screen locks; audit `DEVICE_LOCKED` |
| 38.11 | Bedtime alarm in Doze | START/END fire (exact or inexact + WorkManager fallback) |
| 38.12 | Bedtime when notifications denied & not owner | status `bedtimeEnforcement: UNSUPPORTED` + audit |
| 38.13 | SOS double-press within 5 min | Second attempt rate-limited |
| 38.14 | SOS | Confirmation dialog (3 s countdown), event with battery/network/optional location |
| 38.15 | TRIGGER_SAFETY_CHECK no answer 10 min | `child_response:NO_RESPONSE` written |
| 38.16 | Usage access not granted | `SYNC_USAGE` → `UNSUPPORTED`, permissions doc updated |
| 38.17 | Boot after reboot (paired) | WorkManager jobs rescheduled; no capture service started |
| 38.18 | Offline heartbeat | WorkManager backoff; UI shows offline; no crash |
| 38.19 | Unknown command type | `REJECTED type_not_whitelisted` |
| 38.20 | App Check: tampered client | Firestore rejects at rules level (App Check enforcement) |

## Known platform notes

* Exact bedtime alarms require the user-granted "Alarms & reminders"
  permission on Android 12+; without it we fall back to inexact alarms +
  WorkManager (never a bypass).
* MediaProjection on Android 14 **must** be granted before the service starts
  and cannot be re-used after reboot — sessions are always re-consented.
* The TURN server in `webrtc/WebRtcClient.kt` is a placeholder — fill in your
  deployment's TURN credentials (the only intentional TODO in the codebase).

---

## New in 1.1.0 — requested by product owner

| Feature | Implementation | Support |
| --- | --- | --- |
| Package `org.setbd.parentcontrol` | `applicationId` + `namespace` (build.gradle.kts) | API 21+ |
| API 21 → latest | All newer-API call sites guarded (`util/Compat.kt`, `Build.VERSION` checks); `SecureStore` falls back to plain prefs on API 21/22 | API 21+ |
| Device Admin onboarding | Settings → Protection → "Activate device admin" (visible system dialog) — uninstall protection + remote `lockNow()` | API 21+ |
| Accessibility "App Guard" | `AppGuardAccessibilityService` — foreground-package detection ONLY (no text/keystroke collection) → block-list blocking, bedtime enforcement, optional Settings protection. Persistent "App protection active" notification. Enabled by the user in Settings → Accessibility | API 21+ |
| Dial code `*#*#1111#*#*` | `SecretCodeReceiver` (`android.provider.Telephony.SECRET_CODE`) + `DialCodeFallbackReceiver` (NEW_OUTGOING_CALL, ≤ Android 9). Opens the app; also un-hides it in Device Owner hidden mode. Audit-logged | API 21+ |
| Hide app icon | OFFICIAL path only: `DevicePolicyManager.setApplicationHidden` on Device/Profile Owner devices (API 28+), toggleable from parent dashboard (`settings.hideAppIcon` policy field) or child Settings. App is dormant while hidden — dial the code to reopen. On non-owner devices this reports UNSUPPORTED and the icon stays visible; no launcher-component-disable stealth trick is used (Play Protect flags it as stalkerware) | API 28+ (Device Owner) |
| Screen broadcast: NO timer | Screen sessions have no duration cap anywhere: child app has no auto-stop, Cloud Functions set `expiresAt: null` for SCREEN (cleanup can never auto-end them), dashboard shows "no timer". Only STOP commands or the child's Stop action end a screen share | API 21+ |

### Device Owner provisioning (for lock / hide-icon / kiosk-grade control)

```bash
adb shell dpm set-device-owner org.setbd.parentcontrol/.management.DeviceAdminReceiver
```

Provision on a FRESH device or after removing all accounts (Android requirement).

---

## v1.2.0 — Splash, credits & Telegram support

| Feature | Implementation |
| --- | --- |
| Splash screen | `ui/Branding.kt → SplashCreditsOverlay` — full-screen branded overlay shown once at every app start (~2.6 s, tap to skip), drawn above the active route so it also covers cold-start restore work. Pure Compose → works identically on API 21 → latest (no core-splashscreen theme dependency needed). |
| Developer credits | `credit_develop_by` / `credit_powered_by` / `credit_full_line` strings ("Develop By Silent Exploit Team Bd" / "Powered By AI MultiTool") shown on the splash + `CreditsFooter` at the bottom of the dashboard and Settings (English + Bangla resources). |
| Telegram support modal | `TelegramSupportDialog` — visible support entry as the Send icon in the dashboard top bar, a "Support & contact" card in Settings, and a card on the dashboard. Shows the support text and opens `https://t.me/setbd_ceo` via `ACTION_VIEW` (user-initiated, no permission). |
| Version | `versionName 1.2.0`, `versionCode 3` (`app/build.gradle.kts`). |

Nothing in v1.2.0 changes permissions, services, or the consent model —
branding/support only.

---

## v1.4.1 — Network security hardening (security review)

| Item | Detail |
| --- | --- |
| Network security config | New `res/xml/network_security_config.xml` + `android:networkSecurityConfig` in the manifest. Global `cleartextTrafficPermitted="false"` (explicit, OEM-proof complement to `usesCleartextTraffic="false"`) and **system-CAs-only** trust anchors — user-installed certificates can no longer MITM app traffic. |
| Certificate pinning | Evaluated, **not added** (documented in the config header): Firebase/GMS traffic uses Google-managed certs (pinning breaks Play-services updates); R2 uploads are authorized by short-lived server-minted presigned URLs (≤ 10 min), so pinning adds outage risk without security. If a first-party endpoint is ever added, pin it there with a scoped `<pin-set>`. |
| Hardcoded secrets scan | Clean — no API keys/secrets/tokens in code or resources; `google-services.json.example` contains only REPLACE-ME placeholders. |
| Local storage | Confirmed: `SecureStore` (EncryptedSharedPreferences, API 23+) holds deviceId, pairing state, replay cache, policy caches and the backup DEK; documented plain fallback on API 21/22 is surfaced to the parent dashboard via PermissionReporter. Temp ciphertext lives in `cacheDir` and is deleted after upload. |
