"use client";
/**
 * ইনস্টলড অ্যাপস + অ্যাপ রেস্ট্রিকশন (spec §10, §12)।
 * mode="apps": ইনভেন্টরি তালিকা · mode="restrictions": block/daily-limit নিয়ন্ত্রণ
 */
import { useState } from "react";
import {
  Grid3X3, Ban, Search, ShieldCheck, Timer, Lock, PackageSearch, RefreshCw, Hourglass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useFamily } from "@/lib/family/store";
import { fmtMinutes } from "@/lib/family/engine";
import { SectionCard } from "./ui-bits";

export function AppsView({ mode }: { mode: "apps" | "restrictions" }) {
  const apps = useFamily((s) => s.installedApps);
  const usage = useFamily((s) => s.usage);
  const policy = useFamily((s) => s.device.policy);
  const setAppBlocked = useFamily((s) => s.setAppBlocked);
  const setDailyLimit = useFamily((s) => s.setDailyLimit);
  const dispatchCommand = useFamily((s) => s.dispatchCommand);
  const [q, setQ] = useState("");

  const filtered = apps.filter(
    (a) => a.appName.toLowerCase().includes(q.toLowerCase()) || a.packageName.includes(q.toLowerCase()),
  );
  const usageOf = (pkg: string) => usage.find((u) => u.packageName === pkg);
  const hasDevice = useFamily((s) => s.device.paired);

  const EmptyState = (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {hasDevice
        ? "ডিভাইস থেকে সিংক হওয়ার পর অ্যাপ তালিকা এখানে দেখা যাবে — উপরের রিফ্রেশ চাপুন"
        : "ডিভাইস পেয়ার হওয়ার পর অ্যাপ তালিকা এখানে দেখা যাবে"}
    </div>
  );

  return (
    <div className="space-y-5">
      {mode === "apps" ? (
        <SectionCard
          title="ইনস্টলড অ্যাপস"
          description="চাইল্ডের ডিভাইসে ইনস্টল করা অ্যাপগুলো"
          icon={<Grid3X3 className="h-4 w-4 text-muted-foreground" />}
          action={
            <Button size="sm" variant="outline" onClick={() => dispatchCommand("SYNC_APPS")}>
              <RefreshCw className="h-4 w-4 mr-1.5" /> রিফ্রেশ
            </Button>
          }
        >
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="অ্যাপ বা package name খুঁজুন…" className="pl-9" />
          </div>
          {filtered.length === 0 ? (
            EmptyState
          ) : (
          <div className="max-h-[480px] overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">অ্যাপ</th>
                  <th className="px-3 py-2 font-medium">Package</th>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">ধরন</th>
                  <th className="px-3 py-2 font-medium">আজ</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.packageName} className="border-t hover:bg-muted/40">
                    <td className="px-3 py-2.5">
                      <p className="font-medium flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600/10 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                          {a.appName.charAt(0)}
                        </span>
                        {a.appName}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground max-w-44 truncate">{a.packageName}</td>
                    <td className="px-3 py-2.5 text-xs">{a.version}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={a.isSystem ? "secondary" : "outline"} className="text-[10px]">
                        {a.isSystem ? "System" : "User"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs">{usageOf(a.packageName) ? fmtMinutes(usageOf(a.packageName)!.minutesToday) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title="অ্যাপ রেস্ট্রিকশন"
            description="নির্দিষ্ট অ্যাপ ব্লক করুন বা দৈনিক সময়সীমা দিন"
            icon={<Ban className="h-4 w-4 text-muted-foreground" />}
            action={
              <Button size="sm" variant="outline" onClick={() => dispatchCommand("SYNC_POLICY")}>
                <ShieldCheck className="h-4 w-4 mr-1.5" /> সিংক
              </Button>
            }
          >
            <div className="space-y-2.5">
              {apps.filter((a) => !a.isSystem).map((a) => {
                const blocked = policy.blockedApps.includes(a.packageName);
                const limit = policy.dailyLimits[a.packageName];
                return (
                  <div key={a.packageName} className="rounded-xl border p-3.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600/10 text-sm font-bold text-emerald-700 dark:text-emerald-300">
                        {a.appName.charAt(0)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold flex items-center gap-2">
                          {a.appName}
                          {blocked && <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-0 gap-1"><Lock className="h-3 w-3" /> Blocked</Badge>}
                        </p>
                        <p className="text-[11px] text-muted-foreground font-mono truncate">{a.packageName}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`bl-${a.packageName}`} className="text-xs text-muted-foreground">Block</Label>
                        <Switch
                          id={`bl-${a.packageName}`}
                          checked={blocked}
                          onCheckedChange={(v) => setAppBlocked(a.packageName, v)}
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2 min-w-56 flex-1">
                        <Timer className="h-4 w-4 text-muted-foreground shrink-0" />
                        <Slider
                          value={[limit ?? 0]}
                          min={0}
                          max={240}
                          step={15}
                          onValueChange={([v]) => setDailyLimit(a.packageName, v)}
                          aria-label="দৈনিক সীমা (মিনিট)"
                        />
                        <span className="text-xs font-medium w-20 shrink-0 text-right">
                          {limit ? `${limit} মিনিট/দিন` : "সীমা নেই"}
                        </span>
                      </div>
                      {usageOf(a.packageName) && limit && usageOf(a.packageName)!.minutesToday >= limit && (
                        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0 gap-1">
                          <Hourglass className="h-3 w-3" /> সীমা অতিক্রম
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>

          <div className="rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <PackageSearch className="h-4 w-4" /> কীভাবে কাজ করে?
            </p>
            ব্লক/সীমা পলিসি <span className="font-mono">devices/&#123;deviceId&#125;/policies/current</span>-এ যায় → চাইল্ড অ্যাপ
            Device Owner হলে managed restriction, না হলে overlay-ভিত্তিক graceful fallback ব্যবহার করে। কোনো ডিভাইস/Android
            সংস্করণ সাপোর্ট না করলে UI-তে <span className="font-mono">UNSUPPORTED</span> দেখানো হয় — কখনো security bypass নয়।
          </div>
        </>
      )}
    </div>
  );
}
