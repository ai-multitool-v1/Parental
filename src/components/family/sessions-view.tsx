"use client";
/**
 * Consent-based সেশন — Screen/Camera/Audio/Safety (premium-অনলি)।
 * প্রতিটি সেশন: অভিভাবকের অনুরোধ → চাইল্ডে visible consent → সক্রিয় হলে
 * বড় মনিটর মোডাল (session-modal.tsx) অটো-ওপেন → End অপশন।
 * v1.4.0: ইন্টারনাল আর্কিটেকচার বর্ণনা সরানো হয়েছে (নিরাপত্তা) + প্রিমিয়াম গেট।
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MonitorUp, Camera, Mic, ShieldCheck, Send, Square, Radio, Timer, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFamily, SESSION_LABEL, SESSION_PERMISSION } from "@/lib/family/store";
import { isRealMode } from "@/lib/family/real";
import { fmtClock, fmtTime } from "@/lib/family/engine";
import { startViewer, type ViewerState } from "@/lib/family/webrtc-viewer";
import { SectionCard, SessionStateBadge, PermBadge, PremiumUpsellDialog } from "./ui-bits";
import { cn } from "@/lib/utils";
import type { SessionType } from "@/lib/family/types";

const TYPE_ICON: Record<SessionType, React.ReactNode> = {
  screen: <MonitorUp className="h-4 w-4 text-muted-foreground" />,
  camera: <Camera className="h-4 w-4 text-muted-foreground" />,
  audio: <Mic className="h-4 w-4 text-muted-foreground" />,
  safety: <ShieldCheck className="h-4 w-4 text-muted-foreground" />,
};

/** ইউজার-ফেসিং বর্ণনা — শুধু কী হয়, কীভাবে হয় তা নয় */
const TYPE_DESC: Record<SessionType, string> = {
  screen: "চাইল্ডের স্ক্রিন লাইভ দেখুন — চাইল্ডের অনুমতির পর চলে; কোনো টাইমার নেই",
  camera: "চাইল্ডের ক্যামেরা লাইভ দেখুন — চাইল্ডের অনুমতির পর চলে",
  audio: "চাইল্ডের ডিভাইসের আশপাশের শব্দ শুনুন — চাইল্ডের অনুমতির পর চলে",
  safety: "জরুরি অবস্থায় স্ক্রিন + ক্যামেরা + মাইক + লোকেশন একসাথে",
};

