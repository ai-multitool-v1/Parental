# Testing — §38 Security & Behaviour Matrix + QA Scripts

> Test IDs map 1:1 to the TEST MATRIX block in `firebase/firestore.rules`,
> the automated suite in `firebase/firestore.rules.test.ts`, and the audit
> actions emitted by the Cloud Functions. If a behaviour cannot be tested, it
> does not ship.

---

## 1. Test pyramid

```
        ┌─────────────────────────────┐
        │ Manual QA (consent/SOS UX)  │   §3 below — human eyes on overlays
        ├─────────────────────────────┤
        │ Integration (emulators)     │   functions + rules together
        ├─────────────────────────────┤
        │ Rules unit tests (§38)      │   firebase/firestore.rules.test.ts
        ├─────────────────────────────┤
        │ Function unit tests         │   validators, rate limiter, code gen
        └─────────────────────────────┘
```

Run the automated suite:

```bash
cd parental-control/firebase && npm install && npm test
```

---

## 2. §38 matrix — expected results

Legend: **PA** = paired Parent A · **PB** = Parent B (not paired) ·
**DEV** = paired child device identity (custom claims) · **ANON** =
unauthenticated. Automated? = covered by the rules test file.

### 2.1 Tenant isolation

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.1 | PA get `devices/A` | ALLOW | ✅ T01 |
| 38.2 | PB get `devices/A` | DENY (permission-denied) | ✅ T02 |
| 38.3 | PB list `devices` where `ownerParentUid==PB` | ALLOW (only B's docs) | ✅ T03 |
| 38.4 | PA list `devices` unfiltered | DENY | ✅ T04 |
| 38.5 | PB read `devices/A/locations` | DENY | ✅ T18 |
| 38.6 | PB read top-level `emergencyAlerts` of A's family | DENY | ✅ (T35) |

### 2.2 No self-escalation

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.7 | DEV update `devices/A` `{status,lastSeenAt}` | ALLOW | ✅ T05 |
| 38.8 | DEV update `devices/A` `{ownerParentUid}` | DENY | ✅ T06 |
| 38.9 | DEV update `devices/A` `{childUid}` | DENY | ✅ T06 |
| 38.10 | DEV update `devices/A` `{pairedAt}` | DENY | ✅ T06 |
| 38.11 | PA update `devices/A` (any field, direct) | DENY (functions only) | ✅ T07 |
| 38.12 | PA update own `users/PA` `{role}` or `{accountLocked}` | DENY | ✅ T30 |
| 38.13 | PA update `children/{x}` (re-point linkage) | DENY | ✅ T33 |

### 2.3 Commands

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.14 | ANON create `devices/A/commands/x` | DENY | ✅ T08 |
| 38.15 | PA create `devices/A/commands/x` (client direct) | DENY — callable only | ✅ T09 |
| 38.16 | dispatchCommand with type `RUN arbitrary` | callable rejects (invalid-argument) | fns |
| 38.17 | DEV update `commands/c` `{status: DELIVERED}` | ALLOW | ✅ T10 |
| 38.18 | DEV update `commands/c` `{result}` / `{createdBy}` | DENY | ✅ T11 |
| 38.19 | DEV create `commandResults` (own command, valid shape) | ALLOW | ✅ T12b |
| 38.20 | PA create `commandResults` | DENY | ✅ T13 |
| 38.21 | DEV create `devices/B/commandResults` | DENY (claims mismatch) | rules |
| 38.22 | duplicate commandResult after EXECUTED | trigger ignores + audits `COMMAND_REPLAY_BLOCKED` (DENIED) | fns |
| 38.23 | PENDING command older than 5 min | `cleanupExpired` marks EXPIRED | fns |
| 38.24 | 31st command within an hour by PA | callable → resource-exhausted (30/h) | fns |

### 2.4 Telemetry isolation

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.25 | DEV create own `locations` (valid shape) | ALLOW | ✅ T14 |
| 38.26 | DEV write `devices/B/locations` or `/appUsage` | DENY | ✅ T15 |
| 38.27 | PA create telemetry for A | DENY (parents never fabricate) | ✅ T16 |
| 38.28 | DEV update/delete own telemetry | DENY (append-only) | ✅ T17 |
| 38.29 | location row older than 30 days | `retentionPurge` deletes (summary in audit) | fns |

### 2.5 Pairing

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.30 | ANON/PA read `pairingCodes` | DENY | ✅ T19 |
| 38.31 | PA write `pairingCodes` | DENY (functions only) | ✅ T20 |
| 38.32 | confirm with expired code | failed-precondition | fns |
| 38.33 | confirm with already-used code | failed-precondition (or idempotent retry for SAME device+uid) | fns |
| 38.34 | confirm a device bound to another childUid/parent | already-exists / permission-denied | fns |
| 38.35 | 6th active code for one parent | resource-exhausted (max 5) | fns |
| 38.36 | deviceId = IMEI string | invalid-argument (UUID-only) | fns |

### 2.6 Sessions & consent

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.37 | PA create `sessions` via client | DENY (requestSession callable only) | ✅ T21 |
| 38.38 | DEV write `sessions` directly | DENY (consent flows via commandResults) | ✅ T21 |
| 38.39 | Device consent GRANTED | session → ACTIVE, consent.grantedAt, permissionState stored | fns |
| 38.40 | Device consent DENIED | session → DENIED (terminal), parent sees reason | fns |
| 38.41 | REQUESTED session > 15 min | cleanup → EXPIRED | fns |
| 38.42 | ACTIVE session past cap | cleanup → ENDED (`AUTO_EXPIRED`, revokedAt) | fns |
| 38.43 | STOP from child | session → ENDED (`CHILD_STOPPED`) | fns |

### 2.7 Emergency

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.44 | DEV create SOS event (own device) | ALLOW | ✅ T22 |
| 38.45 | PA create SOS event (fabricate) | DENY | rules |
| 38.46 | PA acknowledge (own family alert) | ALLOW (limited fields) | ✅ T23/T34 |
| 38.47 | DEV update SOS (withdraw/spoof) | DENY | ✅ T24 |
| 38.48 | Unacknowledged SOS > escalationMinutes | reminder FCM + audit `ESCALATION_REMINDER` (≥2 min apart) | fns |
| 38.49 | PB touches A's `emergencyAlerts` | DENY | ✅ T35 |

### 2.8 Audit & profiles

| ID | Scenario | Expected | Auto |
|---|---|---|---|
| 38.50 | DEV append audit with `createdAt == request.time` | ALLOW | ✅ T25 |
| 38.51 | DEV forge audit timestamp | DENY (equality check) | rules |
| 38.52 | anyone update/delete audit | DENY (append-only) | ✅ T26 |
| 38.53 | PA read device audit | ALLOW | ✅ T27 |
| 38.54 | anyone read top-level audit mirror | DENY | ✅ T28 |
| 38.55 | PB read `users/PA` | DENY | ✅ T31 |
| 38.56 | PA delete own `users/PA` | DENY (deletion = function cascade) | ✅ T32 |
| 38.57 | parent auth user deleted | devices unpaired/purged, children links removed, claims revoked, `ACCOUNT_DELETED` audit | fns |

---

## 3. Manual QA scripts

### 3.1 Consent flow (camera session) — the crown jewel

```
Pre: parent + child paired, camera permission NOT yet granted.
1. Parent dashboard → Device → "Start camera session".
   EXPECT: callable returns sessionId; Firestore session state=REQUESTED;
           device gets FCM within ~2 s; consent overlay appears fullscreen.
2. Child taps Deny.
   EXPECT: session state=DENIED, consent.deniedAt set; parent UI shows
           "Declined by child"; NO camera indicator anywhere; audit
           SESSION_STATE_CHANGED (REQUESTED→DENIED).
3. Parent retries; child taps Allow; OS runtime dialog appears (first time)
   → grant.
   EXPECT: session ACTIVE; consent.grantedAt + permissionState recorded;
           OS camera icon + in-app banner visible; media is P2P only
           (verify: no writes to any Storage bucket — it is deny-all).
4. Child taps Stop.
   EXPECT: session ENDED, endReason=CHILD_STOPPED, indicator clears.
5. Parent requests another session and DOES NOT respond for 15+ min.
   EXPECT: state=EXPIRED (REQUEST_TIMEOUT), no lingering overlay.
6. Disable camera permission in OS settings; parent requests a session.
   EXPECT: commandResult FAILED reason=PERMISSION_MISSING; parent UI
           explains the permission gap (honest-state principle).
```

### 3.2 SOS escalation simulation

```
1. Child app: press SOS.
   EXPECT: emergencyEvents doc (device-only write), emergencyAlerts/{id}
           created, both parents' dashboards ring, FCM notification high
           priority, audit EMERGENCY_SOS.
2. Do NOT acknowledge. Wait escalationMinutes (set users/PA
   settings.escalationMinutes = 1 for the test).
   EXPECT: reminder FCM after ~1 min, then every ≥2 min; reminderCount
           increments; ESCALATION_REMINDER audits appear.
3. Add a secondary emergency contact with fcmToken; repeat.
   EXPECT: contact receives a data push; NO SMS is ever sent (by design).
4. Acknowledge in dashboard.
   EXPECT: acknowledged=true, acknowledgedBy=<parentUid>, reminders stop.
5. Verify copy on dashboard + notifications contains the emergency-services
   disclaimer ("this is not a replacement for 911/112/999").
```

### 3.3 Offline & replay

```
1. Dispatch REQUEST_LOCATION; airplane-mode the device immediately.
   EXPECT: command stays PENDING; after 5 min cleanupExpired → EXPIRED;
           parent UI shows expired (not "failed").
2. Reconnect device with the old FCM push redelivered.
   EXPECT: device reads expiresAt, sees EXPIRED, does NOT execute;
           a duplicate commandResult (if any) hits the replay block audit.
3. Re-run steps with device clock +10 min (adb shell date) to prove the
   TTL check is device-side too.
```

### 3.4 Cross-parent isolation (5-minute adversarial pass)

```
1. Pair device A with parent A. Get parent B an account.
2. As B, try: GET devices/A, GET devices/A/locations, dispatchCommand(A),
   requestSession(A), sendParentNotification(A), ack A's alerts.
   EXPECT: every single call → permission-denied; each denial audited
           (platform mirror) with result=DENIED.
3. Check Cloud Logging for the DENIED audit spike.
```

---

## 4. CI integration

```yaml
# .github/workflows/backend-tests.yml (excerpt)
- run: npm ci --prefix parental-control/firebase
- run: cd parental-control/firebase && npm test          # §38 rules suite
- run: npm ci --prefix parental-control/functions && npm run lint --prefix parental-control/functions
```

Rules tests are deterministic and emulator-backed — gate every merge on them.

---

## 5. Release gate checklist

- [ ] §38 suite green (all 57 IDs above accounted for: ✅ automated, `fns` covered by function tests/manual scripts)
- [ ] Manual QA 3.1 & 3.2 executed on a real device (consent + SOS are UX-critical)
- [ ] Audit entries present for every manual step (spot-check top-level mirror)
- [ ] Retention job summary seen in audit after first staging day
- [ ] `APP_CHECK_MODE=hard` smoke test: a curl call without App Check header → permission-denied
