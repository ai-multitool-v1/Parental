"use client";
/**
 * webrtc-viewer.ts — parent-side WebRTC ANSWERER (v1.4.2).
 *
 * এই ফাইলটা ছাড়া লাইভ সেশন "কাজ করত না": চাইল্ড অ্যাপ WebRTC পুরো
 * ইমপ্লিমেন্ট করা (ScreenCapturerAndroid / Camera2 / AudioTrack + Firestore
 * signaling), কিন্তু parent dashboard-এ offer-এর ANSWER দেওয়ার কেউই ছিল না —
 * চাইল্ড consent দিয়ে streaming শুরু করত, parent দেখতই না।
 *
 * Flow (Firestore signaling — devices/{id}/sessions/{sid}/signals):
 *   1. child consents → posts OFFER envelope  (from=="child")
 *   2. parent (এখানে) offer পড়ে → RTCPeerConnection.setRemoteDescription
 *      → ANSWER envelope লেখে (from=="parent")
 *   3. দুই পক্ষ candidate envelope exchange → P2P/TURN media connect
 *   4. ontrack → remote MediaStream <video>/<audio> element-এ বসে
 *   5. যেকোনো পক্ষ bye লিখলে connection বন্ধ
 *
 * Rules (firestore.rules): parent শুধু from=="parent" envelope লিখতে পারে,
 * createdAt অবশ্যই serverTimestamp — দুটোই এখানে enforce করা।
 */

import {
  getFirestore,
  doc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
  type Firestore,
} from "firebase/firestore";
import { firebaseApp } from "./real";

export type ViewerState =
  | "connecting" // session doc / signals অপেক্ষায়
  | "waiting_offer" // session ACTIVE — child offer অপেক্ষায়
  | "connecting_media" // offer এসেছে, answer পাঠানো হয়েছে — ICE চলছে
  | "live" // অন্তত একটা track এসেছে
  | "ended" // bye / session ENDED
  | "failed";

