"use client";
/** ছোট শেয়ার্ড UI অংশ — সব view-তে ব্যবহৃত */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, XCircle, MinusCircle, ShieldQuestion, Crown, Send } from "lucide-react";
import type { FeatureSupport, SessionState, PermissionKey } from "@/lib/family/types";
import { TELEGRAM_URL, TELEGRAM_HANDLE } from "@/lib/family/branding";
import { cn } from "@/lib/utils";

export function SectionCard({
  title,
  icon,
  description,
  action,
  children,
  className,
}: {
  title: string;
  icon?: React.ReactNode;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <div className="min-w-0">
              <CardTitle className="text-base">{title}</CardTitle>
              {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
            </div>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export const SESSION_STATE_META: Record<SessionState, { label: string; cls: string }> = {
  inactive: { label: "Inactive", cls: "bg-muted text-muted-foreground" },
  requesting: { label: "Requesting…", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  waiting_child: { label: "Waiting for Child", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 animate-pulse" },
  active: { label: "Active", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  ended: { label: "Ended", cls: "bg-muted text-muted-foreground" },
  declined: { label: "Declined", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  expired: { label: "Expired", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
};

export function SessionStateBadge({ state }: { state: SessionState }) {
  const m = SESSION_STATE_META[state];
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", m.cls)}>{m.label}</span>;
}

export function SupportBadge({ support }: { support: FeatureSupport }) {
  if (support === "supported")
    return <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-0">SUPPORTED</Badge>;
  if (support === "conditionally_supported")
    return (
      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0 gap-1">
        <ShieldQuestion className="h-3 w-3" /> CONDITIONALLY_SUPPORTED
      </Badge>
    );
  return <Badge variant="outline" className="text-muted-foreground gap-1"><MinusCircle className="h-3 w-3" /> UNSUPPORTED</Badge>;
}

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  location: "লোকেশন (ACCESS_FINE_LOCATION)",
  notifications: "নোটিফিকেশন (POST_NOTIFICATIONS)",
  usageAccess: "Usage Access (UsageStatsManager)",
  camera: "ক্যামেরা (CAMERA)",
  microphone: "মাইক্রোফোন (RECORD_AUDIO)",
  screenCapture: "স্ক্রিন ক্যাপচার (MediaProjection)",
  accessibility: "অ্যাপ সুরক্ষা (Accessibility Service)",
  deviceAdmin: "ডিভাইস অ্যাডমিন (DevicePolicyManager)",
  // v1.3.0 — backup module runtime permissions
  backupMediaPhotos: "ব্যাকআপ: ছবি (READ_MEDIA_IMAGES)",
  backupMediaVideos: "ব্যাকআপ: ভিডিও (READ_MEDIA_VIDEO)",
  backupContacts: "ব্যাকআপ: কন্টাক্ট (READ_CONTACTS)",
  backupSms: "ব্যাকআপ: SMS (READ_SMS — সীমাবদ্ধ অনুমতি)",
};

export function PermBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
      <CheckCircle2 className="h-4 w-4" /> মঞ্জুর
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-rose-500 font-medium">
      <XCircle className="h-4 w-4" /> মঞ্জুর নয়
    </span>
  );
}

export function ResultBadge({ result }: { result: string }) {
  const map: Record<string, string> = {
    APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    EXECUTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    OK: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    DENIED: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    EXPIRED: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold font-mono", map[result] ?? "bg-muted text-muted-foreground")}>
      {result}
    </span>
  );
}

/* ══════════════ v1.4.0 — Free / Premium UI ══════════════ */

/** প্রিমিয়াম-অনলি ফিচারের পাশে ছোট ক্রাউন ব্যাজ */
export function PremiumTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        className,
      )}
      title="প্রিমিয়াম ফিচার"
    >
      <Crown className="h-3 w-3" /> প্রিমিয়াম
    </span>
  );
}

const FREE_FEATURES = [
  "ডিভাইস স্ট্যাটাস ও ওভারভিউ",
  "লাইভ লোকেশন ও হিস্টোরি",
  "ইনস্টলড অ্যাপস ও স্ক্রিন টাইম",
  "অ্যাপ রেস্ট্রিকশন ও ঘুমের সময়",
  "নোটিফিকেশন পাঠানো",
  "ইমার্জেন্সি / SOS সতর্কতা",
];

const PREMIUM_FEATURES = [
  "ডিভাইস কন্ট্রোল (রিমোট লক ও ম্যানেজমেন্ট)",
  "স্ক্রিন শেয়ারিং (লাইভ)",
  "ক্যামেরা ও অডিও/ভিডিও সেশন",
  "ক্লাউড ব্যাকআপ (ছবি, ভিডিও, কন্টাক্ট, SMS)",
  "ফ্রি প্ল্যানের সব ফিচারসহ",
];

/** ফ্রি ইউজার প্রিমিয়াম ফিচারে চাপ দিলে এই আপগ্রেড ডায়ালগ খোলে */
export function PremiumUpsellDialog({
  open,
  onOpenChange,
  feature,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  feature: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-amber-500" /> প্রিমিয়াম প্রয়োজন
          </DialogTitle>
          <DialogDescription>
            {feature} ব্যবহার করতে প্রিমিয়াম প্ল্যান দরকার। ফ্রি প্ল্যানে বেসিক সব ফিচার থাকে।
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <p className="text-sm font-semibold">ফ্রি</p>
            <ul className="mt-2 space-y-1.5">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" /> {f}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border-2 border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Crown className="h-4 w-4 text-amber-500" /> প্রিমিয়াম
            </p>
            <ul className="mt-2 space-y-1.5">
              {PREMIUM_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {f}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          প্রিমিয়াম সক্রিয় করতে অ্যাডমিন/ডেভেলপারের সাথে যোগাযোগ করুন — Telegram: {" "}
          <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-sky-600 hover:underline">
            <Send className="h-3 w-3" /> {TELEGRAM_HANDLE}
          </a>
        </div>
        <Button onClick={() => onOpenChange(false)} variant="outline">বন্ধ করুন</Button>
      </DialogContent>
    </Dialog>
  );
}
