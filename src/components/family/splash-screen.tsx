"use client";
/**
 * Splash Screen — ওয়েবসাইটের ব্র্যান্ডিং স্প্ল্যাশ।
 * প্রতি browser session-এ একবার দেখায় (sessionStorage dedup), ক্লিক করলে স্কিপ।
 * Developer credit সহ — "Develop By Silent Exploit Team Bd · Powered By AI MultiTool"
 */
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { CREDIT_LINE, DEVELOPER_CREDIT, POWERED_BY } from "@/lib/family/branding";

const SPLASH_KEY = "fs_splash_shown_v1";
const DURATION_MS = 2600;

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(8);

  useEffect(() => {
    const start = Date.now();
    const iv = window.setInterval(() => {
      const pct = Math.min(100, ((Date.now() - start) / DURATION_MS) * 100);
      setProgress(Math.max(8, pct));
    }, 60);
    const t = window.setTimeout(onDone, DURATION_MS);
    return () => {
      window.clearInterval(iv);
      window.clearTimeout(t);
    };
  }, [onDone]);

  return (
    <button
      type="button"
      aria-label="স্প্ল্যাশ স্কিপ করুন"
      onClick={onDone}
      className="fixed inset-0 z-[100] flex min-h-screen w-full cursor-pointer flex-col items-center justify-center gap-6 bg-gradient-to-br from-emerald-700 via-emerald-800 to-teal-900 text-white outline-none"
    >
      {/* পটভূমির আলো */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-24 -left-24 h-72 w-72 rounded-full bg-emerald-400/20 blur-3xl animate-pulse" />
        <div className="absolute -bottom-24 -right-24 h-72 w-72 rounded-full bg-teal-400/20 blur-3xl animate-pulse" />
      </div>

      <div className="relative flex flex-col items-center gap-5">
        <span className="flex h-24 w-24 items-center justify-center rounded-3xl bg-white/10 shadow-2xl ring-1 ring-white/25 backdrop-blur animate-in zoom-in-50 duration-500">
          <ShieldCheck className="h-12 w-12 text-emerald-100" />
        </span>
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Family Safety</h1>
          <p className="mt-1 text-sm text-emerald-200/90">Consent-based Parental Control Platform</p>
        </div>
      </div>

      {/* প্রগ্রেস বার */}
      <div className="relative mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-white/15">
        <div
          className="h-full rounded-full bg-emerald-300 transition-all duration-100 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Developer credit */}
      <div className="absolute bottom-8 flex flex-col items-center gap-1 px-4 text-center">
        <p className="text-xs font-medium text-emerald-100/90">{DEVELOPER_CREDIT}</p>
        <p className="text-[11px] text-emerald-200/70">{POWERED_BY}</p>
      </div>
      <p className="absolute bottom-3 text-[10px] text-emerald-200/50">{CREDIT_LINE} — স্কিপ করতে ট্যাপ করুন</p>
    </button>
  );
}

/**
 * Session-dedup wrapper: প্রতি browser session-এ একবার স্প্ল্যাশ।
 * (setState সব deferred — synchronous effect setState নেই)
 */
export function useSplashOnce(): [boolean, () => void] {
  const [show, setShow] = useState(true);
  useEffect(() => {
    let t: number;
    let seen = false;
    try {
      seen = !!sessionStorage.getItem(SPLASH_KEY);
      if (!seen) sessionStorage.setItem(SPLASH_KEY, "1");
    } catch {
      /* storage ব্লক থাকলে প্রতিবার দেখায় — harmless */
    }
    t = window.setTimeout(() => setShow(false), seen ? 0 : DURATION_MS);
    return () => window.clearTimeout(t);
  }, []);
  const done = () => {
    try {
      sessionStorage.setItem(SPLASH_KEY, "1");
    } catch {
      /* noop */
    }
    setShow(false);
  };
  return [show, done];
}
