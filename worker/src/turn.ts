/**
 * turn.ts — session-scoped WebRTC ICE configuration (port of functions'
 * lib/turn.ts). Credentials NEVER ship inside the app: requestSession embeds
 * a session-scoped ICE list into the session doc, generated here.
 *
 * Configuration (Worker vars/secrets):
 *   TURN_URL     e.g. "turn:turn.example.com:3478?transport=udp"
 *   TURN_SECRET  coturn `use-auth-secret` shared secret → REST-style
 *                time-limited credentials (1 h), username=<expiry>:<sid>
 *   STUN_URLS    optional comma list overriding the default Google STUN
 *
 * Without TURN config we return STUN-only ICE (works on many home networks).
 */

import { hmacB64 } from "./crypto";
import type { Env } from "./env";

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

const DEFAULT_STUN: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Builds an ICE server list bound to one session (ephemeral TURN creds). */
export async function buildIceServers(
  env: Env,
  sessionId: string
): Promise<IceServer[]> {
  const ice: IceServer[] = [];

  const stunRaw = env.STUN_URLS;
  if (stunRaw) {
    for (const urls of stunRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      ice.push({ urls });
    }
  } else {
    ice.push(...DEFAULT_STUN);
  }

  const turnUrl = env.TURN_URL;
  const turnSecret = env.TURN_SECRET;
  if (turnUrl && turnSecret) {
    // coturn REST API (use-auth-secret): username = <unix-expiry>:<nonce>,
    // credential = HMAC-SHA1(secret, username) — base64. HMAC-SHA1 comes from
    // WebCrypto (SHA-1 is still available for this legacy coturn protocol).
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const nonce = sessionId.replace(/-/g, "").slice(0, 12);
    const username = `${expiry}:${nonce}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(turnSecret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(username)
    );
    const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
    ice.push({ urls: turnUrl, username, credential });
    const tcpUrl = env.TURN_TCP_URL;
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

// hmacB64 is kept for other modules (signed backup proxy URLs).
export { hmacB64 };
