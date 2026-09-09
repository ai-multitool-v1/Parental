# Privacy & Data Governance

> Consent-based family safety means the child's data is collected sparingly,
> visibly, and briefly. This page is the plain-language contract behind the
> code: what exists, where it lives, how long it stays, and how it leaves.

---

## 1. Data inventory

| Data | Purpose | Where stored | Visible to | Retention |
|---|---|---|---|---|
| Parent account (email, display name) | Authentication, dashboard | Firebase Auth + `users/{uid}` | The parent (own doc only) | Until account deletion |
| Parent FCM tokens | Push notifications | `users/{uid}.fcmTokens` | The parent | Pruned automatically; until deletion |
| Child device profile (UUID, name, app version, permission snapshot) | Device management | `devices/{id}` | Paired parents + the device | Until unpair/account deletion |
| Status & heartbeat (status, battery-ish signals, lastSeenAt) | "Is the device OK?" | `devices/{id}` | Paired parents + device | Overwritten in place (latest only) |
| Location history | Safety map | `devices/{id}/locations` | Paired parents + device | **30 days**, then auto-purge |
| App usage stats | Screen-time insight | `devices/{id}/appUsage` | Paired parents + device | **30 days** |
| Installed-app inventory | App inventory + blocking UX | `devices/{id}/installedApps` | Paired parents + device | Until refresh/re-pair (append-only rows pruned with device) |
| Policies | Screen-time rules, app limits | `devices/{id}/policies/current` | Paired parents + device | Latest version only (field `version` monotonic) |
| Commands (14 whitelisted types) | Parent actions | `devices/{id}/commands` | Paired parents + device | **30 days** past expiry |
| Command results | Execution reports | `devices/{id}/commandResults` | Paired parents + device | Pruned with device / 30-day command TTL housekeeping |
| Parent→child notifications | Messages | `devices/{id}/notifications` | Both sides | **90 days** |
| Session records (screen/camera/audio) | Consent transparency | `devices/{id}/sessions` | Both sides | **30 days** after end |
| SOS / emergency events | Family alerting | `devices/{id}/emergencyEvents` + `emergencyAlerts/{id}` | Linked parents | **365 days** (aligned with audit) |
| Audit logs | Tamper-evident trail | `devices/{id}/auditLogs` (parent-visible) + `auditLogs` mirror (client-blind) | Parents (device-local) / operators only (mirror) | **365 days** |
| Pairing codes | Pairing secret | `pairingCodes/{code}` | Nobody (server-only) | Deleted 1 h after expiry |
| WebRTC signaling blobs (optional) | Session connect | `devices/{id}/sessions` metadata only | Both sides | 30 days after end |
| **Media (video/audio/frames)** | **None** | **Never stored — Cloud Storage is deny-all** | — | n/a |

Explicitly NOT collected: SMS content, call logs, contacts (emergency contacts
are typed by the parent), browsing history, keystrokes, ambient audio outside
sessions, screenshots outside sessions, IMEI/IMSI/serial numbers, precise
advertising IDs.

---

## 2. Consent model

**Two consents exist and neither can bypass the other:**

1. **Parental consent** — the parent pairs the device and chooses which
   features to enable (location, usage, sessions). This gates what the system
   *can ask for*.
2. **Child consent (per session)** — screen/camera/audio sessions require the
   child to accept an on-device overlay. The device UI is the consent
   authority; the backend only records the outcome:

```
REQUEST_CAMERA_SESSION ──► device overlay [Allow | Deny]
        Allow ──► commandResults{consent: GRANTED, permissionState}
                    └─► session.state = ACTIVE + consent.grantedAt + indicator ON
        Deny  ──► commandResults{consent: DENIED}
                    └─► session.state = DENIED (terminal, visible to parent)
```

* A **persistent indicator** (OS cast/mic/camera icons + in-app banner) is on
  for the whole session.
* The child can always press **Stop** → `STOP_*_SESSION` result →
  `session.state = ENDED, endReason = CHILD_STOPPED`.
* Sessions auto-expire (request: 15 min; active: ≤1 h hard cap) — silence
  never equals consent.
* The parent dashboard shows consent provenance for every session
  (`requestedBy`, `consent.grantedAt`, `permissionState`).

**Indicators summary:** FGS notification (always), consent overlay (per
session), system privacy icons (OS), in-app "you are sharing" bar, dashboard
permission snapshot.

---

## 3. Retention policy (enforced by `retentionPurge`, daily 03:15)

| Data class | Age threshold | Mechanism |
|---|---|---|
| Locations | 30 days | collectionGroup purge on `timestamp` |
| Notifications | 90 days | purge on `createdAt` |
| Ended sessions | 30 days | purge on `endedAt` (live sessions never match — null ≠ timestamp in Firestore range filters) |
| Commands | 30 days past `expiresAt` | purge |
| Audit logs | 365 days | purge (device-local + mirror) |
| Expired pairing codes | 1 h after expiry | `cleanupExpired` deletes |
| Unpaired/orphaned devices | tombstone then recursive delete | `onUserDeleted` + `purgeScheduledAt` |

