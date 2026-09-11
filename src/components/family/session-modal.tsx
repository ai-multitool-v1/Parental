"use client";
/**
 * ActiveSessionModal (v1.4.0) — বড় সেশন মনিটর।
 *
 * প্রোডাক্ট নিয়ম (ইউজার রিকোয়ারমেন্ট): স্ক্রিন শেয়ারিং confirm হলে বা
 * ক্যামেরা/ভিডিও ক্যামেরা সেশন সক্রিয় হলেই একটি বড় মোডাল খুলবে যেখানে
 * লাইভ স্ট্রিম দেখানো হবে এবং সেখান থেকেই সেশন শেষ করা যাবে।
 *
 * - সেশন state "active" হওয়ামাত্র অটো-ওপেন (consent গ্রহণের পর)।
 * - স্ক্রিন সেশনে কোনো টাইমার নেই (প্ল্যাটফর্ম নিয়ম) — শুধু End/Stop।
 * - মিনিমাইজ করলে সেশন চলতে থাকে; সেশন ভিউ থেকে আবার খোলা যায়।
 * - Real mode: video element-এ WebRTC remote stream বসে (Firestore signaling)।
 */
import { useEffect, useRef, useState } from "react";
import { Radio, Square, Minimize2, MonitorUp, Camera, Mic, ShieldCheck, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useFamily, SESSION_LABEL } from "@/lib/family/store";
import { isRealMode } from "@/lib/family/real";
import { startViewer, type ViewerState } from "@/lib/family/webrtc-viewer";
import { cn } from "@/lib/utils";
import type { SessionType } from "@/lib/family/types";

const TYPE_ICON: Record<SessionType, React.ReactNode> = {
  screen: <MonitorUp className="h-5 w-5" />,
  camera: <Camera className="h-5 w-5" />,
  audio: <Mic className="h-5 w-5" />,
  safety: <ShieldCheck className="h-5 w-5" />,
};

/**
 * Live stream stage — real mode-এ WebRTC viewer (Firestore signaling) remote
 * stream-কে video/audio element-এ বসায়; sandbox/demo-তে placeholder।
 */
function StreamStage({ type, deviceId, sessionId }: { type: SessionType; deviceId: string; sessionId: string }) {
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
    waiting_offer: "চাইল্ডের স্ট্রিমের অপেক্ষায়… (consent দিলেই শুরু হবে)",
    connecting_media: "মিডিয়া সংযোগ স্থাপন হচ্ছে…",
    live: "লাইভ",
    ended: "স্ট্রিম শেষ হয়েছে",
    failed: detail ?? "সংযোগ ব্যর্থ",
  };

  // মিডিয়া element গুলো সবসময় mount-এ থাকে (ref stability) — দৃশ্যমানতা
  // শুধু className দিয়ে নিয়ন্ত্রিত, নইলে state-switch-এ stream হারায়।
  const showVideo = type !== "audio" && (vstate === "live" || vstate === "connecting_media");

  return (
    <div className="relative overflow-hidden rounded-xl border-2 border-emerald-400 aspect-video bg-gradient-to-br from-slate-900 via-emerald-950 to-slate-900">
      <video
        ref={videoRef}
        className={cn("h-full w-full object-contain bg-black", !showVideo && "hidden")}
        autoPlay
        playsInline
      />
      <audio ref={audioRef} autoPlay className={cn("hidden", type !== "audio" && "hidden")} />
      {!showVideo && (
        <>
          <div className="absolute inset-0 opacity-30">
            <div className="absolute h-48 w-48 rounded-full bg-emerald-500/40 blur-3xl animate-pulse left-10 top-10" />
            <div className="absolute h-60 w-60 rounded-full bg-teal-500/30 blur-3xl animate-pulse right-12 bottom-6" style={{ animationDelay: "0.7s" }} />
          </div>
          {type === "audio" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
              <div className="flex items-end gap-1.5 h-16" aria-hidden>
                {[0.9, 1.4, 0.7, 1.8, 1.1, 1.5, 0.8, 1.3].map((d, i) => (
                  <span
                    key={i}
                    className="w-2.5 rounded-full bg-emerald-400/80 animate-pulse"
                    style={{ height: `${20 + i * 5}%`, animationDuration: `${d}s` }}
                  />
                ))}
              </div>
              <p className="flex items-center gap-2 text-sm font-medium"><Volume2 className="h-4 w-4" /> {SESSION_LABEL[type]}</p>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
              <span className="text-5xl animate-pulse">{type === "screen" ? "🖥️" : "🎥"}</span>
              <p className="text-base font-medium">{statusText[vstate]}</p>
              <p className="text-[11px] text-emerald-300/80">চাইল্ড ডিভাইসে indicator চালু আছে</p>
            </div>
          )}
        </>
      )}
      <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1 text-xs font-bold text-white">
        <Radio className="h-3.5 w-3.5 animate-pulse" /> {vstate === "failed" ? "ERROR" : "LIVE"}
      </div>
    </div>
  );
}

export function ActiveSessionModal() {
  const sessions = useFamily((s) => s.sessions);
  const device = useFamily((s) => s.device);
  const stopSession = useFamily((s) => s.stopSession);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [lastActiveId, setLastActiveId] = useState<string | null>(null);

  const active = sessions.find((x) => x.state === "active");

  // নতুন সেশন সক্রিয় হলে অটো-ওপেন — রেন্ডার-সময়ে অ্যাডজাস্ট (effect ছাড়া)
  if (active && active.id !== lastActiveId) {
    setLastActiveId(active.id);
    if (dismissed[active.id]) {
      setDismissed((d) => {
        const next = { ...d };
        delete next[active.id];
        return next;
      });
    }
  }

  if (!active || dismissed[active.id]) return null;

  const endSession = () => {
    if (active.type === "safety") {
      useFamily.getState().dispatchCommand("STOP_SCREEN_SESSION");
    } else {
      stopSession(active.type);
    }
    setDismissed((d) => ({ ...d, [active.id]: true }));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && setDismissed((d) => ({ ...d, [active.id]: true }))}>
      <DialogContent className="max-w-4xl lg:max-w-5xl p-4 sm:p-5">
        <DialogTitle className="sr-only">সক্রিয় সেশন</DialogTitle>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
            {TYPE_ICON[active.type]}
          </span>
          <div className="min-w-0">
            <p className="font-bold leading-tight">{SESSION_LABEL[active.type]}</p>
            <p className="text-xs text-muted-foreground truncate">
              {device.paired ? `${device.childName} · ${device.name}` : "ডিভাইস"} · চাইল্ড অনুমোদন দিয়েছে
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {active.type === "screen" && (
              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">টাইমার নেই</span>
            )}
            <Button size="sm" variant="ghost" onClick={() => setDismissed((d) => ({ ...d, [active.id]: true }))}>
              <Minimize2 className="h-4 w-4 mr-1" /> মিনিমাইজ
            </Button>
          </div>
        </div>

        <div className="mt-3">
          <StreamStage type={active.type} deviceId={device.id} sessionId={active.id} />
        </div>

        <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2.5">
          <p className={cn("text-xs text-muted-foreground flex-1")}>
            সেশন চলাকালীন চাইল্ড ডিভাইসে স্পষ্ট indicator দেখা যাচ্ছে। শেষ করতে নিচের বাটন চাপুন —
            চাইল্ডও নিজের পাশ থেকে যেকোনো সময় বন্ধ করতে পারে।
          </p>
          <Button
            size="lg"
            variant="destructive"
            onClick={endSession}
            className="text-base font-semibold gap-2"
          >
            <Square className="h-5 w-5" /> সেশন শেষ করুন
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
