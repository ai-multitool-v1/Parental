# Android Permissions — Rationale, Timing & Denial Behaviour

> Principle: **every permission is conditional, explained, and revocable.**
> The child sees *what* is collected and *when*; nothing is collected without a
> visible indicator; and a denied permission degrades the feature gracefully —
> it never breaks the device or hides the app.

---

## 1. Requested permissions

| Permission | Why | When requested (conditional onboarding) | If denied |
|---|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | Firebase transport, FCM, reachability checks | Not a runtime prompt (normal permission) | n/a |
| `POST_NOTIFICATIONS` | Show consent overlays, parent messages, "screen is shared" indicator, SOS confirmations | Onboarding step 1 (Android 13+) | App still works; consent overlays appear as full-screen activities instead |
| `ACCESS_FINE_LOCATION` | Live location + location history the parent dashboard shows | Onboarding step 2, only if parent enables location; "while in use" first | Location card shows "permission missing"; no background location work is scheduled |
| `ACCESS_BACKGROUND_LOCATION` | Continuous location history / safety check context | **Second, separate** in-app explanation after FINE granted (Play requires staged request) | Only foreground one-shot lookups; history gaps visible in dashboard |
| `FOREGROUND_SERVICE` | Run the monitoring service visibly (persistent notification) | Implied by service start; notification always visible | Telemetry stops when app is killed; status card flags it |
| `FOREGROUND_SERVICE_LOCATION` (Android 14+) | FGS type for continuous location while in use | With location enablement | see matrix below |
| `FOREGROUND_SERVICE_DATA_SYNC` (Android 14+) | FGS type for policy/usage sync worker | At service start | n/a |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` (Android 14+) | FGS type required before MediaProjection screen capture | Only during a consented SCREEN session | Screen session refused |
| `FOREGROUND_SERVICE_CAMERA` (Android 14+) | FGS type for consented camera session | Only during a consented CAMERA session | Camera session refused |
| `FOREGROUND_SERVICE_MICROPHONE` (Android 14+) | FGS type for consented audio session | Only during a consented AUDIO session | Audio session refused |
| `CAMERA` | Consented camera sessions (child can see + stop) | On first CAMERA session request, after the consent overlay is accepted | Session ends in `DENIED` state; parent sees the reason |
| `RECORD_AUDIO` | Consented audio sessions (child can see + stop) | On first AUDIO session request, after consent overlay | Same as CAMERA |
| `PACKAGE_USAGE_STATS` (special, Settings-grant) | App usage reports for screen-time dashboards | Onboarding step 3, deep-links to Usage access settings | Usage dashboard shows empty state; all other features work |
| `QUERY_ALL_PACKAGES` | Enumerate installed apps for the app inventory / blocking list | Play-policy gated; see §4 | App inventory limited to launcher-queried apps; blocking limited to visible apps |
| `RECEIVE_BOOT_COMPLETED` | Restart the persistent service after reboot | Not a runtime prompt | Monitoring stops until the child opens the app once after reboot |
| `WAKE_LOCK` | Reliable telemetry batching | Not a runtime prompt | Minor battery/reliability impact |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Keep the service alive on OEM task killers; **always accompanied by an explanation dialog** and an escape hatch | Optional onboarding step 4; the app functions without it | Service may be killed by aggressive OEMs; status card surfaces "service interrupted" |
| `VIBRATE` | Consent overlay attention | Not a runtime prompt | n/a |
| FCM runtime (`POST_NOTIFICATIONS` + Play services) | Command/SOS wake-ups | Onboarding step 1 | Commands delivered on next app open / periodic poll while unexpired |

**Special, non-manifest grants**

| Mechanism | Purpose | Revocable |
|---|---|---|
| MediaProjection (user consent dialog per session) | Screen sharing — the OS dialog IS the consent record | Yes, per session + system cast icon |
| Usage access (Settings) | Usage stats | Yes; app detects revocation and reports `permissions` snapshot |

---

## 2. Android 14 foreground-service types (requirements table)

Android 14 requires each foreground service to declare its type and to hold the
corresponding runtime permission **before** `startForeground()`:

| FGS type | Manifest entry | Prerequisite runtime permission | Start condition |
|---|---|---|---|
| `location` | `android:foregroundServiceType="location"` | `ACCESS_FINE_LOCATION` (+ `ACCESS_BACKGROUND_LOCATION` for continuous) | Location enablement confirmed |
| `dataSync` | `…="dataSync"` | none | Always (monitoring/sync service) |
| `mediaProjection` | `…="mediaProjection"` | MediaProjection user consent (per session) | Only within an ACTIVE screen session |
| `camera` | `…="camera"` | `CAMERA` granted | Only within an ACTIVE camera session |
| `microphone` | `…="microphone"` | `RECORD_AUDIO` granted | Only within an ACTIVE audio session |

Additional Android 14 behaviours the app honours:

* `FOREGROUND_SERVICE` permission declared in the manifest (new requirement).
* Starting camera/mic FGS while app is in background is blocked by the OS —
  the app therefore always prompts the consent overlay in the foreground
  first (which is also the ethically correct order).
* Location FGS started from background is restricted — telemetry resumes on
  next user interaction / connectivity event instead of forcing it.

---

## 3. Deliberately NOT requested

| Permission / capability | Why we refuse it |
|---|---|
| `READ_SMS` / `SEND_SMS` / `RECEIVE_SMS` | Message content surveillance is out of scope and ethically indefensible for this product |
| `READ_CALL_LOG` / `CALL_PHONE` / `PROCESS_OUTGOING_CALLS` | Call monitoring is out of scope; emergency dialling on the LOCK screen uses the OS dialer |
| `READ_CONTACTS` | No contact harvesting. Emergency contacts are typed in BY THE PARENT in the dashboard (`users/{uid}/emergencyContacts`) |
| `RECORD_AUDIO` outside sessions | Mic is used ONLY inside consented sessions with the recording indicator on |
| `CAMERA` outside sessions | Same — silent capture is never implemented anywhere |
| `ACCESSIBILITY_SERVICE` (Accessibility) | Would enable keylogging/screen reading — explicitly forbidden; never declared |
| `REQUEST_INSTALL_PACKAGES` | No sideloading |
| `Device Admin` | Locking uses the consent-screen UI, not device-admin lockdown, to keep the child in control and avoid kiosk abuse |
| Fine location without UI | Every location collection has a visible notification + dashboard disclosure |

---

## 4. QUERY_ALL_PACKAGES — justification & Play policy

Play policy restricts `QUERY_ALL_PACKAGES` to apps whose core feature needs a
broad installed-app view. **Parental control is one of the accepted
categories**, subject to a declaration:

1. Declare the permission in Play Console → App content → Sensitive
   permissions, choosing "Device tracking / family safety" as the core
   feature, with a video demo showing: app inventory, usage dashboard and
   app blocking.
2. Preferred fallback (used when the declaration is not yet approved): query
   launcher-visible apps via `queryIntentActivities` with
   `<queries><intent …/></queries>` and read usage stats — the dashboards
   degrade to that subset and the UI says so.
3. The manifest keeps `<uses-permission android:name=
   "android.permission.QUERY_ALL_PACKAGES" tools:node="remove"/>` toggled by
   build flavour: `flavourFullRelease` includes it, `flavourPlaySafe` omits
   it, so a policy rejection never blocks the whole release.

---

## 5. Permission denial behaviour matrix

| Feature | FINE loc | BG loc | Usage access | Camera | Mic | Notifications | QUERY_ALL |
|---|---|---|---|---|---|---|---|
| Pairing & status | ok | ok | ok | ok | ok | ok | ok |
| Location history | ❌ empty | partial (foreground only) | ok | ok | ok | ok | ok |
| Usage dashboard | ok | ok | ❌ empty state | ok | ok | ok | ok |
| App inventory | ok | ok | ok | ok | ok | ok | degraded subset |
| App blocking | ok | ok | ok | ok | ok | ok | limited to visible apps |
| Screen session | ok | ok | ok | ok | ok | ok | ok |
| Camera session | ok | ok | ok | ❌ DENIED | ok | ok | ok |
| Audio session | ok | ok | ok | ok | ❌ DENIED | ok | ok |
| SOS | ok | ok | ok | ok | ok | degraded (no heads-up) | ok |
| Commands (lock, notify, sync) | ok | ok | ok | ok | ok | ok | ok |

Every ❌ is also **reported by the device** in the `permissions` snapshot on
`devices/{deviceId}`, so the parent sees *why* a feature is silent instead of
assuming the child is hiding something — the honest-state principle.

---

## 6. Onboarding order (conditional prompting)

```
Step 1  Notifications (POST_NOTIFICATIONS)        → consent overlays visible
Step 2  Location (FINE → then BG after use)       → only if parent enables it
Step 3  Usage access (Settings deep link)          → screen-time features
Step 4  Battery optimization exemption (optional)  → reliability, with explain dialog
Later   CAMERA / RECORD_AUDIO / MediaProjection   → ONLY at first consented session
```

Each step shows: what is collected, where it is visible, how to turn it off.
Nothing is requested "up front just in case".

---

## 7. Verification hooks for QA (see docs/testing.md)

* `devices/{deviceId}.permissions` snapshot changes are audited by the
  device-side audit writer (action `PERMISSIONS_SNAPSHOT`).
* Denial paths have deterministic command results: a camera session with
  camera permission missing produces `commandResults.status = FAILED` with
  `result.reason = PERMISSION_MISSING` — testable in §38.7.

---

## 8. Device Admin & Accessibility (v1.1.0 onboarding system)

Two additional user-controlled protection layers, both enabled ONLY through
visible, standard Android flows from the child app's Settings → Protection
screen (state mirrored to the parent's permission dashboard):

| Layer | What it enables | How the user grants it | Denial behaviour |
| --- | --- | --- | --- |
| **Device admin** (`DevicePolicyManager`) | Remote `lockNow()` (LOCK_DEVICE command), uninstall protection (admin must be deactivated before uninstall), lock/unlock audit events | In-app button → standard `ACTION_ADD_DEVICE_ADMIN` system dialog | Remote lock reports UNSUPPORTED; everything else keeps working |
| **Accessibility — App Guard** (`AppGuardAccessibilityService`) | Real-time foreground-package detection: block-list enforcement, bedtime enforcement, optional Settings-app protection | In-app button → `Settings.ACTION_ACCESSIBILITY_SETTINGS`; user toggles the service manually | Blocking/bedtime fall back to BedtimeReceiver + policy sync only; FEATURE NOT ENFORCED in real time |

App Guard privacy contract: it observes `TYPE_WINDOW_STATE_CHANGED` only and
reads ONLY the event's package name — no screen content, no text, no
keystrokes, `canRetrieveWindowContent=false`. A persistent low-priority
"App protection active" notification is shown while it runs.

## 9. Secret dial code

Dialing `*#*#1111#*#*` (or `*#*#1112#*#*`) opens the child app:

