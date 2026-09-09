"use client";
/**
 * লাইভ লোকেশন ও হিস্টোরি — স্টাইলাইজড SVG ডেমো ম্যাপ (ঢাকা: গুলশান/বনানী)।
 * Production-এ এখানে Google Maps/Leaflet + FusedLocationProvider ডেটা বসবে।
 */
import { useMemo, useState } from "react";
import { MapPin, Crosshair, History, Navigation, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useFamily } from "@/lib/family/store";
import { fmtClock } from "@/lib/family/engine";
import { SectionCard } from "./ui-bits";
import { cn } from "@/lib/utils";

/** lat/lng → SVG ভিউপোর্ট ম্যাপিং (±0.006° রেঞ্জ) */
const RANGE = 0.006;
const W = 640;
const H = 400;
function project(lat: number, lng: number) {
  const x = ((lng - (90.4078 - RANGE)) / (2 * RANGE)) * W;
  const y = H - ((lat - (23.7925 - RANGE)) / (2 * RANGE)) * H;
  return { x, y };
}

const POIS: { name: string; lat: number; lng: number }[] = [
  { name: "গুলশান-১", lat: 23.7925, lng: 90.4078 },
  { name: "বনানী", lat: 23.7965, lng: 90.4015 },
  { name: "মহাখালী DOHS", lat: 23.7998, lng: 90.4042 },
  { name: "গুলশান-২", lat: 23.7936, lng: 90.4123 },
];

function DemoMap() {
  const locations = useFamily((s) => s.locations);
  const online = useFamily((s) => s.device.networkType !== "none");
  const current = locations[0];

  const trail = useMemo(() => {
    return [...locations]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-25)
      .map((p) => ({ ...project(p.lat, p.lng), p }));
  }, [locations]);

  if (!current) return <div className="h-72 flex items-center justify-center text-muted-foreground">লোকেশন নেই</div>;
  const cur = project(current.lat, current.lng);
  const accR = Math.max(10, (current.accuracy / 60) * (W / 2));

  return (
    <div className="relative overflow-hidden rounded-xl border bg-emerald-50/60 dark:bg-emerald-950/20">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="লাইভ ম্যাপ">
        {/* ব্লক গ্রিড */}
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-emerald-900/10" />
          </pattern>
          <radialGradient id="pulse" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgb(16,185,129)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="rgb(16,185,129)" stopOpacity="0.05" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {/* রাস্তা */}
        <path d={`M0 ${H * 0.62} C ${W * 0.25} ${H * 0.52}, ${W * 0.4} ${H * 0.75}, ${W} ${H * 0.6}`} stroke="currentColor" strokeWidth="7" fill="none" className="text-emerald-900/15" strokeLinecap="round" />
        <path d={`M${W * 0.3} 0 C ${W * 0.36} ${H * 0.4}, ${W * 0.28} ${H * 0.7}, ${W * 0.34} ${H}`} stroke="currentColor" strokeWidth="5" fill="none" className="text-emerald-900/15" strokeLinecap="round" />
        <path d={`M${W * 0.66} 0 C ${W * 0.62} ${H * 0.35}, ${W * 0.7} ${H * 0.68}, ${W * 0.62} ${H}`} stroke="currentColor" strokeWidth="5" fill="none" className="text-emerald-900/15" strokeLinecap="round" />
        {/* পুকুর */}
        <ellipse cx={W * 0.82} cy={H * 0.28} rx="52" ry="30" className="fill-teal-400/25" />
        <text x={W * 0.82} y={H * 0.285} textAnchor="middle" className="fill-teal-700/70 dark:fill-teal-300/70" fontSize="10">পুকুর</text>
        {/* POI */}
        {POIS.map((poi) => {
          const { x, y } = project(poi.lat, poi.lng);
          return (
            <g key={poi.name}>
              <circle cx={x} cy={y} r="3" className="fill-slate-500/60" />
              <text x={x + 7} y={y + 3.5} fontSize="11" className="fill-slate-600/80 dark:fill-slate-300/70">{poi.name}</text>
            </g>
          );
        })}
        {/* ট্রেইল */}
        <polyline
          points={trail.map((t) => `${t.x},${t.y}`).join(" ")}
          fill="none"
          stroke="rgb(16,185,129)"
          strokeWidth="2.5"
          strokeDasharray="1 0"
          strokeLinecap="round"
          opacity="0.85"
        />
        {trail.map((t, i) => (
          <circle key={t.p.id} cx={t.x} cy={t.y} r={i === trail.length - 1 ? 0 : 2.4} className="fill-emerald-500/80" />
        ))}
        {/* বর্তমান অবস্থান */}
        <circle cx={cur.x} cy={cur.y} r={accR} fill="url(#pulse)" />
        <circle cx={cur.x} cy={cur.y} r="7" className="fill-emerald-500 stroke-white" strokeWidth="2.5">
          <animate attributeName="r" values="7;9;7" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
      {!online && (
        <div className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-[2px]">
          <p className="rounded-lg border bg-background px-4 py-2 text-sm font-medium text-muted-foreground">
            ডিভাইস অফলাইন — Last Known Location দেখানো হচ্ছে
          </p>
        </div>
      )}
      <div className="absolute bottom-2 right-2 rounded-md border bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
        স্টাইলাইজড ম্যাপ ভিউ
      </div>
    </div>
  );
}