export interface ViewerOptions {
  deviceId: string;
  sessionId: string;
  kind: "screen" | "camera" | "audio";
  videoEl?: HTMLVideoElement | null;
  audioEl?: HTMLAudioElement | null;
  onState: (state: ViewerState, detail?: string) => void;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function decodeIceServers(raw: unknown): RTCIceServer[] {
  if (!Array.isArray(raw)) return DEFAULT_ICE;
  const servers: RTCIceServer[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const urls = (s as { urls?: unknown }).urls;
    if (typeof urls === "string") servers.push({ urls } as RTCIceServer);
    else if (Array.isArray(urls)) servers.push({ urls } as RTCIceServer);
  }
  return servers.length > 0 ? servers : DEFAULT_ICE;
}

/**
 * Starts the parent-side viewer. Returns a stop() that closes the peer
 * connection, unsubscribes listeners and posts a best-effort `bye`.
 * The caller MUST call it on unmount / session end.
 */
export function startViewer(opts: ViewerOptions): () => void {
  const { deviceId, sessionId, kind, videoEl, audioEl, onState } = opts;
  let stopped = false;
  let pc: RTCPeerConnection | null = null;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  let offerApplied = false;
  const unsubs: Array<() => void> = [];
  let fs: Firestore | null = null;

  const state = (s: ViewerState, detail?: string) => {
    if (!stopped) onState(s, detail);
  };

  async function sendSignal(envelope: Record<string, unknown>): Promise<void> {
    if (!fs || stopped) return;
    try {
      await addDoc(
        collection(fs, "devices", deviceId, "sessions", sessionId, "signals"),
        { ...envelope, from: "parent", createdAt: serverTimestamp() },
      );
    } catch (err) {
      // Rules-violation/network — retrying blindly won't help; surface it.
      console.warn("[viewer] signal send failed:", err instanceof Error ? err.message : err);
    }
  }

  function closePeer(silent = false): void {
    if (pc) {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      pc = null;
    }
    if (!silent) state("ended");
  }

  void (async () => {
    try {
      fs = getFirestore(firebaseApp());
    } catch (err) {
      state("failed", "Firebase not configured");
      return;
    }

    // ---- 1) session doc → iceServers + state --------------------------
    let iceServers = DEFAULT_ICE;
    try {
      const snap = await getDoc(doc(fs, "devices", deviceId, "sessions", sessionId));
      if (snap.exists()) {
        iceServers = decodeIceServers(snap.data()["iceServers"]);
        if (snap.data()["state"] && snap.data()["state"] !== "ACTIVE") {
          // Still REQUESTED — wait; commandResult flips it ACTIVE on consent.
        }
      }
    } catch (err) {
      console.warn("[viewer] session doc read failed:", err instanceof Error ? err.message : err);
    }

    // ---- 2) peer connection -------------------------------------------
    try {
      pc = new RTCPeerConnection({ iceServers });
    } catch (err) {
      state("failed", "WebRTC unsupported in this browser");
      return;
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        void sendSignal({
          kind: "candidate",
          candidateSdp: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid ?? undefined,
          sdpMLineIndex: ev.candidate.sdpMLineIndex ?? undefined,
        });
      }
    };

    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      const media = stream ?? new MediaStream([ev.track]);
      if (videoEl && ev.track.kind === "video") {
        videoEl.srcObject = media;
        videoEl.classList.remove("hidden");
        void videoEl.play().catch(() => {
          /* autoplay policy — user gesture already present via modal */
        });
      }
      if (ev.track.kind === "audio") {
        if (audioEl) {
          audioEl.srcObject = media;
          void audioEl.play().catch(() => {});
        } else if (videoEl) {
          // camera session: audio rides on the same video element
          videoEl.srcObject = media;
          void videoEl.play().catch(() => {});
        }
      }
      state("live");
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") state("live");
      else if (pc.connectionState === "failed") {
        state("failed", "ICE connection failed");
        closePeer(true);
      } else if (pc.connectionState === "closed") closePeer(true);
    };

    // ---- 3) child signal listener (offer / candidates / bye) ----------
    const signalsQuery = query(
      collection(fs, "devices", deviceId, "sessions", sessionId, "signals"),
      where("from", "==", "child"),
    );
    unsubs.push(
      onSnapshot(
        signalsQuery,
        (snap) => {
          snap.docChanges().forEach((chg) => {
            if (chg.type !== "added") return;
            const sig = chg.doc.data() as Record<string, unknown>;
            const kindSig = String(sig["kind"] ?? "");

            if (kindSig === "offer" && typeof sig["sdp"] === "string") {
              if (!pc) return;
              offerApplied = true;
              void (async () => {
                try {
                  await pc!.setRemoteDescription(
                    new RTCSessionDescription({ type: "offer", sdp: sig["sdp"] as string }),
                  );
                  state("connecting_media");
                  for (const c of pendingCandidates.splice(0)) {
                    await pc!.addIceCandidate(c).catch(() => {});
                  }
                  const answer = await pc!.createAnswer();
                  await pc!.setLocalDescription(answer);
                  await sendSignal({ kind: "answer", sdp: answer.sdp, sdpType: "answer" });
                } catch (err) {
                  state("failed", `SDP error: ${err instanceof Error ? err.message : "unknown"}`);
                }
              })();
            } else if (kindSig === "candidate" && typeof sig["candidateSdp"] === "string") {
              const cand: RTCIceCandidateInit = {
                candidate: sig["candidateSdp"] as string,
                sdpMid: typeof sig["sdpMid"] === "string" ? (sig["sdpMid"] as string) : null,
                sdpMLineIndex: typeof sig["sdpMLineIndex"] === "number" ? (sig["sdpMLineIndex"] as number) : null,
              };
              if (offerApplied && pc) {
                void pc.addIceCandidate(cand).catch(() => {});
              } else {
                pendingCandidates.push(cand);
              }
            } else if (kindSig === "bye") {
              closePeer(false);
            }
          });
          if (!offerApplied) state("waiting_offer");
        },
        (err) => {
          console.warn("[viewer] signals listener error:", err.message);
          state("failed", "Signaling read failed (rules/network)");
        },
      ),
    );

    state("waiting_offer");
  })();

  // ---- stop(): bye + teardown -------------------------------------------
  return () => {
    if (stopped) return;
    stopped = true;
    void sendSignal({ kind: "bye" });
    unsubs.forEach((u) => u());
    closePeer(true);
  };
}