* **Primary**: `android.provider.Telephony.SECRET_CODE` broadcast receiver —
  works on the AOSP/Google dialer and most OEM dialers, API 17+.
* **Fallback**: `NEW_OUTGOING_CALL` interception, limited to
  `maxSdkVersion=28` (Android deprecates the API for non-dialer apps on 10+).

The receiver only un-hides (Device Owner hidden mode) and opens the visible
MainActivity; it cannot start any capture service or grant any permission.
Every activation is audit-logged (`APP_OPENED_VIA_DIAL_CODE`).

## 10. API 21 → latest support matrix (key call sites)

| Capability | Min API | Below-min behaviour |
| --- | --- | --- |
| Notifications | 21 (`POST_NOTIFICATIONS` runtime 33+) | Runtime prompt skipped pre-13 |
| Live location FGS | 21 (typed FGS 34-checked) | Plain `startForeground` pre-Q |
| UsageStats | 21 | — |
| startForegroundService | 26 | `startFgServiceCompat` → `startService` |
| stopForeground(int) | 24 | `stopForegroundCompat` → `stopForeground(true)` |
| EncryptedSharedPreferences | 23 | Plain-prefs fallback (`storageKind: "plain"`) |
| setApplicationHidden (icon hide) | 28 + Device Owner | UNSUPPORTED — icon stays visible |
| MediaProjection (screen share) | 21 | System consent dialog every session |

