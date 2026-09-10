"use client";
/**
 * AppShell — সাইডবার নেভিগেশন + টপবার + view router।
 * পুরো ড্যাশবোর্ড একটি পেজে (client-side) চলে।
 *
 * v1.4.0: নিরাপত্তা-পোস্টার/অ্যাক্টিভিটি লগ/চাইল্ড সিমুলেটর প্যানেল সরানো হয়েছে —
 * অ্যাক্টিভিটি লগ শুধু ডেভেলপার অ্যাডমিন কনসোলে (/admin) দেখা যায়।
 * সেশন সক্রিয় হলে বড় মনিটর মোডাল অটো-ওপেন হয়।
 */
import { useState } from "react";
import {
  LayoutDashboard, Smartphone, MapPin, Grid3X3, Clock3, Ban, MoonStar,
  Lock, BellRing, Siren, MonitorUp, Camera, Mic, ShieldCheck,
  Settings, Users, LogOut, Menu, Moon, Sun, AlertTriangle,
  ChevronRight, CloudUpload, Crown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "next-themes";
import { useFamily } from "@/lib/family/store";
import { isRealMode } from "@/lib/family/real";
import { CREDIT_LINE, PLATFORM_VERSION } from "@/lib/family/branding";
import { cn } from "@/lib/utils";
import { OverviewView } from "./overview-view";
import { DevicesView } from "./devices-view";
import { LocationView } from "./location-view";
import { AppsView } from "./apps-view";
import { ScreenTimeView } from "./screen-time-view";
import { BedtimeView } from "./bedtime-view";
import { ControlView } from "./control-view";
import { NotificationsView } from "./notifications-view";
import { EmergencyView } from "./emergency-view";
import { SessionsView } from "./sessions-view";
import { BackupView } from "./backup-view";
import { SettingsView } from "./settings-view";
import { ActiveSessionModal } from "./session-modal";

export type ViewKey =
  | "overview" | "devices" | "location" | "apps" | "screen-time" | "restrictions"
  | "bedtime" | "control" | "backup" | "notifications" | "emergency"
  | "session-screen" | "session-camera" | "session-audio" | "session-safety"
  | "settings";

/** প্রিমিয়াম-অনলি ভিউ — ফ্রি ইউজারের নেভিগেশনে ক্রাউন দেখানো হয় */
const PREMIUM_VIEWS: ViewKey[] = ["control", "backup", "session-screen", "session-camera", "session-audio", "session-safety"];

export const VIEW_META: Record<ViewKey, { title: string; icon: React.ReactNode; section: string }> = {
  overview: { title: "ওভারভিউ", icon: <LayoutDashboard className="h-4 w-4" />, section: "মূল" },
  devices: { title: "ডিভাইসসমূহ", icon: <Smartphone className="h-4 w-4" />, section: "মূল" },
  location: { title: "লাইভ লোকেশন ও হিস্টোরি", icon: <MapPin className="h-4 w-4" />, section: "লোকেশন" },
  apps: { title: "ইনস্টলড অ্যাপস", icon: <Grid3X3 className="h-4 w-4" />, section: "অ্যাপ ও ব্যবহার" },
  "screen-time": { title: "স্ক্রিন টাইম", icon: <Clock3 className="h-4 w-4" />, section: "অ্যাপ ও ব্যবহার" },
  restrictions: { title: "অ্যাপ রেস্ট্রিকশন", icon: <Ban className="h-4 w-4" />, section: "অ্যাপ ও ব্যবহার" },
  bedtime: { title: "ঘুমের সময় (Bedtime)", icon: <MoonStar className="h-4 w-4" />, section: "অ্যাপ ও ব্যবহার" },
  control: { title: "ডিভাইস কন্ট্রোল", icon: <Lock className="h-4 w-4" />, section: "কন্ট্রোল" },
  backup: { title: "ক্লাউড ব্যাকআপ", icon: <CloudUpload className="h-4 w-4" />, section: "কন্ট্রোল" },
  notifications: { title: "নোটিফিকেশন পাঠান", icon: <BellRing className="h-4 w-4" />, section: "কন্ট্রোল" },
  emergency: { title: "ইমার্জেন্সি / SOS", icon: <Siren className="h-4 w-4" />, section: "কন্ট্রোল" },
  "session-screen": { title: "স্ক্রিন শেয়ারিং", icon: <MonitorUp className="h-4 w-4" />, section: "সেশন (Consent-based)" },
  "session-camera": { title: "ক্যামেরা সেশন", icon: <Camera className="h-4 w-4" />, section: "সেশন (Consent-based)" },
  "session-audio": { title: "অডিও সেশন", icon: <Mic className="h-4 w-4" />, section: "সেশন (Consent-based)" },
  "session-safety": { title: "সেফটি সেশন", icon: <ShieldCheck className="h-4 w-4" />, section: "সেশন (Consent-based)" },
  settings: { title: "সেটিংস", icon: <Settings className="h-4 w-4" />, section: "সেটিংস" },
};

const SECTION_ORDER = ["মূল", "লোকেশন", "অ্যাপ ও ব্যবহার", "কন্ট্রোল", "সেশন (Consent-based)", "সেটিংস"];

function StatusDot({ status }: { status: "online" | "recently_active" | "offline" }) {
  const color =
    status === "online" ? "bg-emerald-500" : status === "recently_active" ? "bg-amber-500" : "bg-rose-500";
  const label = status === "online" ? "Online" : status === "recently_active" ? "Recently Active" : "Offline";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={cn("h-2 w-2 rounded-full", color, status === "online" && "animate-pulse")} />
      {label}
    </span>
  );
}