The purge job audits a summary (action `RETENTION_PURGE`) so compliance is
itself auditable. Retention numbers live in one place
(`functions/src/lib/constants.ts` → `RETENTION_DAYS`).

---

## 4. Account deletion (right to erasure)

Triggered by deleting the parent's Firebase Auth account (dashboard settings →
"Delete account" → Auth delete → `onUserDeleted` fires):

```
for each device owned by the parent:
    remove devices/{id}/parents/{uid}
    if no parents remain:
        revoke child device custom claims        (unpair, force re-pair)
        delete children/{childUid} linkage
        recursive-delete devices/{id}            (ALL telemetry, sessions,
                                                  commands, audit history)
        (failure → tombstone UNPAIRED + purgeScheduledAt → retentionPurge finishes)
    else:
        audit PARENT_REMOVED_FROM_DEVICE (co-parent keeps the device)
delete remaining children links, unused pairing codes, users/{uid}
audit ACCOUNT_DELETED (platform mirror, no personal payload)
```

The child device keeps functioning as an unpaired shell until re-paired —
no orphaned data flows anywhere.

## 5. Device unpair

* From the dashboard (future callable) or via account deletion above.
* Effects: pairing link removed → every rule check (`isParentOf`,
  `requireParent`) fails; FCM token cleared; device status `UNPAIRED`;
  local data purge scheduled.
* Re-pairing always requires a fresh code and never resurrects old telemetry
  (new `devices/{id}` history starts at the new `pairedAt`).

## 6. Telemetry purge (operator/runbook)

Manual purge equivalent to retention for a single device:

```
firebase functions:shell
> require("./lib") // or use console:
db.recursiveDelete(db.doc("devices/<deviceId>"))
```

Scheduled automation already covers age-based purges; manual purge is for
immediate erasure requests (GDPR Art. 17) — run `onUserDeleted`-style
deletion or the recursive delete above, then verify via the audit summary.

---

## 7. GDPR / UK GDPR / children's data notes

* **Lawful basis** (recommendation for the DPIA): consent of the functioning
  child + parental responsibility context; document per-feature. Location and
  sessions are the highest-sensitivity items — keep the 30-day retention.
* **Data minimization:** field-level whitelists in rules; no content
  surveillance data (SMS/calls/keystrokes) exists anywhere in the schema.
* **Transparency:** the child app shows collection states + indicators; the
  dashboard shows the same `permissions` snapshot the device reports.
* **Rights:** access (dashboard exports), erasure (§4), rectification
  (profile fields), portability (Firestore JSON export of the family's docs),
  objection (disable features → corresponding permissions are released).
* **Children's data:** treat the child device identity as pseudonymous
  (UUID + anonymous auth). No child email/phone is ever collected.
* **DPIA:** recommended before production use; this document + privacy
  inventory is the input skeleton.
* **Processors:** Firebase (Google Cloud) — region pinning and DPA per
  Google's standard terms; note Firestore region chosen at project creation.

---

## 8. What the system NEVER does

1. **No stealth capture** — no hidden camera/mic/screen; every capture has a
   consent overlay, an indicator, and a session record.
2. **No keylogging or accessibility scraping** — Accessibility is never
   declared in the manifest.
3. **No message/call surveillance** — SMS/call-log permissions do not exist.
4. **No contact harvesting** — emergency contacts are parent-typed, stored
   under the parent's own profile, and optional.
5. **No IMEI/hardware identity** — device identity is a random UUID; the API
   rejects anything else (`requireDeviceId`).
6. **No bypassable consent** — there is no flag, role, or function that starts
   a session without the device-side consent result.
7. **No silent policy changes** — policy version bumps are visible on the
   device (ack) and audited.
8. **No replacement for emergency services** — SOS copy always points to
   911/112/999; the system never auto-dials or messages third parties beyond
   the parent-chosen contacts.

---

## 9. Transparency artifacts

| Artifact | Where |
|---|---|
| Device-visible "what's collected" screen | Android app (Task 2-a) — driven by `devices/{id}.permissions` |
| Parent-visible audit trail | Dashboard audit view over `devices/{id}/auditLogs` |
| Session consent provenance | `sessions/{id}.consent` + audit `SESSION_STATE_CHANGED` |
| Retention receipts | top-level `auditLogs` `RETENTION_PURGE` summaries |
| This document + `docs/security.md` | Shipped with the repo |

---

*Questions about any item above should map to a §-numbered test in
`docs/testing.md` — if a behaviour can't be tested, it doesn't ship.*
