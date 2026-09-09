# Security Model

> Threat-informed, server-authoritative security for a consent-based parental
> control platform. Companion docs: `architecture.md` (flows),
> `firestore.rules` (enforcement), `testing.md` (§38 matrix).

---

## 1. Identity model

| Principal | Identity | Proof at request time | Powers |
|---|---|---|---|
| Parent | Firebase Auth account (email+password, MFA recommended) | Firebase ID token + App Check | Everything filtered by pairing links; no global roles |
| Child device | Anonymous Firebase Auth identity (uid = `childUid`) generated at first run | ID token **+ custom claims** `{ deviceRole: "childDevice", deviceId }` set by `confirmPairing` | Append-only telemetry for its own device; command status flips; its own audit entries |
| Cloud Functions | Admin SDK (server) | Project credentials | Only writer of: devices, pairing links, policies, commands, sessions, notifications, top-level alerts/audit |
| Anonymous stranger | — | — | Nothing. Firestore deny-all fallback; callables require auth + App Check |

Design choice — **custom claims over token-hash lookup**: `isChildDevice()` in
`firestore.rules` checks `request.auth.token.deviceRole/.deviceId`. Claims are
set once at pairing via `setCustomUserClaims`, cannot be written by clients,
add zero extra reads per request, and survive token refresh. A
`devices/{id}/tokens/{tokenHash}` lookup doc would add a rule `exists()` read
per access and a secret to protect — strictly worse.

## 2. Pairing security

| Control | Value |
|---|---|
| Code entropy | 8 chars × 5 bits = **40 bits** (~1.1 × 10¹²), unbiased `randomBytes % 32` |
| Alphabet | No 0/O/1/I (misread-resistant) |
| TTL | **5 minutes** |
| Single use | Marked `used` inside the pairing transaction; second confirm rejected |
| Active-code cap | Max **5** unused codes per parent |
| Rate limits | 10 generations/hour/parent; 20 confirm attempts/hour/uid |
| Takeover protection | A device bound to another childUid/parent is rejected |
| Parent-side guard | A caller with a `users/{uid}` parent profile cannot confirm pairing (must be the child device) |
| Visibility | Codes are never client-readable (`pairingCodes` rules deny all); delivered in the callable result |

Brute-force math: at 1,000 guesses/sec an attacker covers ~0.03 % of the keyspace
before a 5-minute code expires; server-side confirm rate limiting makes it worse.

## 3. Command authorization pipeline

Every dispatch passes **all** gates:

```
requireParent(deviceId, uid)      devices/{id}/parents/{uid} must exist
App Check                         attested client (soft → hard rollout)
Rate limit                        30 commands / hour / parent
Whitelist                         14 fixed types — nothing else parses
Payload validation                per-type allowed keys, lengths, JSON ≤ 8 KiB
Admin-SDK creation                clients cannot create commands (rules)
TTL 5 min                         expiresAt stamped; scheduler expires stragglers
Single-use                        terminal states never transition again
Replay audit                      duplicates → COMMAND_REPLAY_BLOCKED / DENIED
No code execution                 payloads are data; the device has a FIXED
                                  handler map — unknown type ⇒ ignored + audited
```

## 4. Replay / expiry protection (summary)

1. `commandId` = UUIDv4, never client-chosen.
2. Device re-validates `expiresAt` from Firestore (push alone is not truth).
3. `onCommandResult` refuses state changes on EXECUTED/FAILED/EXPIRED.
4. `cleanupExpired` (5 min) closes the window even if the device never answers.
5. Session requests additionally expire in 15 minutes and can only become
   ACTIVE via a device consent result.

## 5. Firestore rules — surface summary

| Path | Parent (paired) | Parent B (unpaired) | Child device | Anonymous |
|---|---|---|---|---|
| devices/{A} | get / list(filter own) | **none** | get; update: status/fcmToken/permissions/appVersion/lastSeenAt/policyVersionAcknowledged ONLY | none |
| devices/{A}/parents | read | none | read | none |
| policies/current | read | none | read | none |
| commands | read | none | read; update **status only** | none; **create: nobody** |
| commandResults | read | none | create/update (own, shape-checked) | none |
| locations / appUsage / installedApps | read | none | **create-only** (append-only telemetry) | none |
| notifications | read | none | read | none (writes: functions only) |
| emergencyEvents | read; update acknowledged(+audit fields) | none | **create-only** (SOS), no updates | none |
| sessions | read | none | read | none (writes: functions only) |
| auditLogs (device) | read | none | **create** with `createdAt == request.time`; never update/delete | none |
| auditLogs (top-level) | none | none | none | none |
| pairingCodes | none | none | none | none |
| users/{uid} | own get/update-whitelist | cross-read denied | — | none; delete: nobody |
| children | read own (via parentUid) | none | — | none (writes: functions only) |
| emergencyAlerts | read/ack if in `parentUids` | none | — | none |