function SidebarNav({ current, onNavigate }: { current: ViewKey; onNavigate: (v: ViewKey) => void }) {
  const isPremium = useFamily((s) => s.isPremium());
  const keys = Object.keys(VIEW_META) as ViewKey[];
  return (
    <nav aria-label="ড্যাশবোর্ড নেভিগেশন" className="flex flex-col gap-4">
      {SECTION_ORDER.map((section) => (
        <div key={section}>
          <p className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {section}
          </p>
          <ul className="space-y-0.5">
            {keys
              .filter((k) => VIEW_META[k].section === section)
              .map((k) => (
                <li key={k}>
                  <button
                    onClick={() => onNavigate(k)}
                    aria-current={current === k ? "page" : undefined}
                    className={cn(
                      "w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors min-h-[40px]",
                      current === k
                        ? "bg-emerald-600 text-white font-medium shadow-sm"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {VIEW_META[k].icon}
                    <span className="truncate">{VIEW_META[k].title}</span>
                    {PREMIUM_VIEWS.includes(k) && !isPremium && (
                      <Crown className="ml-auto h-3.5 w-3.5 text-amber-500" aria-label="প্রিমিয়াম ফিচার" />
                    )}
                    {k === "emergency" && <UnackBadge />}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UnackBadge() {
  const count = useFamily((s) => s.emergencies.filter((e) => !e.acknowledged).length);
  if (count === 0) return null;
  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white animate-pulse">
      {count}
    </span>
  );
}

function PlanBadge() {
  const isPremium = useFamily((s) => s.isPremium());
  return isPremium ? (
    <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
      <Crown className="h-3.5 w-3.5" /> প্রিমিয়াম
    </span>
  ) : (
    <span className="hidden sm:inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
      ফ্রি প্ল্যান
    </span>
  );
}

function SosBanner({ onOpen }: { onOpen: () => void }) {
  const emergencies = useFamily((s) => s.emergencies);
  const acknowledge = useFamily((s) => s.acknowledgeSOS);
  const unack = emergencies.find((e) => !e.acknowledged);
  const childName = useFamily((s) => s.device.childName);
  if (!unack) return null;
  return (
    <div className="mx-3 mt-3 rounded-lg border-2 border-rose-500 bg-rose-50 dark:bg-rose-950/40 p-3 shadow-md">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-600 text-white animate-pulse shrink-0">
          <Siren className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="font-bold text-rose-700 dark:text-rose-300">🚨 EMERGENCY ALERT — {childName === "—" ? "ডিভাইস" : childName} SOS পাঠিয়েছে</p>
          <p className="text-xs text-rose-600/90 dark:text-rose-400/90 truncate">
            {new Date(unack.timestamp).toLocaleTimeString("bn-BD")} · Battery {unack.batteryLevel}% · {unack.networkType} · Location {unack.lat ? "Available" : "N/A"} · Escalation #{unack.escalationLevel}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" className="border-rose-400 text-rose-700 hover:bg-rose-100 dark:text-rose-300" onClick={onOpen}>
            <MapPin className="h-4 w-4 mr-1" /> লোকেশন
          </Button>
          <Button size="sm" className="bg-rose-600 hover:bg-rose-700 text-white" onClick={() => acknowledge(unack.id)}>
            Acknowledge
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const [view, setView] = useState<ViewKey>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const parent = useFamily((s) => s.parent);
  const device = useFamily((s) => s.device);
  const logout = useFamily((s) => s.logout);
  const { theme, setTheme } = useTheme();

  const navigate = (v: ViewKey) => {
    setView(v);
    setMobileNav(false);
  };

  const renderView = () => {
    switch (view) {
      case "overview": return <OverviewView onNavigate={navigate} />;
      case "devices": return <DevicesView onNavigate={navigate} />;
      case "location": return <LocationView />;
      case "apps": return <AppsView mode="apps" />;
      case "restrictions": return <AppsView mode="restrictions" />;
      case "screen-time": return <ScreenTimeView />;
      case "bedtime": return <BedtimeView />;
      case "control": return <ControlView />;
      case "backup": return <BackupView />;
      case "notifications": return <NotificationsView />;
      case "emergency": return <EmergencyView onNavigate={navigate} />;
      case "session-screen": return <SessionsView type="screen" />;
      case "session-camera": return <SessionsView type="camera" />;
      case "session-audio": return <SessionsView type="audio" />;
      case "session-safety": return <SessionsView type="safety" />;
      case "settings": return <SettingsView />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* টপবার */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex h-14 items-center gap-3 px-3">
          {/* মোবাইল নেভ */}
          <Sheet open={mobileNav} onOpenChange={setMobileNav}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="মেনু খুলুন">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 overflow-y-auto">
              <SheetTitle className="flex items-center gap-2 text-base">
                <span className="h-7 w-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center">
                  <Users className="h-4 w-4" />
                </span>
                Family Safety
              </SheetTitle>
              <div className="mt-4">
                <SidebarNav current={view} onNavigate={navigate} />
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2 min-w-0">
            <span className="hidden sm:flex h-8 w-8 rounded-lg bg-emerald-600 text-white items-center justify-center shrink-0">
              <Users className="h-4 w-4" />
            </span>
            <h1 className="font-bold truncate">Family Control</h1>
            <ChevronRight className="hidden sm:inline h-4 w-4 text-muted-foreground shrink-0" />
            <span className="hidden sm:inline text-sm text-muted-foreground truncate">{VIEW_META[view].title}</span>
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {/* মোড ব্যাজ — ডেমো হলে স্পষ্ট সতর্কতা, রিয়েল হলে নিশ্চিতকরণ */}
            {isRealMode() ? (
              <Badge className="hidden sm:inline-flex bg-emerald-600 text-white">লাইভ</Badge>
            ) : (
              <Badge
                variant="outline"
                className="hidden sm:inline-flex text-amber-600 border-amber-400 dark:text-amber-400 dark:border-amber-600"
                title="ডেমো মোড — Vercel env vars সেট করে Redeploy করলে রিয়েল মোড চালু হবে"
              >
                ডেমো মোড
              </Badge>
            )}
            <PlanBadge />
            {device.paired && (
              <div className="hidden md:flex items-center gap-2 rounded-full border px-3 py-1.5">
                <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                <StatusDot status={device.status} />
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs">{Math.round(device.batteryLevel)}%{device.isCharging ? " ⚡" : ""}</span>
              </div>
            )}
            {view !== "emergency" && <UnackSosButton onOpen={() => navigate("emergency")} />}
            <Button
              variant="ghost"
              size="icon"
              aria-label="থিম পরিবর্তন"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Sun className="h-4 w-4 dark:hidden" />
              <Moon className="h-4 w-4 hidden dark:block" />
            </Button>
            <div className="hidden sm:flex items-center gap-2 rounded-full border px-3 py-1 text-xs">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="max-w-32 truncate">{parent?.email}</span>
            </div>
            <Button variant="ghost" size="icon" aria-label="লগআউট" onClick={logout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* SOS ব্যানার */}
      <SosBanner onOpen={() => navigate("emergency")} />

      {/* মূল বডি */}
      <div className="flex flex-1">
        {/* ডেস্কটপ সাইডবার */}
        <aside className="hidden lg:block w-64 shrink-0 border-r p-3 overflow-y-auto sticky top-14 self-start max-h-[calc(100vh-3.5rem)]">
          <SidebarNav current={view} onNavigate={navigate} />
        </aside>

        {/* কনটেন্ট */}
        <main className="flex-1 min-w-0 p-3 sm:p-5 pb-4">
          {renderView()}
          <footer className="mt-8 border-t pt-3 text-center text-[11px] text-muted-foreground">
            Family Safety Platform {PLATFORM_VERSION} · {CREDIT_LINE}
          </footer>
        </main>
      </div>

      {/* সক্রিয় সেশন মনিটর — বড় মোডাল (v1.4.0) */}
      <ActiveSessionModal />
    </div>
  );
}

function UnackSosButton({ onOpen }: { onOpen: () => void }) {
  const count = useFamily((s) => s.emergencies.filter((e) => !e.acknowledged).length);
  if (count === 0) return null;
  return (
    <Button
      size="sm"
      onClick={onOpen}
      className="bg-rose-600 hover:bg-rose-700 text-white animate-pulse gap-1.5"
    >
      <AlertTriangle className="h-4 w-4" />
      <span className="hidden sm:inline">SOS!</span>
      <Badge className="bg-white/20 text-white px-1.5">{count}</Badge>
    </Button>
  );
}
