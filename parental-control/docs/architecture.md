# Architecture — Parental Control & Family Safety Platform

> Consent-based, server-authoritative family safety. This document mirrors the
> platform specification: components, data flows, the Firestore schema with
> field tables, offline behaviour, scaling notes and module maps.

---

## 1. Principles

1. **Consent first.** Camera, microphone and screen sessions ALWAYS require an
   on-device consent decision by the child. The backend tracks state; it can
   never grant a session on the child's behalf.
2. **Server-authoritative security.** Clients can never self-escalate. Every
   privileged mutation runs in a Cloud Function that re-verifies authorization
   server-side (pairing links, custom claims, App Check, rate limits).
3. **Least privilege data model.** Firestore security rules expose the minimum
   read/write surface; telemetry is append-only; audit logs are tamper-evident.
4. **No hardware identity.** Device identity is a locally generated UUID plus a
   secure pairing ceremony. IMEI / serial numbers are NEVER used for identity.
5. **Not an emergency service.** SOS is an in-family alert channel. All
   surfaces state that real emergencies belong to 911/112/999/etc.

---

## 2. System overview

```
┌───────────────────────────┐         ┌─────────────────────────────────────┐
│   PARENT WEB DASHBOARD    │         │        CHILD ANDROID DEVICE         │
│   (Next.js, repo src/)    │         │   (Kotlin, parental-control/android)│
│                           │         │                                     │
│  React Query + Firebase   │         │  Foreground services:               │
│  JS SDK (client)          │         │   • location / usage / policy sync  │
│  NextAuth session + MFA   │         │   • consent overlay UI              │
└────────────┬──────────────┘         │  FCM data-message receiver          │
             │ HTTPS (App Check)      └───────────────┬─────────────────────┘
             ▼                                        │ HTTPS (App Check)
┌──────────────────────────────────────────────────────▼─────────────────────┐
│                              FIREBASE                                      │
│                                                                            │
│  Auth (email+password, anonymous device identities, blocking fn, MFA)      │
│  App Check (Play Integrity / reCAPTCHA Enterprise)                         │
│  Cloud Functions v2 (nodejs20)  ← ALL privileged mutations                 │
│      pairing │ commands │ sessions │ emergency │ notifications │ security  │
│  Firestore (rules: least-privilege, append-only telemetry, deny-all)       │
│  FCM (data messages, high priority, TTL-bound)                             │
│  Cloud Scheduler (command expiry, session expiry, escalation, retention)   │
│  Cloud Storage: DENY-ALL — no media ever transits the backend              │
└────────────────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

| Component | Responsibility | Never does |
|---|---|---|
| Parent web dashboard | Pairing UX, policy editing, dashboards (location/usage/apps), session requests, SOS acknowledge | Write Firestore privileged docs directly (rules deny) |
| Child Android app | Consent UI, telemetry collection, command execution from a FIXED map, safety check | Accept arbitrary payloads as code; run anything not whitelisted |
| Cloud Functions | Authorization, command issuance, state machines, FCM fan-out, retention | Trust client-supplied identity fields |
| Firestore | Durable state, append-only telemetry, tamper-evident audit | Allow cross-tenant reads (Parent B ⇒ Parent A's devices) |
| FCM | Wake-up / realtime transport for commands, SOS, notifications | Carry media; a push is never authoritative by itself |

---

## 3. Pairing flow

```
Parent dashboard                Firebase                    Child device
────────────────                ────────                    ────────────
generatePairingCode() ────────► pairingCodes/{code}
  • rate-limited                { parentUid, used: false,
  • ≤5 active codes               expiresAt = +5 min }
  • 40-bit random code ◄──────── result: { code }
  (parent reads code aloud /
   types it into child app)
                                        │  confirmPairing(code, deviceId=UUIDv4,
                                                        deviceName)
                                        ▼
                              TRANSACTION:
                                code valid? unused? unexpired?
                                device not bound elsewhere?
                                ├─ devices/{deviceId} (merge)
                                ├─ devices/{id}/parents/{parentUid}   ★ link
                                ├─ children/{childUid}
                                └─ pairingCodes/{code}.used = true
                              setCustomUserClaims(childUid,
                                { deviceRole:"childDevice", deviceId })
                                        │
                                        ▼ getIdToken(true) → claims live
                                        └────────► device starts reporting
                                                   (status/heartbeat/policy ack)
