"use client";
/**
 * ডিভাইস কন্ট্রোল (spec §16-§18, §31) — Remote Lock, reliability dashboard,
 * permission dashboard। Parent কখনো জোর করে Android permission grant করতে
 * পারে না — শুধু status দেখানো হয়।
 */
import { useState } from "react";
import {
  Lock, Battery, BellRing, HeartPulse, ShieldCheck, ShieldAlert,
  Info, Smartphone, CheckCircle2, XCircle, RefreshCw, Server, GitBranch, EyeOff, Crown,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useFamily } from "@/lib/family/store";
import { fmtClock } from "@/lib/family/engine";
import { SectionCard, SupportBadge, PermBadge, PERMISSION_LABELS, PremiumTag, PremiumUpsellDialog } from "./ui-bits";
import type { PermissionKey } from "@/lib/family/types";

export function ControlView() {
  const device = useFamily((s) => s.device);
  const dispatchCommand = useFamily((s) => s.dispatchCommand);
  const unpair = useFamily((s) => s.unpairDevice);
  const updatePolicy = useFamily((s) => s.updatePolicy);
  const isPremium = useFamily((s) => s.isPremium());
  const [confirming, setConfirming] = useState(false);
  const [hideConfirm, setHideConfirm] = useState(false);
  const [upsell, setUpsell] = useState(false);

  const r = device.reliability;
  const perms = device.permissions;
  const isLocked = device.locked;
  const isOwnerManaged = device.managementMode === "device_owner" || device.managementMode === "profile_owner";
  const hideSupported: "supported" | "conditionally_supported" | "unsupported" =
    device.managementMode === "device_owner" || device.managementMode === "profile_owner"
      ? "supported"
      : device.managementMode === "admin"
        ? "conditionally_supported"
        : "unsupported";

  const permKeys: PermissionKey[] = ["location", "notifications", "usageAccess", "camera", "microphone", "screenCapture", "accessibility", "deviceAdmin"];

  return (
    <div className="space-y-5">
      {!isPremium && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-3.5 flex flex-wrap items-center gap-3">
          <Crown className="h-5 w-5 text-amber-500" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 flex-1">
            ডিভাইস কন্ট্রোল একটি প্রিমিয়াম ফিচার — ফ্রি প্ল্যানে রিমোট লক ও ম্যানেজমেন্ট ব্যবহার করা যায় না।
          </p>
          <Button size="sm" variant="outline" onClick={() => setUpsell(true)}>আপগ্রেড করুন</Button>
        </div>
      )}
      <div className="grid lg:grid-cols-2 gap-5">
        {/* রিমোট লক */}
        <SectionCard
          title="Remote Lock"
          description="চাইল্ডের ফোন সাথে সাথে লক করুন"
          icon={<Lock className="h-4 w-4 text-muted-foreground" />}
          action={!isPremium ? <PremiumTag /> : undefined}
        >
          <div className={isLocked ? "rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 text-center" : "rounded-xl border p-4 text-center"}>
            {isLocked ? (
              <>
                <p className="text-4xl mb-2">🔒</p>
                <p className="font-bold text-amber-700 dark:text-amber-300">ডিভাইস লক করা আছে</p>
                <p className="text-xs text-muted-foreground mt-1">চাইল্ডের ফোনে লক স্ক্রিন দেখা যাচ্ছে</p>
              </>
            ) : (
              <>
                <p className="text-4xl mb-2">🔓</p>
                <p className="font-medium">ডিভাইস আনলকড অবস্থায় আছে</p>
              </>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogTrigger asChild>
                <Button
                  disabled={isLocked}
                  className={isPremium ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
                  onClick={() => !isPremium && setUpsell(true)}
                >
                  <Lock className="h-4 w-4 mr-1.5" /> Lock Device
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>ডিভাইস লক করবেন?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {device.childName === "—" ? "ডিভাইসটি" : `${device.childName}-এর ফোন`} সাথে সাথে লক হবে।
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>বাতিল</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-amber-600 hover:bg-amber-700"
                    onClick={() => dispatchCommand("LOCK_DEVICE")}
                  >
                    হ্যাঁ, লক করুন
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {isLocked && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                চাইল্ড নিজের PIN/প্যাটার্ন দিয়েই আনলক করবে।
              </p>
            )}
            <Button variant="outline" onClick={() => dispatchCommand("REQUEST_STATUS")}>
              <RefreshCw className="h-4 w-4 mr-1.5" /> স্ট্যাটাস রিফ্রেশ
            </Button>
          </div>
        </SectionCard>

        {/* রিলায়েবিলিটি — Don't Kill My App */}
        <SectionCard
          title="ব্যাকগ্রাউন্ড রিলায়েবিলিটি"
          description="“Don't Kill My App” স্ট্যাটাস — বৈধ ব্যাকগ্রাউন্ড অপারেশন নির্ভরযোগ্য রাখা"
          icon={<HeartPulse className="h-4 w-4 text-muted-foreground" />}
        >
          <ul className="space-y-2.5 text-sm">
            <li className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <span className="flex items-center gap-2"><Server className="h-4 w-4 text-muted-foreground" /> Service Status</span>
              <Badge variant={r.serviceStatus === "active" ? "default" : "secondary"} className={r.serviceStatus === "active" ? "bg-emerald-600" : ""}>
                {r.serviceStatus === "active" ? "Foreground Service চালু" : "বন্ধ"}
              </Badge>
            </li>
            <li className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <span className="flex items-center gap-2"><GitBranch className="h-4 w-4 text-muted-foreground" /> Background Status</span>
              <Badge variant={r.backgroundStatus === "running" ? "default" : "secondary"} className={r.backgroundStatus === "running" ? "bg-emerald-600" : "bg-amber-500"}>
                {r.backgroundStatus === "running" ? "Running" : "Restricted"}
              </Badge>
            </li>
            <li className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <span className="flex items-center gap-2"><Battery className="h-4 w-4 text-muted-foreground" /> Battery Optimization</span>
              {r.batteryOptimizationIgnored ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium"><CheckCircle2 className="h-4 w-4" /> Exemption দেওয়া</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium"><XCircle className="h-4 w-4" /> প্রয়োজন</span>
              )}
            </li>
            <li className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <span className="flex items-center gap-2"><BellRing className="h-4 w-4 text-muted-foreground" /> Notification Status</span>
              {r.notificationEnabled ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium"><CheckCircle2 className="h-4 w-4" /> চালু</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-rose-500 font-medium"><XCircle className="h-4 w-4" /> বন্ধ</span>
              )}
            </li>
            <li className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <span className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-muted-foreground" /> Last Heartbeat</span>
              <span className="text-xs font-mono">{fmtClock(r.lastHeartbeat)}</span>
            </li>
          </ul>
          {r.manufacturerNote && (
            <Alert className="mt-3 border-amber-300 bg-amber-50 dark:bg-amber-950/30">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Additional battery settings may be required</AlertTitle>
              <AlertDescription>{r.manufacturerNote}</AlertDescription>
            </Alert>
          )}
        </SectionCard>
      </div>

      {/* Permission Dashboard */}
      <SectionCard
        title="পারমিশন ড্যাশবোর্ড (চাইল্ড ডিভাইস)"
        description="Parent শুধু দেখতে পারে — জোর করে Android-এর user-controlled permission grant করা যায় না"
        icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}
        action={<SupportBadge support="supported" />}
      >
        <div className="grid sm:grid-cols-2 gap-2.5">
          {permKeys.map((k) => (
            <div key={k} className="flex items-center justify-between rounded-lg border px-3.5 py-3">
              <span className="text-sm">{PERMISSION_LABELS[k]}</span>
              <PermBadge ok={perms[k]} />
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          ক্যামেরা/মাইক/স্ক্রিন ক্যাপচারের অনুমতি চাইল্ড নিজে Android consent screen-এ মঞ্জুর করবে — অভিভাবক এটি দূর থেকে চালু করতে পারেন না।
        </p>
      </SectionCard>

      {/* Device management — premium-অনলি */}
      <SectionCard
        title="ডিভাইস ম্যানেজমেন্ট ও সুরক্ষা"
        description="আইকন লুকানো, uninstall protection ও Settings সুরক্ষা"
        icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}
        action={!isPremium ? <PremiumTag /> : <SupportBadge support={hideSupported} />}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={device.appIconHidden ? "destructive" : "secondary"}>
            {device.appIconHidden ? "আইকন লুকানো (hidden)" : "আইকন দৃশ্যমান"}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">ডায়াল কোড: *#*#1111#*#*</span>
        </div>
        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <div className="rounded-lg border p-3.5 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5"><EyeOff className="h-4 w-4" /> অ্যাপ আইকন লুকান</p>
              <p className="text-xs text-muted-foreground mt-1">
                লুকানো অবস্থায় চাইল্ডের launcher-এ অ্যাপ আইকন থাকবে না; ফোনে <span className="font-mono">*#*#1111#*#*</span> ডায়াল করলে আবার খুলবে।
              </p>
            </div>
            <Switch
              checked={device.appIconHidden}
              disabled={!isPremium || !isOwnerManaged}
              onCheckedChange={(on) =>
                !isPremium
                  ? setUpsell(true)
                  : on
                    ? setHideConfirm(true)
                    : updatePolicy(
                        { settings: { ...device.policy.settings, hideAppIcon: false } },
                        "অ্যাপ আইকন আবার দৃশ্যমান",
                      )
              }
              aria-label="Hide app icon"
            />
          </div>
          <div className="rounded-lg border p-3.5 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5"><ShieldAlert className="h-4 w-4" /> Settings অ্যাপ সুরক্ষা</p>
              <p className="text-xs text-muted-foreground mt-1">
                চাইল্ড Settings অ্যাপ খুললে ব্লক হবে — ডিভাইস অ্যাডমিন deactivate করা কঠিন হবে।
              </p>
            </div>
            <Switch
              checked={device.policy.settings.protectSettings}
              disabled={!isPremium || !perms.accessibility}
              onCheckedChange={(on) =>
                !isPremium
                  ? setUpsell(true)
                  : updatePolicy(
                      { settings: { ...device.policy.settings, protectSettings: on } },
                      on ? "Settings সুরক্ষা চালু" : "Settings সুরক্ষা বন্ধ",
                    )
              }
              aria-label="Protect Settings app"
            />
          </div>
        </div>
        {!isPremium && (
          <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
            <Crown className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            ডিভাইস ম্যানেজমেন্ট ব্যবহার করতে প্রিমিয়াম প্ল্যান দরকার।
          </p>
        )}
      </SectionCard>

      {/* Unpair */}
      <SectionCard title="ডিভাইস লাইফসাইকেল" description="Legitimate আন-পেয়ারিং — কোনো anti-removal exploit নেই" icon={<ShieldAlert className="h-4 w-4 text-muted-foreground" />}>
        <div className="flex flex-wrap items-center gap-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Remove Device (Unpair)</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>ডিভাইস আন-পেয়ার করবেন?</AlertDialogTitle>
                <AlertDialogDescription>
                  ডিভাইসটি আপনার অ্যাকাউন্ট থেকে বিচ্ছিন্ন হবে, সব সেশন বন্ধ হবে এবং management lifecycle সঠিকভাবে শেষ হবে।
                  চাইল্ড অ্যাপ তখন নতুন পেয়ারিং কোড দিয়ে আবার যুক্ত হতে পারবে।
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>বাতিল</AlertDialogCancel>
                <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" onClick={unpair}>
                  হ্যাঁ, আন-পেয়ার করুন
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <p className="text-xs text-muted-foreground">
            ম্যানেজড ডিভাইসে uninstall protection স্বয়ংক্রিয়ভাবে থাকে।
          </p>
        </div>
      </SectionCard>

      {/* Hide-icon confirmation — dormancy warning */}
      <AlertDialog open={hideConfirm} onOpenChange={setHideConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>অ্যাপ আইকন লুকিয়ে ফেলবেন?</AlertDialogTitle>
            <AlertDialogDescription>
              চাইল্ড ডিভাইসে অ্যাপ আইকন launcher থেকে সরে যাবে এবং অ্যাপ pause হবে (লোকেশন, হার্টবিট, কমান্ড বন্ধ)। ফোনে
              <span className="font-mono"> *#*#1111#*#* </span> ডায়াল করলে অ্যাপ আবার খুলবে এবং কাজ চালু হবে।
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>বাতিল</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() =>
                updatePolicy(
                  { settings: { ...device.policy.settings, hideAppIcon: true } },
                  "অ্যাপ আইকন লুকানো হলো",
                )
              }
            >
              হ্যাঁ, আইকন লুকান
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PremiumUpsellDialog open={upsell} onOpenChange={setUpsell} feature="ডিভাইস কন্ট্রোল" />
    </div>
  );
}
