"use client";
/**
 * Bedtime (spec §13) — start/end, বার নির্বাচন, optional allowed apps।
 */
import { MoonStar, Phone, ShieldCheck, Clock3 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useFamily } from "@/lib/family/store";
import { SectionCard, SupportBadge } from "./ui-bits";
import { cn } from "@/lib/utils";

const DAYS = ["রবি", "সোম", "মঙ্গল", "বুধ", "বৃহঃ", "শুক্র", "শনি"];

export function BedtimeView() {
  const policy = useFamily((s) => s.device.policy);
  const bedtimeActive = useFamily((s) => s.device.bedtimeActive);
  const updateBedtime = useFamily((s) => s.updateBedtime);
  const apps = useFamily((s) => s.installedApps);
  const b = policy.bedtime;

  const toggleDay = (d: number) => {
    const days = b.days.includes(d) ? b.days.filter((x) => x !== d) : [...b.days, d].sort();
    updateBedtime({ days });
  };

  return (
    <div className="space-y-5">
      <SectionCard
        title="ঘুমের সময় (Bedtime)"
        description="নির্দিষ্ট সময়ে ডিভাইস ব্যবহার সীমিত হবে — শুধুমাত্র অনুমোদিত অ্যাপ চলবে"
        icon={<MoonStar className="h-4 w-4 text-muted-foreground" />}
        action={
          <div className="flex items-center gap-2">
            <Label htmlFor="bed-en" className="text-xs text-muted-foreground">সক্রিয়</Label>
            <Switch id="bed-en" checked={b.enabled} onCheckedChange={(v) => updateBedtime({ enabled: v })} />
          </div>
        }
      >
        {bedtimeActive && (
          <div className="mb-4 rounded-lg border-2 border-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 dark:border-indigo-800 p-3 text-sm font-medium text-indigo-700 dark:text-indigo-300">
            🌙 এখন Bedtime চলছে — চাইল্ড ডিভাইসে শুধু অনুমোদিত অ্যাপগুলো ব্যবহারযোগ্য
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="bed-start" className="flex items-center gap-1.5 text-sm"><Clock3 className="h-4 w-4" /> শুরু</Label>
            <Input id="bed-start" type="time" value={b.start} onChange={(e) => updateBedtime({ start: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bed-end" className="flex items-center gap-1.5 text-sm"><Clock3 className="h-4 w-4" /> শেষ</Label>
            <Input id="bed-end" type="time" value={b.end} onChange={(e) => updateBedtime({ end: e.target.value })} />
          </div>
        </div>

        <div className="mt-4">
          <Label className="text-sm">বারসমূহ</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {DAYS.map((d, i) => (
              <button
                key={d}
                onClick={() => toggleDay(i)}
                className={cn(
                  "h-10 min-w-14 rounded-lg border px-3 text-sm font-medium transition-colors",
                  b.days.includes(i)
                    ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                    : "bg-background text-muted-foreground hover:border-emerald-400",
                )}
                aria-pressed={b.days.includes(i)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Bedtime-এ অনুমোদিত অ্যাপ"
        description="ফোন ও ইমার্জেন্সি অ্যাপ সবসময় সুপারিশকৃত"
        icon={<Phone className="h-4 w-4 text-muted-foreground" />}
      >
        <div className="grid sm:grid-cols-2 gap-2">
          {apps.filter((a) => !a.isSystem || a.packageName.includes("dialer")).map((a) => {
            const allowed = b.allowedApps.includes(a.packageName);
            const isDialer = a.packageName.includes("dialer");
            return (
              <div key={a.packageName} className={cn("flex items-center gap-3 rounded-lg border p-3", isDialer && "opacity-80")}>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600/10 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                  {a.appName.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{a.appName}{isDialer && " (সুপারিশকৃত)"}</p>
                  <p className="text-[11px] text-muted-foreground font-mono truncate">{a.packageName}</p>
                </div>
                <Checkbox
                  checked={allowed}
                  disabled={isDialer}
                  onCheckedChange={(v) =>
                    updateBedtime({
                      allowedApps: v
                        ? [...b.allowedApps, a.packageName]
                        : b.allowedApps.filter((p) => p !== a.packageName),
                    })
                  }
                  aria-label={`${a.appName} bedtime-এ অনুমোদন`}
                />
              </div>
            );
          })}
        </div>
      </SectionCard>

      <div className="rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
        <div>
          Bedtime enforcement: Device Owner মোডে <Badge variant="secondary" className="mx-1 text-[10px]">SUPPORTED</Badge> —
          AlarmManager + policy sync। অ-ম্যানেজড ডিভাইসে <Badge variant="outline" className="mx-1 text-[10px]">CONDITIONALLY_SUPPORTED</Badge> —
          নোটিফিকেশন-ভিত্তিক রিমাইন্ডার fallback। কখনো Accessibility abuse বা hidden restriction bypass ব্যবহার করা হয় না।
        </div>
      </div>
    </div>
  );
}
