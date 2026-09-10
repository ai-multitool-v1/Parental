"use client";
/**
 * ডিভাইসসমূহ — পেয়ারিং, ডিভাইস মেটাডেটা ও unpair।
 * Secure Pairing: ৮-অক্ষর কোড, ৫ মিনিট TTL, single-use।
 * v1.4.0: চাইল্ড সিমুলেটর ট্যাব সরানো হয়েছে; sandbox panel শুধু demo mode-এ
 * এই পেজের নিচে থাকে (Firebase mode-এ সম্পূর্ণ অদৃশ্য)।
 */
import { useState } from "react";
import {
  Smartphone, QrCode, RefreshCw, Unplug, Copy, CheckCheck, HeartPulse, Info, Link2, Loader2, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useFamily } from "@/lib/family/store";
import { isFirebaseConfigured } from "@/lib/family/firebase";
import { fmtClock } from "@/lib/family/engine";
import { SectionCard } from "./ui-bits";
import type { ViewKey } from "./app-shell";
import { SandboxPanel } from "./sandbox-panel";

export function DevicesView({ onNavigate }: { onNavigate: (v: ViewKey) => void }) {
  const device = useFamily((s) => s.device);
  const pairing = useFamily((s) => s.pairing);
  const generatePairingCode = useFamily((s) => s.generatePairingCode);
  const pairingLoading = useFamily((s) => s.pairingLoading);
  const pairingError = useFamily((s) => s.pairingError);
  const pairDevice = useFamily((s) => s.pairDevice);
  const unpair = useFamily((s) => s.unpairDevice);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const sandboxMode = !isFirebaseConfigured();

  const pairingActive = pairing && !pairing.used && Date.now() < pairing.expiresAt;

  return (
    <div className="space-y-5">
      <SectionCard
        title="পেয়ার করা ডিভাইস"
        description={device.paired ? "চাইল্ডের ডিভাইসের বর্তমান অবস্থা" : "এখনো কোনো ডিভাইস পেয়ার করা হয়নি"}
        icon={<Smartphone className="h-4 w-4 text-muted-foreground" />}
      >
        {device.paired ? (
          <div className="rounded-xl border-2 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">
                <Smartphone className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">{device.childName} — {device.name}</p>
                <p className="text-xs text-muted-foreground">{device.model} · {device.androidVersion}</p>
              </div>
              <div className="ml-auto flex flex-col items-end gap-1">
                <Badge variant={device.paired ? "default" : "destructive"} className={device.paired ? "bg-emerald-600" : ""}>
                  {device.paired ? "Paired" : "Unpaired"}
                </Badge>
                <span className="text-[11px] text-muted-foreground">Last seen: {fmtClock(device.lastSeen)}</span>
              </div>
            </div>
            <Separator className="my-3" />
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {[
                ["নেটওয়ার্ক", device.networkType],
                ["ব্যাটারি", `${Math.round(device.batteryLevel)}%${device.isCharging ? " (charging)" : ""}`],
                ["নিয়ন্ত্রণ", device.managementMode === "none" ? "সীমিত" : "সক্রিয়"],
                ["Heartbeat", fmtClock(device.reliability.lastHeartbeat)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border bg-muted/30 px-3 py-2">
                  <dt className="text-[11px] text-muted-foreground">{k}</dt>
                  <dd className="text-[13px] font-medium truncate">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => onNavigate("control")}>
                <HeartPulse className="h-4 w-4 mr-1.5" /> রিলায়েবিলিটি দেখুন
              </Button>
              <Button size="sm" variant="destructive" onClick={unpair}>
                <Unplug className="h-4 w-4 mr-1.5" /> Remove Device (Unpair)
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-dashed p-8 text-center">
            <p className="text-4xl mb-2">📱</p>
            <p className="font-semibold">কোনো ডিভাইস পেয়ার করা নেই</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
              নিচে কোড তৈরি করে চাইল্ডের ফোনের অ্যাপে প্রবেশ করান — ডিভাইস সাথে সাথে এই তালিকায় যোগ হবে।
            </p>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="নতুন ডিভাইস পেয়ার করুন"
        description="কোড ৫ মিনিটে মেয়াদোত্তীর্ণ হয় এবং একবারই ব্যবহার করা যায়"
        icon={<QrCode className="h-4 w-4 text-muted-foreground" />}
        action={
          <Button size="sm" onClick={generatePairingCode} disabled={pairingLoading} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {pairingLoading
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : <RefreshCw className="h-4 w-4 mr-1.5" />}
            {pairingLoading ? "তৈরি হচ্ছে…" : "কোড তৈরি করুন"}
          </Button>
        }
      >
        {pairingError && (
          <Alert variant="destructive" className="mb-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>পেয়ারিং কোড তৈরি হয়নি</AlertTitle>
            <AlertDescription>
              {pairingError}
            </AlertDescription>
          </Alert>
        )}
        {pairingActive ? (
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <div className="rounded-xl border-2 border-dashed border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-6 py-4 text-center">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Pairing Code</p>
              <p className="font-mono text-3xl font-bold tracking-[0.25em] text-emerald-700 dark:text-emerald-300">{pairing!.code}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                মেয়াদ: {Math.max(0, Math.ceil((pairing!.expiresAt - Date.now()) / 1000))} সেকেন্ড · single-use
              </p>
            </div>
            <div className="space-y-2 text-sm flex-1 min-w-0">
              <p className="flex items-center gap-1.5"><CheckCheck className="h-4 w-4 text-emerald-600" /> নিরাপদ, একবারই ব্যবহারযোগ্য</p>
              <p className="flex items-center gap-1.5"><CheckCheck className="h-4 w-4 text-emerald-600" /> ৫ মিনিটে মেয়াদ শেষ</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(pairing!.code);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" /> {copied ? "কপি হয়েছে!" : "কোড কপি করুন"}
              </Button>
            </div>
          </div>
        ) : (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>কোনো সক্রিয় পেয়ারিং কোড নেই</AlertTitle>
            <AlertDescription>
              “কোড তৈরি করুন” চাপুন — সর্বোচ্চ ১টি সক্রিয় কোড থাকে।
            </AlertDescription>
          </Alert>
        )}

        {/* চাইল্ড অ্যাপে কোড প্রবেশের ধাপ — শুধু sandbox সিমুলেশন (real mode-এ
            পেয়ারিং হয় চাইল্ড অ্যাপ থেকে; ড্যাশবোর্ডে ঢুকলেই realtime toast আসবে) */}
        {sandboxMode && (
          <div className="mt-4 rounded-lg border p-3.5">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <Link2 className="h-4 w-4 text-emerald-600" /> চাইল্ড অ্যাপে কোড প্রবেশ করান
            </p>
            <p className="text-xs text-muted-foreground mt-1 mb-2.5">
              চাইল্ডের ফোনের অ্যাপে কোডটি দিলে লিংক সম্পন্ন হবে।
            </p>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="যেমন: A7KD2M9X"
                className="font-mono tracking-widest uppercase max-w-56"
                maxLength={8}
                aria-label="পেয়ারিং কোড"
              />
              <Button
                onClick={() => {
                  if (pairDevice(code)) setCode("");
                }}
                disabled={!code.trim() || !pairingActive}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                লিংক করুন
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      {sandboxMode && (
        <SandboxPanel />
      )}
    </div>
  );
}