```

Key properties:

* **Single-use + 5-minute TTL** (enforced inside the transaction — no race).
* **Idempotent retry**: if claim-setting failed after the transaction, the same
  device+uid can re-call `confirmPairing` and receive claims again.
* **Takeover-proof**: a device already bound to another child identity or
  parent is rejected.
* **Codes are server-only**: clients cannot read `pairingCodes/*` (rules).
* **Claims-based device identity** replaces a `tokens/{tokenHash}` lookup
  document: zero extra reads per request, survives token refresh, and cannot
  be forged (only Admin SDK writes claims).

---

## 4. Command pipeline

### 4.1 Whitespace-free whitelist

Only these 14 types exist. There is no "custom" command and no interpreter —
the Android app maps each type to a fixed local behaviour:

```
SYNC_POLICY · REQUEST_STATUS · REQUEST_LOCATION · LOCK_DEVICE ·
SEND_NOTIFICATION · SYNC_APPS · SYNC_USAGE ·
REQUEST_SCREEN_SESSION / STOP_SCREEN_SESSION ·
REQUEST_CAMERA_SESSION / STOP_CAMERA_SESSION ·
REQUEST_AUDIO_SESSION / STOP_AUDIO_SESSION ·
TRIGGER_SAFETY_CHECK
```

### 4.2 Lifecycle

```
 Parent web            Cloud Functions                Firestore                Device
 ──────────            ───────────────                ─────────                ──────
 dispatchCommand ────► requireParent (pairing link)
                       App Check + rate limit 30/h
                       whitelist + payload check
                              │ create
                              ▼
                       commands/{cmdId} ────────────► { status: PENDING,
                              │                         createdBy: parentUid,
                              │ FCM data (high,         expiresAt: +5 min }
                              │  TTL-bound)
                              ├──────────────────────────────────────────► onMessage:
                              │                                            checks expiresAt
                              │                                            status→DELIVERED
                              │                                            executes fixed map
                              │                                            writes commandResults
                       onCommandResult ◄───────────── commandResults/{r} ───┘
                       (Firestore trigger)
                         • terminal state set
                         • REPLAY BLOCKED if already
                           EXECUTED/FAILED/EXPIRED
                         • session linkage (below)
                         • audit COMMAND_RESULT
                              │
                              ▼
                       commands/{cmdId}.status = EXECUTED | FAILED
```

State machine: `PENDING → DELIVERED → EXECUTED | FAILED` and
`PENDING → EXPIRED` (scheduled `cleanupExpired`, every 5 min).

### 4.3 Why replay is dead on arrival

| Layer | Control |
|---|---|
| Dispatch | `commandId` = UUIDv4; created only by Admin SDK |
| Transport | FCM data carries `expiresAt`; device re-checks against its clock and Firestore |
| Rules | Device can only write `status` on a command; cannot create commands |
| Trigger | A terminal command never changes state again; duplicates audited as `COMMAND_REPLAY_BLOCKED` |
| Time | 5-minute TTL; scheduler marks stragglers EXPIRED |

---

## 5. Session flows (screen / camera / audio) — consent-based

```
 Parent web        requestSession fn              Firestore                Device UI
 ──────────        ─────────────────              ─────────                ─────────
 "See screen" ───► requireParent + App Check
                   + rate limit 20/h
                        │
                        ├─ sessions/{sid} ──────► { type, state: REQUESTED,
                        │                           requestedAt, expiresAt:+15min,
                        │                           consent:{granted:null} }
                        │
                        └─ REQUEST_<T>_SESSION ─────────────────────────────► CONSENT
                           command w/ payload {sessionId}                    OVERLAY
                                                                             [Allow] [Deny]
                                                                             (device decides)
 device writes commandResults/{r} ◄───────────────────────────────────────────┘
   { commandId, status: EXECUTED, result: { sessionId, consent: GRANTED|DENIED,
     permissionState: {...}, durationSeconds } }
        │
        ▼ onCommandResult → sessionLifecycle.applySessionCommandResult
   GRANTED → sessions/{sid}: state=ACTIVE, startedAt, consent.grantedAt,
             permissionState, expiresAt = now + min(duration, 1 h)
   DENIED  → sessions/{sid}: state=DENIED, consent.deniedAt  (terminal)
   STOP_*  → sessions/{sid}: state=ENDED, endReason=CHILD_STOPPED|PARENT_STOPPED
```

* `cleanupSessions` (every 10 min) expires unanswered requests and auto-ends
  overstaying ACTIVE sessions.
* **Signaling vs media path:** Firestore/FCM carry ONLY state and (optionally)
  WebRTC signaling metadata. Media (screen frames, camera, microphone) is
  direct peer-to-peer between parent browser and child device, DTLS-encrypted,
  and only ever starts after the device-side consent overlay is accepted.
  **No media passes through Firebase** (Cloud Storage is deny-all).

---

## 6. Emergency (SOS) flow

```
Device ──► devices/{id}/emergencyEvents/{eventId} (create: device-only rule)
              │ onSosCreated trigger
              ├─► top-level emergencyAlerts/{eventId}   (denormalized view)
              ├─► FCM HIGH priority to every paired parent's tokens
              └─► audit EMERGENCY_SOS
Parent dashboard: Acknowledge button ──► acknowledged=true (rules: linked
                                          parent only, limited fields)
escalationCheck (every 1 min):
  alert.acknowledged == false && now - createdAt ≥ escalationMinutes
    (users/{uid}/settings.escalationMinutes, default 5, clamped 1..60)
  → reminder FCM every ≥2 min to parents + optional secondary contacts
  → audit ESCALATION_REMINDER
```

The alert copy always includes: *"For real emergencies call your local
emergency number."* The system never auto-dials, never sends SMS, never
contacts emergency services.

---

## 7. Firestore schema

```
(pairingCodes/{code})                     server-only secrets
users/{parentUid}                         parent profiles + settings + fcmTokens
children/{childUid}                       child ↔ device ↔ parent linkage
devices/{deviceId}                        device registry + status
  ├─ parents/{parentUid}                  ★ the pairing link (access root)
  ├─ policies/current                     policy document (versioned)
  ├─ commands/{commandId}                 command queue
  │    └─ commandResults/{resultId}       device execution reports
  ├─ locations/{locationId}               append-only telemetry (30 d)
  ├─ appUsage/{usageId}                   append-only telemetry (30 d)
  ├─ installedApps/{appId}                device inventory (append-only)
  ├─ notifications/{notificationId}       parent→child messages (90 d)
  ├─ sessions/{sessionId}                 consent state machine (30 d after end)
  ├─ emergencyEvents/{eventId}            SOS source docs
  └─ auditLogs/{logId}                    tamper-evident trail (365 d)
auditLogs/{logId}                         platform-wide mirror (client-blind)
emergencyAlerts/{eventId}                 denormalized SOS for dashboards
```

### 7.1 Field tables (key fields)

**devices/{deviceId}**

| Field | Type | Written by | Notes |
|---|---|---|---|
| deviceId | string (UUID) | confirmPairing | immutable for clients |
| ownerParentUid | string | confirmPairing | immutable for clients |
| childUid | string | confirmPairing | device auth uid; immutable for clients |
| deviceName | string | confirmPairing | display only |
| status | string | device / fns | ACTIVE, OFFLINE, LOCKED, UNPAIRED |
| fcmToken | string? | device | rotated by the app |
| permissions | map? | device | last permission snapshot (for UI) |
| appVersion | string? | device | diagnostics |
| lastSeenAt | timestamp | device | heartbeat |
| policyVersion / policyVersionAcknowledged | number | fns / device | offline policy versioning |
| pairedAt | timestamp | confirmPairing | immutable |
| purgeScheduledAt | timestamp? | onUserDeleted | tombstone for retentionPurge |

**commands/{commandId}**

| Field | Type | Notes |
|---|---|---|
| commandId | string (UUID) | unique |
| deviceId | string | parent of doc |
| type | string | whitelist only (14 types) |
| payload | map | per-type validated keys; DATA only |
| createdBy | string (parentUid) | set by function; immutable |
| createdAt | timestamp | server clock |
| expiresAt | timestamp | createdAt + 5 min |
| status | string | PENDING → DELIVERED → EXECUTED/FAILED/EXPIRED |
| result | map? | filled from commandResults by trigger |
| completedAt / resultId | timestamp / string | set by trigger |

**sessions/{sessionId}**

| Field | Type | Notes |
|---|---|---|
| type | string | SCREEN \| CAMERA \| AUDIO |
| requestedBy | string (parentUid) | |
| requestedAt / startedAt / endedAt | timestamp | lifecycle clock |
| state | string | REQUESTED → ACTIVE → ENDED / DENIED / EXPIRED |
| expiresAt | timestamp | 15 min for requests; capped ≤1 h for ACTIVE |
| consent | map | granted?, grantedAt?, deniedAt?, revokedAt? |
| permissionState | map? | device-reported permission snapshot at consent |
| endReason | string? | CHILD_DENIED, CHILD_STOPPED, PARENT_STOPPED, AUTO_EXPIRED, REQUEST_TIMEOUT |

**users/{parentUid}**

| Field | Type | Notes |
|---|---|---|
| uid / role / email | string | uid==doc id; role always "parent" |
| displayName / photoUrl | string? | self-service |
| settings.escalationMinutes | number? | SOS reminder threshold (default 5) |
| fcmTokens | string[]? | web push registrations |
| accountLocked | bool? | console/Admin SDK only — never client-writable |

**Top-level auditLogs/{logId}** — `functionName, actorUid, actorType
(PARENT|DEVICE|SYSTEM), deviceId?, action, result (ALLOWED|DENIED|ERROR|INFO),
details, createdAt`. Device-local `devices/{id}/auditLogs` carries the same
shape and is parent-readable.

---

## 8. Offline behaviour & policy versioning

* The device keeps the last `policies/current` locally (secure prefs) plus a
  monotonically increasing `policyVersion`.
* While offline, the device enforces the last known policy and reports
  compliance opportunistically (`policyVersionAcknowledged` on the device doc,
  append-only usage/locations when connectivity returns).
* Commands survive offline periods inside Firestore: TTL is 5 minutes, so a
  device coming back online later than that simply sees EXPIRED — by design;
  parents re-issue if still relevant.
* FCM data messages carry `expiresAt`; the device re-validates against its own
  clock before acting (a stale push alone is never authoritative).
* Parent dashboards read Firestore directly, so stale parent connectivity
  never affects the child.

## 9. Scaling notes

| Concern | Approach |
|---|---|
| Hot documents | Every per-device collection lives under `devices/{id}` — no global counters |
| Function concurrency | `maxInstances: 20` global; scheduled jobs cap documents per run and continue next tick |
| Fan-out | SOS loops over paired parents only (typically 1–2); no topics |
| Large purges | BulkWriter + page size 300, batch cap 5000/run/day |
| Audit growth | 365-day retention; export to BigQuery via extension for long-term analytics |
| Multi-region | Deploy REGION constant = `us-central1`; change once in `lib/constants.ts` |
| Cost | Data-message FCM is free; Firestore writes dominated by telemetry → 30-day retention |

## 10. Module map

**Android app** (`parental-control/android/`, Task 2-a):

```
app/
  identity/      deviceId UUID gen, anonymous auth, claims refresh
  pairing/       code entry UX, confirmPairing callable
  transport/     FCM receiver, Firestore sync workers (WorkManager)
  policy/        policy cache, enforcement engine (schedules, app blocking)
  commands/      FIXED executor map (14 whitelist types, nothing else)
  telemetry/     location, usage stats, installed apps (append-only writes)
  sessions/      consent overlay UI, MediaProjection/camera/mic capture, WebRTC
  sos/           emergency events + safety check responder
  audit/         device-side audit writer
  ui/            child-facing screens, indicators, "you are being viewed" bar
```

**Parent web dashboard** (Next.js, repo root `src/`):

```
src/
  app/            dashboard routes (devices, location, usage, sessions, sos)
  components/     shadcn/ui based screens
  lib/firebase/   client SDK + callable wrappers (demo mode fallback)
  lib/audit/      audit log views
```

**Backend** (`parental-control/functions/src/`):

```
lib/          constants · verify (authz) · audit · commands · users
pairing/      generatePairingCode · confirmPairing
commands/     dispatchCommand · onCommandResult · cleanupExpired
sessions/     requestSession · sessionLifecycle
emergency/    onSosCreated · escalationCheck
notifications/ sendParentNotification
security/     onParentLogin · onUserDeleted · retentionPurge
```

## 11. Configuration reference

| Item | Where | Values |
|---|---|---|
| Region | functions `lib/constants.ts` + `setGlobalOptions` | `us-central1` |
| App Check mode | functions param `APP_CHECK_MODE` | off \| soft \| hard (production: hard) |
| Web env | Next.js `.env.local` | `NEXT_PUBLIC_FIREBASE_API_KEY`, `…AUTH_DOMAIN`, `…PROJECT_ID`, `…APP_ID`, `…MESSAGING_SENDER_ID`, `…STORAGE_BUCKET` |
| Command TTL / rate limits | functions `lib/constants.ts` | 5 min / 30 per hour per parent |
| Session request TTL | functions `lib/constants.ts` | 15 min |
| Escalation | `users/{uid}/settings.escalationMinutes` | default 5 min |
| Retention | functions `lib/constants.ts` | 30/90/30/30/365 days |
