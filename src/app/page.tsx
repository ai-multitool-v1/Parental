"use client";
/**
 * Family Safety — Parent Dashboard (একমাত্র রুট)।
 * লগইন না থাকলে LoginScreen, থাকলে AppShell।
 * ৫ সেকেন্ড পরপর engine tick — ডিভাইস heartbeat/লোকেশন/কমান্ড-কিউ simulate করে
 * (real mode-এ এগুলো Firestore listeners + FCM হবে)।
 * প্রতি browser session-এ একবার Splash Screen দেখায়।
 */
import { useEffect } from "react";
import { useFamily } from "@/lib/family/store";
import { LoginScreen } from "@/components/family/login-screen";
import { AppShell } from "@/components/family/app-shell";
import { SplashScreen, useSplashOnce } from "@/components/family/splash-screen";

export default function Page() {
  const parent = useFamily((s) => s.parent);
  const tick = useFamily((s) => s.tick);
  const [splash, dismissSplash] = useSplashOnce();

  useEffect(() => {
    if (!parent) return;
    const t = window.setInterval(() => tick(), 5000);
    return () => window.clearInterval(t);
  }, [parent, tick]);

  if (splash) return <SplashScreen onDone={dismissSplash} />;
  return parent ? <AppShell /> : <LoginScreen />;
}
