# Security Audit Report — v1.1.1

> Full-codebase adversarial review of BOTH deliverables (parent web dashboard
> + child Android app + Firebase backend), performed per the user's standing
> requirement: *"sob file er security check, jate kono hacker ba attacker
> compromise korte na pare, web ebong apps duitai te."*
>
> Method: line-by-line review of every authorization decision, cross-layer
> consistency check (rules ↔ functions ↔ Android ↔ web), dangerous-pattern
> scan (XSS / eval / secrets / weak crypto), and adversarial simulation of
> the §38 test matrix (Parent A vs Parent B, child vs parent, replay, anon).

---

## 0. Result summary

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **CRITICAL** | `functions/src/lib/` (verify/audit/commands/constants/users) was missing from the repo — the backend did not compile and its security core (auth, rate limits, audit) was effectively absent | **FIXED** — rebuilt hardened (`lib/verify.ts`, `lib/audit.ts`, `lib/commands.ts`, `lib/constants.ts`, `lib/users.ts`, `lib/turn.ts`); `tsc --noEmit` = 0 errors |
| F2 | **CRITICAL** | Android `CommandProcessor` TTL bypass: a command with a MISSING `expiresAt` defaulted to `Long.MAX_VALUE` → a crafted/replayed push executed regardless of age | **FIXED** — fail-closed: missing/malformed expiry ⇒ `REJECTED` |
| F3 | **CRITICAL** | Android `CommandProcessor` accepted commands whose `deviceId` field was absent (match skipped on `null`) | **FIXED** — mandatory deviceId match; absence ⇒ `REJECTED` |
| F4 | **HIGH** | `SignalingClient.openSession/closeSession` wrote session documents directly from the client — `firestore.rules` (correctly) deny ALL client writes to `sessions/*`; live-mode handshakes would fail, and "fixing" it naively would have opened a session-forgery hole | **FIXED** — session docs remain function-only; child teardown now (a) sends a `bye` signal envelope and (b) calls the new `endSession` Cloud Function (device-claim-authorized). New narrow rules block added for `sessions/{sid}/signals/*` |
| F5 | **HIGH** | Hardcoded TURN relay credentials (`placeholder-user` / `placeholder-password`) compiled into the Android APK — decompilable by anyone | **FIXED** — credentials removed from the app; per-session EPHEMERAL TURN credentials (coturn REST/HMAC-SHA1 scheme, 10-min TTL) are issued server-side by `requestSession` into the session doc (`iceServers`); secret lives in Secret Manager (`TURN_STATIC_AUTH_SECRET`). No relay configured ⇒ STUN-only fallback |
| F6 | **HIGH** | Rate limiting was per-instance in-memory → under autoscaling the effective limit multiplied by instance count (brute-force surface) | **FIXED** — Firestore-transaction sliding-window limiter, hashed ledger keys, global across instances; call sites now `await` it; ledger GC via `retentionPurge` |
| F7 | **MEDIUM** | Web dashboard served with `typescript.ignoreBuildErrors=true` and no security headers | **FIXED** — build errors now fail the build; full header set added: CSP (Firebase-scoped `connect-src`), `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (`camera=()`, `microphone=()`, `geolocation=()` — the parent browser only ever RECEIVES media), HSTS |
| F8 | **MEDIUM** | Device-admin profile declared `limit-password` although no code path uses it — unused declared policies widen the admin attack surface | **FIXED** — trimmed to `force-lock` + `watch-login` (audit-only) |
| F9 | **MEDIUM** | `onSosCreated` pruned invalid FCM tokens against the WRONG parent (accumulator leaked across the parents loop) | **FIXED** — per-parent invalid-token lists |
| F10 | **MEDIUM** | Android allowed cleartext HTTP on API 21–27 (platform default flips only at API 28) while `minSdk=21` | **FIXED** — `android:usesCleartextTraffic="false"` in the manifest |
| F11 | **LOW** | `dispatchCommand`/`requestSession`/`confirmPairing`/`generatePairingCode`/`sendParentNotification` did not await the (formerly sync) limiter | **FIXED** — all five call sites `await enforceRateLimit(...)` |
| F12 | **LOW** | No composite index for peer signaling listen queries | **FIXED** — `signals` collection-group index (`from` ASC + `createdAt` ASC) added to `firestore.indexes.json` |

### Verified-safe (no action needed)

- **Firestore rules posture**: deny-all fallback, tenant isolation via
  `devices/{id}/parents/{uid}` links, custom-claims device identity,
  append-only telemetry + audit, `pairingCodes` zero client surface,
  client command-create blocked for EVERYONE (incl. parents), update
  field-whitelists via `diff().affectedKeys()` — re-verified line by line.
- **No XSS / code-injection sinks**: the single `dangerouslySetInnerHTML`
  (shadcn `chart.tsx`) injects a style string built ONLY from
  developer-defined config colors — no user data flows into it. No
  `eval`, `new Function`, or `document.write` anywhere.
- **No secrets in the repo**: `.env` holds only a local SQLite path;
  `google-services.json.example` is fully placeholder; web Firebase config
  uses public `NEXT_PUBLIC_*` keys only; no service-account material exists
  client-side (the standing "no privileged credentials in client JS" rule).
- **Pairing crypto**: `randomBytes % 32` (unbiased, 40-bit), 5-min TTL,
  single-use transactional consumption, takeover protection, parent-account
  confirmation guard — both server (node:crypto) and demo (WebCrypto)
  implementations use CSPRNGs.
- **Android consent model**: every media path requires in-app
  Allow/Decline + typed foreground service + visible notification;
  `BOOT_COMPLETED` only reschedules WorkManager; accessibility service
  cannot read window content (`canRetrieveWindowContent=false`);
  secret-code receiver can only OPEN the visible app.
- **Replay defense in depth**: server terminal-state guard
  (`COMMAND_REPLAY_BLOCKED`) + device encrypted-prefs processed-ID cache +
  (now) mandatory server-issued TTL on every command.

---

## 1. Adversarial scenarios re-tested

| Attack | Path blocked by |
|---|---|
| Parent B reads Parent A's child data | `isParentOf()` fails closed; rules T02/T18 |
| Anonymous stranger creates a LOCK command | `commands create: if false` for ALL clients; only `dispatchCommand` callable, which demands pairing link + parent profile + App Check (T08/T09) |
| Child flips its own `ownerParentUid` / role | device update field-whitelist excludes identity fields (T06) |
| Child fabricates/withdraws an SOS | SOS create is device-only; parent ack field-limited; device update denied (T22–T24) |
| Replay of a captured command | server TTL + terminal-state guard + device processed-ID cache + (new) mandatory `expiresAt` (F2) |
| Parent forges another parent's command | `createdBy` is server-stamped from the verified caller; client create=false (T09) |
| Decompiling the APK for relay credentials | TURN creds no longer exist in the APK (F5) |
| Malicious child app spamming `endSession` | requires the exact custom claims only `confirmPairing` issues; rate-limited; idempotent on terminal states |
| Cross-parent signaling injection | signals `from` bound to caller identity; unpaired parents rejected (T36–T37c tests added) |
| Clickjacking / MIME sniffing of the dashboard | CSP frame-ancestors + XFO + nosniff (F7) |

## 2. New test coverage

- `firestore.rules.test.ts`: T36 (valid child signal), T37 (identity-spoof
  denied), T37b (outsiders denied), T37c (oversized SDP denied), T38
  (session docs stay function-only).
- Both layers compile clean: functions `tsc --noEmit` = 0 errors; rules
  tests `tsc --noEmit` = 0 errors; web `tsc --noEmit` + production build
  pass with type-checking enforced; security headers verified on a running
  production server.

## 3. Deployment notes (unchanged requirements, restated)

1. `firebase functions:secrets:set TURN_STATIC_AUTH_SECRET` (and
   `TURN_URI`) to enable the TURN relay — otherwise STUN-only.
2. Enable App Check enforcement once rollout metrics look clean
   (`APP_CHECK_SOFT=true` env is available as a documented soft mode).
3. Enable the `onParentLogin` blocking function per-provider in the
   Firebase console (never for the anonymous child provider).
4. Deploy rules + indexes together with functions:
   `firebase deploy --only firestore:rules,firestore:indexes,functions,storage`.
