"use client";
/**
 * SandboxPanel (v1.4.0) — শুধু স্যান্ডবক্স/প্রিভিউ পরিবেশের জন্য ডিভাইস-শেল ড্রাইভার।
 *
 * Production (Firebase env vars সেট করা) হলে এই প্যানেল রেন্ডারই হয় না —
 * ওখানে চাইল্ডের আসল Android অ্যাপই এই ভূমিকা নেয় (consent, permission,
 * মিডিয়া detect, নেটওয়ার্ক)। এটি কোনো ডেমো ডেটা তৈরি করে না; শুধু পেয়ার করা
 * শেল-ডিভাইসের ইভেন্ট ট্রিগার করে যাতে পুরো পাইপলাইন পরীক্ষা করা যায়।
 */
import { useState } from "react";
import {
  FlaskConical, Camera, Images, Video, BookUser, Wifi, WifiOff,
  LockOpen, ShieldCheck, ShieldX, BatteryCharging, MessageSquareText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useFamily, SESSION_PERMISSION, BACKUP_PERMISSION } from "@/lib/family/store";
import { PERMISSION_LABELS } from "./ui-bits";
import type { PermissionKey } from "@/lib/family/types";

const SANDBOX_PERMS: PermissionKey[] = [
  "camera", "microphone", "screenCapture", "location",
  "backupMediaPhotos", "backupMediaVideos", "backupContacts", "backupSms",
];

export function SandboxPanel() {
  const [open, setOpen] = useState(false);
  const device = useFamily((s) => s.device);
  const consentRequests = useFamily((s) => s.consentRequests);
  const backupPolicy = useFamily((s) => s.backupPolicy);
  const sandboxConsent = useFamily((s) => s.sandboxConsent);
  const togglePermission = useFamily((s) => s.toggleDevicePermission);
  const toggleNetwork = useFamily((s) => s.toggleNetwork);
  const toggleCharging = useFamily((s) => s.toggleCharging);
  const childUnlock = useFamily((s) => s.childUnlock);
  const sandboxNewMedia = useFamily((s) => s.sandboxNewMedia);

  if (!device.paired) {
    return (
      <details className="rounded-lg border border-dashed bg-muted/20 text-muted-foreground">
        <summary className="cursor-pointer select-none px-3.5 py-2.5 text-xs flex items-center gap-2">
          <FlaskConical className="h-3.5 w-3.5" /> স্যান্ডবক্স ডিভাইস-শেল — পেয়ার করার পর পাওয়া যাবে (production-এ নেই)
        </summary>
      </details>
    );
  }

  const pending = consentRequests.find((c) => c.state === "pending");

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-lg border border-dashed bg-muted/20"
    >
      <summary className="cursor-pointer select-none px-3.5 py-2.5 text-xs flex items-center gap-2 text-muted-foreground">
        <FlaskConical className="h-3.5 w-3.5" />
        স্যান্ডবক্স ডিভাইস-শেল (প্রিভিউ পরীক্ষা — production-এ এই প্যানেল থাকবে না)
      </summary>
      <div className="px-3.5 pb-3.5 space-y-4">
        {/* consent — production-এ চাইল্ডের ফোনে দেখা যায় */}
        <div>
          <p className="text-xs font-semibold mb-1.5">চাইল্ড কনসেন্ট {pending ? "(অপেক্ষমাণ)" : ""}</p>
          {pending ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-2 py-0.5 font-medium">
                {pending.type} সেশনের অনুমতি চাওয়া হয়েছে
              </span>
              <Button size="sm" className="h-7 px-2.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => sandboxConsent(pending.id, true)}>
                <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Allow
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => sandboxConsent(pending.id, false)}>
                <ShieldX className="h-3.5 w-3.5 mr-1" /> Decline
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              কোনো অপেক্ষমাণ অনুরোধ নেই — কোনো সেশন অনুরোধ পাঠালে এখানে Allow/Decline দেখা যাবে।
            </p>
          )}
        </div>

        {/* মিডিয়া detect — production-এ Android MediaStore নিজেই করে */}
        <div>
          <p className="text-xs font-semibold mb-1.5">নতুন মিডিয়া (ডিভাইস ইভেন্ট)</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => sandboxNewMedia("photos")} disabled={!backupPolicy.categories.photos.enabled}>
              <Images className="h-3.5 w-3.5 mr-1" /> ছবি
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => sandboxNewMedia("videos")} disabled={!backupPolicy.categories.videos.enabled}>
              <Video className="h-3.5 w-3.5 mr-1" /> ভিডিও
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => sandboxNewMedia("contacts")} disabled={!backupPolicy.categories.contacts.enabled}>
              <BookUser className="h-3.5 w-3.5 mr-1" /> কন্টাক্ট
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => sandboxNewMedia("sms")} disabled={!backupPolicy.categories.sms.enabled}>
              <MessageSquareText className="h-3.5 w-3.5 mr-1" /> SMS
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">ব্যাকআপ ক্যাটাগরি চালু থাকলে নতুন আইটেম ব্যাকআপ সারিতে যাবে।</p>
        </div>

        {/* permission — production-এ চাইল্ড Android সেটিংসে দেয় */}
        <div>
          <p className="text-xs font-semibold mb-1.5">অনুমতি (চাইল্ড ডিভাইস)</p>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {SANDBOX_PERMS.map((k) => (
              <label key={k} className="flex items-center justify-between rounded border bg-background px-2.5 py-1.5 text-xs gap-2">
                <span className="truncate">{PERMISSION_LABELS[k]}</span>
                <Switch checked={device.permissions[k]} onCheckedChange={() => togglePermission(k)} aria-label={k} />
              </label>
            ))}
          </div>
        </div>

        {/* ডিভাইস ইভেন্ট */}
        <div>
          <p className="text-xs font-semibold mb-1.5">ডিভাইস ইভেন্ট</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={toggleNetwork}>
              {device.networkType === "none" ? <Wifi className="h-3.5 w-3.5 mr-1" /> : <WifiOff className="h-3.5 w-3.5 mr-1" />}
              {device.networkType === "none" ? "অনলাইন করুন" : "অফলাইন করুন"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={toggleCharging}>
              <BatteryCharging className="h-3.5 w-3.5 mr-1" /> চার্জিং টগল
            </Button>
            {device.locked && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={childUnlock}>
                <LockOpen className="h-3.5 w-3.5 mr-1" /> চাইল্ড আনলক (PIN)
              </Button>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}
