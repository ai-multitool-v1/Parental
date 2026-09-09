/**
 * Device engine — ডিভাইস ও নেটওয়ার্কের আচরণের সাধারণ নিয়মাবলি।
 * Real Firebase mode-এ এই আচরণগুলো আসলে Android app + Cloud Functions করে;
 * স্যান্ডবক্সে একই নিয়ম (whitelist, expiry, replay-check, consent) প্রদর্শিত হয়।
 */
import type {
  AppUsage,
  ChildDevice,
  DevicePolicy,
  LocationPoint,
} from "./types";

/** স্যান্ডবক্সে প্রথম লোকেশন পয়েন্টের ভিত্তি (ঢাকা) — আসল ডিভাইস নিজের
 *  GPS পয়েন্ট পাঠায়; এটি শুধু প্রথম রেফারেন্স। */
export const DEFAULT_CENTER = { lat: 23.7925, lng: 90.4078 };

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Cryptographically random pairing code (8 char, ambiguous chars বাদ) */
export function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 1e9);
  }
  return Array.from(buf, (n) => alphabet[n % alphabet.length]).join("");
}

/** Bedtime window এখন সক্রিয় কি না (midnight-crossing সাপোর্টসহ) */
export function isBedtimeActive(policy: DevicePolicy): boolean {
  if (!policy.bedtime.enabled) return false;
  const now = new Date();
  if (!policy.bedtime.days.includes(now.getDay())) return false;
  const [sh, sm] = policy.bedtime.start.split(":").map(Number);
  const [eh, em] = policy.bedtime.end.split(":").map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

/** লোকেশনে ছোট random walk (ডিভাইস চলমান থাকার অনুভূতি) */
export function jitterLocation(base: LocationPoint): LocationPoint {
  const drift = 0.00018;
  return {
    ...base,
    lat: base.lat + (Math.random() - 0.5) * drift,
    lng: base.lng + (Math.random() - 0.5) * drift,
    accuracy: Math.max(5, Math.min(35, base.accuracy + (Math.random() - 0.5) * 6)),
  };
}

export function freshLocation(prev: LocationPoint | undefined): LocationPoint {
  const base: LocationPoint = prev ?? {
    id: "loc-0",
    lat: DEFAULT_CENTER.lat,
    lng: DEFAULT_CENTER.lng,
    accuracy: 12,
    timestamp: Date.now(),
  };
  return { ...jitterLocation(base), id: uid("loc"), timestamp: Date.now() };
}

/** ডিভাইসে ব্যবহার-পরিসংখ্যান বাড়ানো (UsageStatsManager sync-এর সমতুল্য) */
export function bumpUsage(usage: AppUsage[], packageName: string | null): AppUsage[] {
  if (usage.length === 0) return usage;
  const target =
    packageName != null
      ? usage.find((u) => u.packageName === packageName)
      : usage[Math.floor(Math.random() * usage.length)];
  if (!target) return usage;
  const delta = 1 + Math.floor(Math.random() * 2);
  return usage.map((u) =>
    u.packageName === target.packageName
      ? {
          ...u,
          minutesToday: u.minutesToday + delta,
          minutes7d: u.minutes7d + delta,
          minutes30d: u.minutes30d + delta,
          lastUsed: Date.now(),
        }
      : u,
  );
}

/** ডিভাইস স্ট্যাটাস নির্ধারণ (spec §8) */
export function computeStatus(device: ChildDevice): ChildDevice["status"] {
  if (!device.paired || device.networkType === "none") return "offline";
  const age = Date.now() - device.lastSeen;
  if (age < 5 * 60_000) return "online";
  if (age < 15 * 60_000) return "recently_active";
  return "offline";
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("bn-BD", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" });
}

export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h <= 0) return `${r}মি`;
  return `${h}ঘ ${r}মি`;
}