## 11. Backup module permissions (v1.3.0)

The consent-based cloud backup adds exactly these runtime permissions, all
requested through visible system dialogs from the in-app backup consent UI
(child opt-in comes FIRST, the dialog explains what will be backed up, and
revoking stops that category gracefully — no re-prompt nagging, no bypass):

| Permission | Used for | Version gating |
| --- | --- | --- |
| `READ_MEDIA_IMAGES` | Photos backup scan (MediaStore) | API 33+ |
| `READ_MEDIA_VIDEO` | Videos backup scan (MediaStore) | API 33+ |
| `READ_EXTERNAL_STORAGE` (maxSdk 32) | Photos/Videos scan pre-13 | ≤ Android 12L |
| `WRITE_EXTERNAL_STORAGE` (maxSdk 28) | Media RESTORE writes only | ≤ Android 9 |
| `READ_CONTACTS` | Contacts backup scan (ContactsContract) | 21+ |
| `WRITE_CONTACTS` | Contacts restore (visible inserts) | 21+ |
| `READ_SMS` (optional module) | SMS backup scan | 21+ — **restricted permission**; ungranted ⇒ honest UNSUPPORTED (Play policy), no AppOps/default-SMS bypass |

Backup permission states are published to the parent's Permission Dashboard
via `PermissionReporter` (`backupReadMediaImages`, `backupReadMediaVideos`,
`backupReadContacts`, `backupReadSms`). Backup content is AES-256-GCM
encrypted on-device before upload; the full data-flow and key model is in
`docs/backup.md`.
