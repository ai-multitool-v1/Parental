/**
 * turn.ts — session-scoped WebRTC ICE configuration.
 *
 * Signaling and media are peer-to-peer; Firebase never carries media. But
 * NATted mobile networks usually need a TURN relay to establish the DTLS
 * connection. Credentials NEVER ship inside the app: requestSession embeds
 * a session-scoped ICE list into the session doc, generated here.
 *
 * Configuration (functions env / .env — see README → Live sessions):
 *   TURN_URL        e.g. "turn:turn.example.com:3478?transport=udp"
 *   TURN_SECRET     coturn `use-auth-secret` shared secret → REST-style
 *                   time-limited credentials (1 h), username=<expiry>:<sid>
 *   STUN_URLS       optional comma list overriding the default Google STUN
 *
 * Without TURN config we return STUN-only ICE (works on many home networks;
 * the dashboard surfaces "relay unavailable" in that case).
 */

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

import { createHmac } from "node:crypto";

const DEFAULT_STUN: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Builds an ICE server list bound to one session (ephemeral TURN creds). */
export function buildIceServers(sessionId: string): IceServer[] {
  const ice: IceServer[] = [];

  const stunRaw = process.env.STUN_URLS;
  if (stunRaw) {
    for (const urls of stunRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
      ice.push({ urls });
    }
  } else {
    ice.push(...DEFAULT_STUN);
  }

  const turnUrl = process.env.TURN_URL;
  const turnSecret = process.env.TURN_SECRET;
  if (turnUrl && turnSecret) {
    // coturn REST API (use-auth-secret): username = <unix-expiry>:<nonce>,
    // credential = HMAC-SHA1(secret, username) — base64.
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const nonce = sessionId.replace(/-/g, "").slice(0, 12);
    const username = `${expiry}:${nonce}`;
    const credential = createHmac("sha1", turnSecret).update(username).digest("base64");
    ice.push({
      urls: turnUrl,
      username,
      credential,
    });
    // TCP fallback relay when provided (tight networks block UDP).
    const tcpUrl = process.env.TURN_TCP_URL;
    if (tcpUrl) {
      ice.push({ urls: tcpUrl, username, credential });
    }
  } else {
    console.log(
      JSON.stringify({
        severity: "INFO",
        message: "turn_not_configured_stun_only",
        sessionId,
      })
    );
  }

  return ice;
}