Enforced by `diff().affectedKeys().hasOnly([...])` whitelists — identity fields
(`ownerParentUid`, `childUid`, `deviceId`, `role`, `createdBy`, `requestedBy`,
`accountLocked`) are in **no** client-writable whitelist anywhere.

## 6. App Check

* Providers: **Play Integrity** (Android), **reCAPTCHA Enterprise** (web).
* Rollout: functions param `APP_CHECK_MODE = off → soft → hard`.
  * `soft`: logs unverified requests (deploy day).
  * `hard`: `request.app` missing ⇒ `permission-denied`. Set to `hard` in
    production after ≥99 % verified traffic for a week.
* Callable path: every callable calls `assertAppCheck(request)`; rules-level
  App Check enforcement can be layered in later (`request.app != null` in
  rules) without changing callables.

## 7. FCM token hygiene

* Device token lives on `devices/{deviceId}.fcmToken` (device-writable field
  whitelist) — rotated automatically by the SDK; old sends fail with
  `registration-token-not-registered`.
* Parent web tokens live in `users/{uid}.fcmTokens[]`; `onSosCreated` /
  `escalationCheck` prune invalid tokens opportunistically.
* All FCM messages are **data** messages with `android.ttl` bound to the
  command TTL — stale pushes cannot resurrect expired commands.

## 8. Rate limiting (Firestore-transaction sliding window — GLOBAL)

> Upgraded in the v1.1.1 security audit: the earlier design used an
> in-memory map, whose effective limit multiplied by instance count under
> autoscaling. The limiter now runs inside a Firestore transaction against a
> hashed-key ledger (`_rateLimits/{sha256(key)}`), so the limit holds across
> ALL instances and regions. Ledger docs carry `expireAt` and are purged by
> retentionPurge. Call sites `await` the limiter; a ledger outage degrades
> to logged-bypass (fail-open with loud logging) because the real
> authorization gates (pairing link, claims, TTL, single-use) are
> independent of rate limiting.

| Action | Limit |
|---|---|
| dispatchCommand | 30 / hour / parent |
| requestSession | 20 / hour / parent |
| sendParentNotification | 60 / hour / parent |
| generatePairingCode | 10 / hour / parent |
| confirmPairing | 20 / hour / uid |
| endSession (device callable) | 60 / hour / device |
| Sign-in (blocking fn) | 20 / 15 min / parent |

## 9. MFA guidance (parents)

1. Firebase Console → Authentication → Sign-in method → enable **SMS** and/or
   **TOTP** multi-factor.
2. Enrol parents at first dashboard login (TOTP recommended — no phone number
   collection, better privacy).
3. `onParentLogin` blocking function audits each sign-in and refuses locked
   accounts and sign-in floods.
4. Optional: require MFA for any sign-in from a new device by checking the
   `beforeUserSignedIn` `user` metadata and setting `accountLocked` +
   support flow as the break-glass.

## 10. Dashboard hardening (Next.js)