export function LocationView() {
  const locations = useFamily((s) => s.locations);
  const tracking = useFamily((s) => s.device.policy.locationTracking);
  const setLocationTracking = useFamily((s) => s.setLocationTracking);
  const dispatchCommand = useFamily((s) => s.dispatchCommand);
  const current = locations[0];

  return (
    <div className="space-y-5">
      <div className="grid lg:grid-cols-[1fr_320px] gap-5">
        <SectionCard
          title="লাইভ ম্যাপ"
          description="চাইল্ডের ডিভাইসের বর্তমান অবস্থান"
          icon={<MapPin className="h-4 w-4 text-muted-foreground" />}
          action={
            <div className="flex items-center gap-2">
              <Label htmlFor="track" className="text-xs text-muted-foreground">ট্র্যাকিং</Label>
              <Switch id="track" checked={tracking} onCheckedChange={setLocationTracking} />
            </div>
          }
        >
          <DemoMap />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => dispatchCommand("REQUEST_LOCATION")} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <Crosshair className="h-4 w-4 mr-1.5" /> লোকেশন রিফ্রেশ করুন
            </Button>
            <Button size="sm" variant="outline" onClick={() => dispatchCommand("REQUEST_STATUS")}>
              <Navigation className="h-4 w-4 mr-1.5" /> ডিভাইস স্ট্যাটাস
            </Button>
          </div>
        </SectionCard>

        <SectionCard title="বর্তমান অবস্থান" icon={<CircleDot className="h-4 w-4 text-muted-foreground" />}>
          {current ? (
            <dl className="space-y-2.5 text-sm">
              {[
                ["Latitude", current.lat.toFixed(6)],
                ["Longitude", current.lng.toFixed(6)],
                ["Accuracy", `±${Math.round(current.accuracy)} m`],
                ["Timestamp", fmtClock(current.timestamp)],
                [current.label ? "এলাকা" : "", current.label ?? ""],
              ].filter(([k]) => k).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b pb-2 last:border-0">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-mono text-[13px] font-medium">{v}</dd>
                </div>
              ))}
              <div className="rounded-lg bg-muted/50 p-2.5 text-[11px] text-muted-foreground leading-relaxed">
                শেষ জানা অবস্থান অফলাইনেও দেখা যায়।
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">কোনো লোকেশন ডেটা নেই</p>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="লোকেশন হিস্টোরি"
        description="সর্বশেষ পয়েন্টগুলো"
        icon={<History className="h-4 w-4 text-muted-foreground" />}
      >
        <div className="max-h-96 overflow-y-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">সময়</th>
                <th className="px-3 py-2 font-medium">Lat / Lng</th>
                <th className="px-3 py-2 font-medium">Accuracy</th>
                <th className="px-3 py-2 font-medium">এলাকা</th>
              </tr>
            </thead>
            <tbody>
              {locations.slice(0, 40).map((p) => (
                <tr key={p.id} className="border-t hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{fmtClock(p.timestamp)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</td>
                  <td className="px-3 py-2"><Badge variant="secondary" className="text-[10px]">±{Math.round(p.accuracy)}m</Badge></td>
                  <td className={cn("px-3 py-2 text-xs text-muted-foreground")}>{p.label ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
