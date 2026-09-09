# Family Safety Platform — monorepo root

> **Consent-based parental control & family safety.** A parent web dashboard
> and a child Android device talk through a hard zero-trust Firebase backend.
> Every privileged action is server-authorized; every session is
> child-consented; nothing is ever collected invisibly.

```
┌────────────────────┐        ┌──────────────────────┐        ┌────────────────────┐
│ Parent Web (Next.js│◄──────►│ Firebase             │◄──────►│ Child Android      │
│ repo-root src/)    │  HTTPS │ Auth·Firestore·FCM   │  HTTPS │ Kotlin app         │
└────────────────────┘  +FCM  │ Functions·App Check  │  +FCM  │ (consent overlays) │
                              └──────────────────────┘        └────────────────────┘
```

## Folder map

| Path | Contents | Owner |
|---|---|---|
| `/` (repo root, `src/`) | **Parent Web Dashboard** — Next.js 16 + shadcn/ui. Runs in **demo mode** without Firebase env vars; live mode once `NEXT_PUBLIC_FIREBASE_*` are set. | main agent |
| `parental-control/android/` | **Child Android app** (Kotlin): pairing UX, consent overlays, telemetry workers, FCM receiver, fixed command executor. | Task 2-a |
| `parental-control/functions/` | **Cloud Functions v2 (nodejs20, TypeScript)** — pairing, commands, sessions, emergency, notifications, retention. | Task 2-b |
| `parental-control/firebase/` | `firestore.rules` (production-grade), `firestore.indexes.json`, `firebase.json`, `storage.rules` (deny-all), **§38 rules test suite** (`firestore.rules.test.ts` + emulator harness). | Task 2-b |
| `parental-control/docs/` | `architecture.md` · `permissions.md` · `security.md` · `privacy.md` · `deployment.md` · `testing.md` | Task 2-b |

## Quick start

**1. Backend (functions + rules)**

```bash
cd parental-control/functions && npm install && npm run build   # typecheck
cd ../firebase && firebase login && firebase use --add
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Full walkthrough (project creation, App Check, claims verification, Play
notes): [`docs/deployment.md`](docs/deployment.md).

**2. Firestore security tests (emulator)**

```bash
cd parental-control/firebase && npm install && npm test
```

**3. Parent web dashboard** (repo root)

```bash
npm install && npm run dev
# Demo mode works with zero config. For live mode add .env.local:
# NEXT_PUBLIC_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID / _APP_ID …
```

**4. Child Android app** — see `parental-control/android/README` (Task 2-a):
build, install, enter the 8-character code shown by the dashboard.

## Feature checklist (spec §1–§40)

Legend: **A** = android · **W** = web · **F** = functions/rules.

- [ ] §1 Product overview & goals (docs/architecture.md)
- [ ] §2 Ethics & consent principles (docs/privacy.md §2, §8)
- [ ] §3 System architecture (docs/architecture.md)
- [ ] §4 Parent web dashboard shell (repo root `src/`)
- [ ] §5 Demo mode with mock data (web `lib/firebase` fallback)
- [ ] §6 Firebase service layer / callables (functions/src)
- [ ] §7 Android app scaffold (parental-control/android)
- [ ] §8 Child device identity: UUID only, IMEI never used (functions `requireDeviceId`, docs/security.md §1)
- [ ] §9 Parent signup & auth (rules `users`, web auth screens)
- [ ] §10 MFA guidance (docs/security.md §9)
- [ ] §11 Pairing code generation — 40-bit, 5-min TTL, ≤5 active (F `generatePairingCode`)
- [ ] §12 Pairing confirmation + custom claims (F `confirmPairing`)
- [ ] §13 Multi-parent / co-parent support (devices/{id}/parents)
- [ ] §14 Device inventory & status (W + F)
- [ ] §15 Heartbeat & permission snapshot (A → rules device-update whitelist)
- [ ] §16 Policy model & versioning (devices/{id}/policies/current, offline ack)
- [ ] §17 SYNC_POLICY command (F whitelist, A executor)
- [ ] §18 App inventory SYNC_APPS / installedApps (append-only telemetry)
- [ ] §19 Usage stats SYNC_USAGE / appUsage (30-day retention)
- [ ] §20 Screen-time schedules (policies + web editor)
- [ ] §21 App blocking (policies + A enforcement)
- [ ] §22 LOCK_DEVICE (consent-screen lock, no device-admin abuse)
- [ ] §23 SEND_NOTIFICATION parent→child (F `sendParentNotification`)
- [ ] §24 Location & history (A telemetry, W map, 30-day purge)
- [ ] §25 Command pipeline — whitelist-only (F `dispatchCommand`)
- [ ] §26 Command TTL 5 min + single-use + replay lock (F trigger + rules)
- [ ] §27 Rate limiting on every callable (30 cmds/h etc., docs/security.md §8)
- [ ] §28 Screen session (consent overlay → ACTIVE → ENDED) (F `requestSession`)
- [ ] §29 Camera session (same consent machine + runtime permission)
- [ ] §30 Audio session (same, recording indicator)
- [ ] §31 Session auto-expiry & cleanup (F `cleanupSessions`, ≤1 h hard cap)
- [ ] §32 SOS events (device-only create, rules-enforced)
- [ ] §33 Emergency alerts + acknowledge (F `onSosCreated`)
- [ ] §34 Escalation reminders (F `escalationCheck`, default 5 min)
- [ ] §35 Tamper-evident audit logs (device + platform mirror, append-only)
- [ ] §36 Retention & purge 30/90/30/30/365 (F `retentionPurge`)
- [ ] §37 Account deletion & unpair cascade (F `onUserDeleted`)
- [ ] §38 Security test matrix (docs/testing.md + firebase/firestore.rules.test.ts)
- [ ] §39 Deployment & hardening (docs/deployment.md)
- [ ] §40 Privacy & compliance (docs/privacy.md)

## Ethical / safety statement

1. **Consent-based, always.** Camera, microphone and screen sharing start only
   after the child accepts the on-device overlay, run with visible indicators,
   and can be stopped by the child at any moment. There is no code path — no
   flag, role, or function — that bypasses device consent.
2. **No invisible surveillance.** No SMS/call/contact harvesting, no
   keylogging, no accessibility scraping, no stealth capture, no IMEI
   identity. What is collected is listed in `docs/privacy.md` §1 and shown on
   the device.
3. **Server-authoritative safety.** Clients cannot self-escalate: pairing
   links, claims, whitelists and rules make cross-parent access, forged
   telemetry and arbitrary commands impossible (see `docs/security.md` §11).
4. **Not an emergency service.** SOS is an in-family alert channel only.
   Every related surface states that real emergencies belong to local
   emergency numbers (911/112/999/…). The system never auto-dials and never
   replaces professional help.
5. **Data minimization.** Retention 30/90/365 days, purge jobs audited,
   one-tap account deletion with full device-data cascade, Cloud Storage
   deny-all (no media ever stored server-side).

## Document map

| Doc | Read it for |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Diagrams, flows, Firestore schema, scaling |
| [`docs/permissions.md`](docs/permissions.md) | Every Android permission, Android 14 FGS types, denial matrix |
| [`docs/security.md`](docs/security.md) | Identity, pairing, replay, App Check, threat model |
| [`docs/privacy.md`](docs/privacy.md) | Data inventory, consent model, GDPR, "never does" list |
| [`docs/deployment.md`](docs/deployment.md) | Firebase setup → production hardening → Play notes |
| [`docs/testing.md`](docs/testing.md) | §38 matrix, consent/SOS QA scripts, CI |