| Control | Implementation |
|---|---|
| CSP | `Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com; frame-ancestors 'none'; object-src 'none'; base-uri 'none'` via `next.config.ts` headers |
| Cookies | `__Secure-` prefix, `Secure; HttpOnly; SameSite=Strict`, short session + refresh rotation (NextAuth) |
| CSRF | SameSite=Strict + double-submit token on any non-Firebase POST routes |
| Secrets | Only `NEXT_PUBLIC_*` Firebase web config is public by design; Admin SDK keys live exclusively in Cloud Functions / Secret Manager |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` |
| Dependencies | lockfile + `npm audit` in CI; Firebase SDK pinned major versions |
| Session↔Firestore coupling | Firestore rules check `request.auth.uid` from the Firebase ID token, not the Next.js session — a stolen web cookie cannot escalate beyond that uid's pairing links |

## 11. Threat model

| # | Threat | Vector | Impact | Mitigations |
|---|---|---|---|---|
| T1 | Unauthorized parent reads child data | Parent B guesses/knows deviceId | Privacy breach | Access root = pairing link doc Parent B doesn't have; rules deny; generic errors avoid existence leaks |
| T2 | Stolen pairing code | Shoulder-surfing / leaked screenshot | Device bound to attacker | 5-min TTL, single-use, 40-bit entropy, confirm rate limit, takeover rejection, audit `PAIR_DEVICE` |
| T3 | Command replay | Old FCM push re-delivered or result re-posted | Wrong state | 5-min TTL + device-side expiry check + trigger terminal-state lock + `COMMAND_REPLAY_BLOCKED` audit |
| T4 | Device theft | Attacker holds unlocked child phone | Telemetry manipulation | Device identity is append-only — cannot rewrite history; unpair via account deletion; parents see last-seen + permission snapshot anomalies |
| T5 | MITM | Network interception | Data exposure | TLS everywhere (Firebase), DTLS for WebRTC media, no plaintext transports, certificate pinning optional in app |
| T6 | Forged telemetry | Parent or device fabricates data | False sense of safety | Telemetry create-only per device identity; parents have zero telemetry writes; audit entries timestamped `== request.time` |
| T7 | SOS spoofing | Parent fakes child SOS | Panic / trust erosion | SOS create = device-only rule; ack = linked-parent-only; full audit trail |
| T8 | Brute-force pairing codes | Scripted confirmPairing calls | Unauthorized pairing | Rate limit 20/h/uid + entropy math above + App Check (hard mode blocks scripts) |
| T9 | Stolen parent session | XSS / cookie theft | Account misuse | CSP, HttpOnly+SameSite cookies, MFA, blocking-function rate limit, Firestore rules bound to ID-token uid |
| T10 | Privilege self-escalation by child app | Tampered client writes identity fields | Device re-binding | `hasOnly` field whitelists; identity fields unwritable; claims set only by Admin SDK |
| T11 | Malicious insider (backend operator) | Direct DB access | Privacy breach | Audit mirror exported to BigQuery (append-only), alerting on mass reads, documented operator playbook |

## 12. Incident response & audit

* Platform-wide `auditLogs` (client-blind) records ALLOWED/DENIED for every
  privileged action — the §38 denials (`COMMAND_REPLAY_BLOCKED`,
  `LOGIN_BLOCKED`) are greppable in Cloud Logging.
* Recommended alarms: spike in DENIED audits, pairing confirms outside
  onboarding hours, escalation reminders > N/day, FCM error rates.
* BigQuery export via the official Firestore stream extension gives
  immutable, queryable history beyond the 365-day purge.

## 12. Developer Admin & platform ban system (v1.2.0)

**Identity**: `admin` is a Firebase Auth custom claim, set exclusively via
Admin SDK (`functions/scripts/setAdminClaim.ts`). There is no admin
password, no admin role document, and no client-reachable promotion path.
The web console at `/admin` is intentionally not linked from the parent
dashboard; its demo credentials protect nothing real (in-browser
simulation only) and are replaced by the claim in Firebase mode.

**Authorization matrix (verified)**

| Actor | Capability | Enforced by |
|---|---|---|
| Non-admin token → `adminSetBanState` | DENIED | `requireAdmin` claim check + rules T39–T41 |
| Admin → ban user | `users/{uid}.banned=true` + token revocation | callable; immutable for `role=="admin"` targets |
| Admin → ban device | `devices/{id}.banned=true` | callable (UUID-validated) |
| Banned user → sign in | REFUSED | `onParentLogin` blocking fn |
| Banned user/device → command | REFUSED | `dispatchCommand` checks both flags |
| Banned device → telemetry write | DENIED | rules `!('banned' in resource.data) || banned != true` (T42) |
| Anyone (incl. admin) → write `adminAudit` | DENIED | rules; SDK-only append |

**Admin self-abuse limits**: admins cannot ban themselves or another admin;
admin callables are rate-limited (30/h) through the global Firestore
ledger; every attempt — successful or not — lands in the audit trail.

**Console hardening (demo layer)**: 5 failed logins → 5-minute lockout
(audited `ADMIN_LOGIN_LOCKOUT`), timing-safe credential comparison,
in-memory-only session (no storage persistence of the session), and a
replay-safe merged audit view. See `docs/deployment.md` §12 for the
operations runbook.
