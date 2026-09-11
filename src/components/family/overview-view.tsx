"use client";
/**
 * ওভারভিউ — ফ্যামিলি কন্ট্রোল হোম।
 * v1.4.0: সব নিয়ন্ত্রণ (controls) ওভারভিউতেই দেখানো হয় — ডিভাইস স্ট্যাটাস কার্ড +
 * দ্রুত অ্যাকশন গ্রিড + সাম্প্রতিক সেশন/ব্যবহার। প্রিমিয়াম-অনলি নিয়ন্ত্রণে ক্রাউন ব্যাজ।
 */
import { useState } from "react";
import {
  MapPin, Grid3X3, Lock, MonitorUp, Camera, Mic, Siren, BellRing,
  Battery, BatteryCharging, Wifi, Signal, Smartphone, ShieldCheck,
  MoonStar, Clock3, ChevronRight, Crown, CloudUpload, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useFamily, SESSION_LABEL } from "@/lib/family/store";
import { fmtMinutes } from "@/lib/family/engine";
import { SectionCard, PremiumUpsellDialog } from "./ui-bits";
import type { ViewKey } from "./app-shell";
import { cn } from "@/lib/utils";
import type { SessionType } from "@/lib/family/types";

export function OverviewView({ onNavigate }: { onNavigate: (v: ViewKey) => void }) {
  const device = useFamily((s) => s.device);
  const usage = useFamily((s) => s.usage);
  const sessions = useFamily((s) => s.sessions);
  const isPremium = useFamily((s) => s.isPremium());
  const dispatchCommand = useFamily((s) => s.dispatchCommand);
  const [upsell, setUpsell] = useState<string | null>(null);
  const activeSession = sessions.find((x) => x.state === "active");

  const totalToday = usage.reduce((a, u) => a + u.minutesToday, 0);
  const topApps = [...usage].sort((a, b) => b.minutesToday - a.minutesToday).slice(0, 3);

  const statusMeta =
    device.status === "online"
      ? { label: "🟢 Online", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" }
      : device.status === "recently_active"
        ? { label: "🟡 Recently Active", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" }
        : { label: "🔴 Offline", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" };

  /** দ্রুত নিয়ন্ত্রণ — premium: "প্রিমিয়াম" ব্যাজ, ফ্রি হলে আপগ্রেড ডায়ালগ */
  type Quick = { v: ViewKey; label: string; icon: React.ReactNode; cls?: string; premium?: boolean; act?: () => void };
  const quick: Quick[] = [
    { v: "location", label: "লোকেশন", icon: <MapPin className="h-5 w-5" /> },
    { v: "apps", label: "অ্যাপস", icon: <Grid3X3 className="h-5 w-5" /> },
    {
      v: "control", label: "লক করুন", icon: <Lock className="h-5 w-5" />, cls: "text-amber-600", premium: true,
      act: () => dispatchCommand("LOCK_DEVICE"),
    },
    { v: "backup", label: "ব্যাকআপ", icon: <CloudUpload className="h-5 w-5" />, premium: true },
    { v: "session-screen", label: "স্ক্রিন", icon: <MonitorUp className="h-5 w-5" />, premium: true },
    { v: "session-camera", label: "ক্যামেরা", icon: <Camera className="h-5 w-5" />, premium: true },
    { v: "session-audio", label: "অডিও", icon: <Mic className="h-5 w-5" />, premium: true },
    { v: "emergency", label: "ইমার্জেন্সি", icon: <Siren className="h-5 w-5" />, cls: "text-rose-600" },
    { v: "notifications", label: "নোটিফিকেশন", icon: <BellRing className="h-5 w-5" /> },
  ];

  const openQuick = (q: Quick) => {
    if (q.premium && !isPremium) {
      setUpsell(q.label);
      return;
    }
    if (q.act) {
      q.act();
      if (q.v === "control") onNavigate("control");
      return;
    }
    onNavigate(q.v);
  };

  return (
    <div className="space-y-5">
      {/* ডিভাইস হিরো কার্ড */}
      <SectionCard
        title="👨‍👩‍👧 Family Control"
        description="আপনার পরিবারের নিরাপত্তা এক নজরে"
        icon={<Smartphone className="h-4 w-4 text-muted-foreground" />}
        action={
          device.paired ? (
            <Button variant="outline" size="sm" onClick={() => onNavigate("devices")}>
              ডিভাইসসমূহ <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5" onClick={() => onNavigate("devices")}>
              <Plus className="h-4 w-4" /> ডিভাইস যুক্ত করুন
            </Button>
          )
        }
      >
        {device.paired ? (
          <div className="rounded-xl border-2 p-4 sm:p-5 bg-gradient-to-br from-emerald-50/80 to-transparent dark:from-emerald-950/20">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-600 text-white text-lg font-bold shadow">
                {device.childName.charAt(0)}
              </div>
              <div className="min-w-0">
                <p className="font-bold text-lg leading-tight">👦 {device.childName} — {device.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {device.model}{device.manufacturer ? ` · ${device.manufacturer}` : ""} · Android {device.androidVersion}
                </p>
                {(device.ramTotalMb != null || device.storageTotalGb != null) && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    {device.ramTotalMb != null && <>RAM {device.ramTotalMb >= 1024 ? `${(device.ramTotalMb / 1024).toFixed(1)} GB` : `${Math.round(device.ramTotalMb)} MB`}</>}
                    {device.ramTotalMb != null && device.storageTotalGb != null && " · "}
                    {device.storageTotalGb != null && <>স্টোরেজ {device.storageTotalGb} GB</>}
                  </p>
                )}
              </div>
              <Badge className={cn("ml-auto text-xs", statusMeta.cls)}>{statusMeta.label}</Badge>
            </div>

            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-background p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {device.isCharging ? <BatteryCharging className="h-3.5 w-3.5 text-emerald-600" /> : <Battery className="h-3.5 w-3.5" />} ব্যাটারি
                </p>
                <p className="mt-1 text-lg font-bold">{Math.round(device.batteryLevel)}%{device.isCharging && " ⚡"}</p>
                <Progress value={device.batteryLevel} className="mt-1.5 h-1.5" />
              </div>
              <div className="rounded-lg border bg-background p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {device.networkType === "wifi" ? <Wifi className="h-3.5 w-3.5" /> : <Signal className="h-3.5 w-3.5" />} নেটওয়ার্ক
                </p>
                <p className="mt-1 text-lg font-bold">{device.networkType === "wifi" ? "Wi-Fi" : device.networkType === "mobile" ? "মোবাইল" : "বিচ্ছিন্ন"}</p>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" /> স্ক্রিন টাইম আজ
                </p>
                <p className="mt-1 text-lg font-bold">{fmtMinutes(totalToday)}</p>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MoonStar className="h-3.5 w-3.5" /> Bedtime
                </p>
                <p className="text-sm font-bold">
                  {device.policy.bedtime.enabled ? `${device.policy.bedtime.start}–${device.policy.bedtime.end}` : "বন্ধ"}
                  {device.bedtimeActive && <span className="ml-1">· সক্রিয়</span>}
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* ডিভাইস যুক্ত হয়নি — খালি অবস্থা */
          <div className="rounded-xl border-2 border-dashed p-8 text-center">
            <p className="text-4xl mb-3">📱</p>
            <p className="font-semibold">এখনো কোনো ডিভাইস যুক্ত হয়নি</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
              চাইল্ডের Android ফোনে অ্যাপ ইনস্টল করে পেয়ারিং কোড দিন — তারপর সব নিয়ন্ত্রণ এখানে সক্রিয় হবে।
            </p>
            <Button size="sm" className="mt-4 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5" onClick={() => onNavigate("devices")}>
              <Plus className="h-4 w-4" /> ডিভাইস পেয়ার করুন
            </Button>
          </div>
        )}
      </SectionCard>

      {/* দ্রুত নিয়ন্ত্রণ — সবসময় ওভারভিউতে (v1.4.0) */}
      <SectionCard
        title="দ্রুত নিয়ন্ত্রণ"
        description={device.paired ? "সরাসরি এখান থেকে চালান" : "ডিভাইস পেয়ার হওয়ার পর সক্রিয় হবে"}
        icon={<Lock className="h-4 w-4 text-muted-foreground" />}
      >
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-2">
          {quick.map((q) => (
            <button
              key={q.v}
              onClick={() => openQuick(q)}
              className={cn(
                "relative flex flex-col items-center gap-1.5 rounded-xl border bg-background p-3 text-xs font-medium transition-all hover:border-emerald-400 hover:shadow-sm min-h-[68px] justify-center",
                q.cls,
                !device.paired && "opacity-70",
              )}
            >
              {q.icon}
              {q.label}
              {q.premium && !isPremium && (
                <Crown className="absolute top-1 right-1 h-3 w-3 text-amber-500" />
              )}
            </button>
          ))}
        </div>
      </SectionCard>

      <div className="grid md:grid-cols-2 gap-5">
        {/* সেশন স্ট্যাটাস */}
        <SectionCard
          title="সেশন স্ট্যাটাস"
          description="ক্যামেরা/অডিও/স্ক্রিন — সবসময় consent-based"
          icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}
        >
          {activeSession ? (
            <div className="rounded-lg border-2 border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 p-3">
              <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                {SESSION_LABEL[activeSession.type]} — Active
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                শুরু: {new Date(activeSession.startedAt ?? 0).toLocaleTimeString("bn-BD")}
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => onNavigate(`session-${activeSession.type}` as ViewKey)}>
                সেশন দেখুন
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {(["screen", "camera", "audio"] as SessionType[]).map((t) => {
                const last = sessions.find((x) => x.type === t);
                return (
                  <div key={t} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-sm">{t === "screen" ? "🖥️" : t === "camera" ? "🎥" : "🎙️"} {SESSION_LABEL[t]}</span>
                    <Badge variant={last ? (last.state === "active" ? "default" : "secondary") : "secondary"} className="text-xs">
                      {last ? (last.state === "active" ? "Active" : last.state) : "Inactive"}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* টপ অ্যাপ */}
        <SectionCard
          title="আজকের সেরা অ্যাপ"
          description="ডিভাইস থেকে সিংক করা ব্যবহারের তথ্য"
          icon={<Clock3 className="h-4 w-4 text-muted-foreground" />}
          action={
            <Button variant="ghost" size="sm" onClick={() => onNavigate("screen-time")}>
              বিস্তারিত <ChevronRight className="h-4 w-4" />
            </Button>
          }
        >
          {topApps.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              ডিভাইস পেয়ার হওয়ার পর ব্যবহারের তথ্য এখানে দেখা যাবে
            </div>
          ) : (
            <div className="space-y-3">
              {topApps.map((u) => {
                const limit = device.policy.dailyLimits[u.packageName];
                const pct = limit ? Math.min(100, (u.minutesToday / limit) * 100) : null;
                return (
                  <div key={u.packageName}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="truncate">{u.appName}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">
                        {fmtMinutes(u.minutesToday)}
                        {limit ? ` / ${limit}মি` : ""}
                      </span>
                    </div>
                    <Progress value={pct ?? Math.min(100, (u.minutesToday / Math.max(...topApps.map((x) => x.minutesToday))) * 100)} className="h-2" />
                    {pct != null && pct >= 100 && (
                      <p className="text-[11px] text-rose-500 mt-0.5">দৈনিক সীমা অতিক্রম — পলিসি প্রয়োগ হচ্ছে</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>

      <PremiumUpsellDialog open={!!upsell} onOpenChange={(o) => !o && setUpsell(null)} feature={upsell ?? ""} />
    </div>
  );
}
