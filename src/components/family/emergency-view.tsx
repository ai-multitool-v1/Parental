"use client";
/**
 * ইমার্জেন্সি / SOS (spec §20-§21) — alert list, acknowledgment, escalation সেটিং।
 * সিস্টেম কখনো emergency services-এর বিকল্প নয় — এই নোট সব জায়গায় থাকবে।
 */
import { useState } from "react";
import { Siren, MapPin, Battery, Wifi, CheckCheck, Timer, PhoneCall, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useFamily } from "@/lib/family/store";
import { fmtClock } from "@/lib/family/engine";
import { SectionCard } from "./ui-bits";
import type { ViewKey } from "./app-shell";

export function EmergencyView({ onNavigate }: { onNavigate: (v: ViewKey) => void }) {
  const emergencies = useFamily((s) => s.emergencies);
  const acknowledge = useFamily((s) => s.acknowledgeSOS);

  return (
    <div className="space-y-5">
      <Alert className="border-rose-300 bg-rose-50/60 dark:bg-rose-950/30">
        <ShieldAlert className="h-4 w-4 text-rose-600" />
        <AlertTitle>গুরুত্বপূর্ণ</AlertTitle>
        <AlertDescription>
          এই সিস্টেম জাতীয় ইমার্জেন্সি সেবার (999/911) বিকল্প নয়। জীবনঘাতী পরিস্থিতিতে সরাসরি ইমার্জেন্সি সেবায় কল করুন।
        </AlertDescription>
      </Alert>

      <div className="grid lg:grid-cols-[1fr_300px] gap-5">
        <SectionCard
          title="SOS ইভেন্ট"
          description="চাইল্ডের বড় EMERGENCY বোতাম থেকে — ৩-সেকেন্ড কাউন্টডাউন + rate limit আছে"
          icon={<Siren className="h-4 w-4 text-muted-foreground" />}
        >
          <div className="space-y-3">
            {emergencies.map((e) => (
              <div key={e.id} className={`rounded-xl border-2 p-4 ${e.acknowledged ? "border-muted" : "border-rose-400 bg-rose-50/70 dark:bg-rose-950/30"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`flex h-9 w-9 items-center justify-center rounded-full text-white ${e.acknowledged ? "bg-muted-foreground" : "bg-rose-600 animate-pulse"}`}>
                    <Siren className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className={`font-bold ${e.acknowledged ? "" : "text-rose-700 dark:text-rose-300"}`}>
                      🚨 SOS — {e.acknowledged ? "Acknowledge করা হয়েছে" : "Acknowledge প্রত্যাশিত"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(e.timestamp).toLocaleString("bn-BD")} · {e.note}
                    </p>
                  </div>
                  {!e.acknowledged && (
                    <Button size="sm" className="ml-auto bg-rose-600 hover:bg-rose-700 text-white" onClick={() => acknowledge(e.id)}>
                      <CheckCheck className="h-4 w-4 mr-1" /> Acknowledge
                    </Button>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary" className="gap-1"><Battery className="h-3 w-3" /> {e.batteryLevel}%</Badge>
                  <Badge variant="secondary" className="gap-1"><Wifi className="h-3 w-3" /> {e.networkType}</Badge>
                  <Badge variant="secondary" className="gap-1"><MapPin className="h-3 w-3" /> {e.lat.toFixed(4)}, {e.lng.toFixed(4)}</Badge>
                  {e.escalationLevel > 0 && !e.acknowledged && (
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0 gap-1">
                      <Timer className="h-3 w-3" /> Escalation #{e.escalationLevel}
                    </Badge>
                  )}
                  <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={() => onNavigate("location")}>
                    <MapPin className="h-3 w-3 mr-1" /> Open Location
                  </Button>
                </div>
                {e.acknowledged && e.acknowledgedAt && (
                  <p className="mt-2 text-[11px] text-muted-foreground">Acknowledge: {fmtClock(e.acknowledgedAt)}</p>
                )}
              </div>
            ))}
            {emergencies.length === 0 && (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <p className="text-3xl mb-2">🕊️</p>
                <p className="text-sm font-medium">কোনো SOS ইভেন্ট নেই</p>
                <p className="text-xs text-muted-foreground mt-1">
                  চাইল্ডের ফোনে EMERGENCY বোতাম চাপলে এখানে alert দেখা যাবে
                </p>
              </div>
            )}
          </div>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Escalation" description="Acknowledge না হলে রিমাইন্ডার" icon={<Timer className="h-4 w-4 text-muted-foreground" />}>
            <p className="text-sm">
              SOS ৫ মিনিটে acknowledge না হলে রিমাইন্ডার পাঠানো হবে; অতিরিক্ত emergency contact থাকলে তারাও জানবেন।
            </p>
          </SectionCard>

          <SectionCard title="Emergency Contacts" icon={<PhoneCall className="h-4 w-4 text-muted-foreground" />}>
            <ul className="text-sm space-y-2">
              <li className="flex justify-between border-b pb-2"><span>প্রাথমিক</span><span className="font-medium">অভিভাবক (আপনি)</span></li>
              <li className="flex justify-between border-b pb-2"><span>সেকেন্ডারি</span><span className="text-muted-foreground">— সেট করা হয়নি</span></li>
            </ul>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