/** সক্রিয় সেশনের স্ট্রিম প্রিভিউ (বড় মোডালের ছোট সংস্করণ) — real WebRTC */
function StreamPreview({ type, deviceId, sessionId }: { type: SessionType; deviceId: string; sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [vstate, setVstate] = useState<ViewerState>("connecting");
  const [detail, setDetail] = useState<string | undefined>();

  useEffect(() => {
    if (!isRealMode()) return;
    const stop = startViewer({
      deviceId,
      sessionId,
      kind: type === "safety" ? "screen" : type,
      videoEl: videoRef.current,
      audioEl: audioRef.current,
      onState: (s, d) => {
        setVstate(s);
        setDetail(d);
      },
    });
    return stop;
  }, [deviceId, sessionId, type]);

  const statusText: Record<ViewerState, string> = {
    connecting: "সংযোগ শুরু হচ্ছে…",
    waiting_offer: "চাইল্ড স্ট্রিম শুরু করলে এখানে দেখা যাবে",
    connecting_media: "মিডিয়া সংযোগ স্থাপন হচ্ছে…",
    live: "লাইভ",
    ended: "স্ট্রিম শেষ",
    failed: detail ?? "সংযোগ ব্যর্থ",
  };
  const showVideo = type !== "audio" && (vstate === "live" || vstate === "connecting_media");

  return (
    <div className="relative overflow-hidden rounded-xl border-2 border-emerald-400 aspect-video bg-gradient-to-br from-slate-900 via-emerald-950 to-slate-900">
      <video
        ref={videoRef}
        className={cn("h-full w-full object-contain bg-black", !showVideo && "hidden")}
        autoPlay
        playsInline
      />
      <audio ref={audioRef} autoPlay className="hidden" />
      {!showVideo && (
        <>
          <div className="absolute inset-0 opacity-30">
            <div className="absolute h-40 w-40 rounded-full bg-emerald-500/40 blur-2xl animate-pulse left-8 top-8" />
            <div className="absolute h-52 w-52 rounded-full bg-teal-500/30 blur-3xl animate-pulse right-10 bottom-4" style={{ animationDelay: "0.7s" }} />
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
            <span className="text-4xl animate-pulse">{type === "screen" ? "🖥️" : type === "camera" ? "🎥" : type === "audio" ? "🎙️" : "🛡️"}</span>
            <p className="text-sm font-medium">{statusText[vstate]}</p>
          </div>
        </>
      )}
      <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white">
        <Radio className="h-3 w-3 animate-pulse" /> {vstate === "failed" ? "ERROR" : "LIVE"}
      </div>
      <div className="absolute top-2.5 right-2.5 rounded-full bg-black/50 px-2.5 py-1 text-[10px] text-white font-mono">
        {fmtClock(Date.now())}
      </div>
    </div>
  );
}

export function SessionsView({ type }: { type: SessionType }) {
  const device = useFamily((s) => s.device);
  const sessions = useFamily((s) => s.sessions);
  const consentRequests = useFamily((s) => s.consentRequests);
  const dispatchCommand = useFamily((s) => s.dispatchCommand);
  const stopSession = useFamily((s) => s.stopSession);
  const isPremium = useFamily((s) => s.isPremium());
  const [upsell, setUpsell] = useState(false);
  const [, force] = useState(0);

  // লাইভ টাইমার রিফ্রেশ
  useEffect(() => {
    const t = window.setInterval(() => force((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const mine = useMemo(() => sessions.filter((x) => x.type === type), [sessions, type]);
  const active = mine.find((x) => x.state === "active" || x.state === "waiting_child");
  const pendingConsent = consentRequests.find((c) => c.type === type && c.state === "pending");
  const needed = SESSION_PERMISSION[type];
  const missing = needed.filter((k) => !device.permissions[k]);

  const REQUEST_CMD = {
    screen: "REQUEST_SCREEN_SESSION" as const,
    camera: "REQUEST_CAMERA_SESSION" as const,
    audio: "REQUEST_AUDIO_SESSION" as const,
    safety: "TRIGGER_SAFETY_CHECK" as const,
  };

  const onRequest = () => {
    if (!isPremium) {
      setUpsell(true);
      return;
    }
    dispatchCommand(REQUEST_CMD[type]);
  };

  return (
    <div className="space-y-5">
      {!isPremium && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-3.5 flex flex-wrap items-center gap-3">
          <Crown className="h-5 w-5 text-amber-500" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 flex-1">
            {SESSION_LABEL[type]} একটি প্রিমিয়াম ফিচার — ফ্রি প্ল্যানে অনুরোধ পাঠানো যাবে না।
          </p>
          <Button size="sm" variant="outline" onClick={() => setUpsell(true)}>আপগ্রেড করুন</Button>
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_340px] gap-5">
        <SectionCard
          title={SESSION_LABEL[type]}
          description={TYPE_DESC[type]}
          icon={TYPE_ICON[type]}
        >
          {/* প্রিভিউ / placeholder — real সেশন id থাকলে WebRTC viewer */}
          {active?.state === "active" ? (
            <StreamPreview type={type} deviceId={device.id} sessionId={active.id} />
          ) : active?.state === "waiting_child" ? (
            <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 aspect-video grid place-items-center text-center p-6">
              <div>
                <p className="text-3xl mb-2 animate-pulse">⏳</p>
                <p className="font-semibold text-amber-700 dark:text-amber-300">চাইল্ডের অনুমতির অপেক্ষায়…</p>
                <p className="text-xs text-muted-foreground mt-1">
                  চাইল্ড ডিভাইসে অনুমতির ডায়ালগ দেখানো হচ্ছে ({Math.max(0, Math.ceil(((pendingConsent?.expiresAt ?? 0) - Date.now()) / 1000))} সেকেন্ড বাকি)
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border-2 border-dashed aspect-video grid place-items-center text-center p-6">
              <div>
                <p className="text-3xl mb-2 opacity-60">{type === "screen" ? "🖥️" : type === "camera" ? "🎥" : type === "audio" ? "🎙️" : "🛡️"}</p>
                <p className="text-sm text-muted-foreground">কোনো সক্রিয় সেশন নেই</p>
                {device.paired && missing.length > 0 && (
                  <p className="mt-2 text-xs text-rose-500">
                    চাইল্ড ডিভাইসে প্রয়োজনীয় অনুমতি এখনো দেওয়া হয়নি — সেশন অনুরোধের পর চাইল্ড অনুমতি দিলে শুরু হবে
                  </p>
                )}
              </div>
            </div>
          )}

          {/* অ্যাকশন */}
          <div className="mt-4 flex flex-wrap gap-2">
            {!active ? (
              <Button
                onClick={onRequest}
                disabled={!device.paired || !isPremium}
                className={cn(
                  !isPremium ? "" : "bg-emerald-600 hover:bg-emerald-700 text-white",
                )}
              >
                <Send className="h-4 w-4 mr-1.5" />
                {type === "safety" ? "🛡️ Safety Session অনুরোধ" : `${SESSION_LABEL[type]} অনুরোধ`}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => (type === "safety" ? dispatchCommand("STOP_SCREEN_SESSION") : stopSession(type))}
              >
                <Square className="h-4 w-4 mr-1.5" /> Stop
              </Button>
            )}
            {active?.state === "active" && (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Timer className="h-4 w-4" />
                {active.type === "screen" ? (
                  <>টাইমার নেই — parent বা child যেকোনো একজন Stop চাপলে শেষ হবে</>
                ) : (
                  <>স্বয়ংক্রিয় শেষ: {Math.max(0, Math.ceil(((active.expiresAt ?? 0) - Date.now()) / 1000))} সেকেন্ড</>
                )}
              </span>
            )}
          </div>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="প্রয়োজনীয় অনুমতি" icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}>
            <ul className="space-y-2">
              {needed.map((k) => (
                <li key={k} className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
                  <span>{k}</span>
                  <PermBadge ok={device.permissions[k]} />
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard title="সেশন ইতিহাস" description="প্রতিটি সেশন লগ হয়: শুরু, শেষ, অনুমতি" icon={TYPE_ICON[type]}>
            <div className="max-h-64 overflow-y-auto space-y-2">
              {mine.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">এখনো কোনো সেশন হয়নি</p>}
              {mine.map((s) => (
                <div key={s.id} className={cn("rounded-lg border p-2.5 text-xs space-y-1")}>
                  <div className="flex items-center justify-between gap-2">
                    <span>{fmtTime(s.requestedAt)}</span>
                    <SessionStateBadge state={s.state} />
                  </div>
                  <p className="text-muted-foreground">
                    {s.startedAt ? `শুরু: ${fmtTime(s.startedAt)}` : ""}
                    {s.endedAt ? ` · শেষ: ${fmtTime(s.endedAt)}` : ""} · অনুমতি: {s.consent === "approved" ? "দেওয়া হয়েছে" : s.consent === "declined" ? "দেওয়া হয়নি" : "অপেক্ষমাণ"}
                  </p>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      </div>

      <PremiumUpsellDialog open={upsell} onOpenChange={setUpsell} feature={SESSION_LABEL[type]} />
    </div>
  );
}
