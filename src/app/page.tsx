"use client";
/**
 * Family Safety — Parent Dashboard (একমাত্র রুট)।
 * লগইন না থাকলে LoginScreen, থাকলে AppShell।
 * মাউন্টে একবার bootstrapAuth() — real mode-এ Firebase Auth সেশন রিফ্রেশে
 * রিস্টোর হয় (আগে রিফ্রেশ করলেই লগইন হারিয়ে যেত)।
 * ৫ সেকেন্ড পরপর engine tick — ডিভাইস heartbeat/লোকেশন/কমান্ড-কিউ simulate করে
 * (real mode-এ এগুলো Firestore listeners + FCM হবে)।
 * প্রতি browser session-এ একবার Splash Screen দেখায়।
 */
import { useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { useFamily } from "@/lib/family/store";
import { isRealMode } from "@/lib/family/real";
import { LoginScreen } from "@/components/family/login-screen";
import { AppShell } from "@/components/family/app-shell";
import { SetupRequired } from "@/components/family/setup-required";
import { SplashScreen, useSplashOnce } from "@/components/family/splash-screen";

export default function Page() {
  const parent = useFamily((s) => s.parent);
  const authChecking = useFamily((s) => s.authChecking);
  const bootstrapAuth = useFamily((s) => s.bootstrapAuth);
  const tick = useFamily((s) => s.tick);
  const [splash, dismissSplash] = useSplashOnce();

  useEffect(() => {
    bootstrapAuth();
  }, [bootstrapAuth]);

  useEffect(() => {
    if (!parent) return;
    const t = window.setInterval(() => tick(), 5000);
    return () => window.clearInterval(t);
  }, [parent, tick]);

  if (splash) return <SplashScreen onDone={dismissSplash} />;
  if (authChecking) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background">
        <ShieldCheck className="h-10 w-10 text-emerald-600 animate-pulse" />
        <p className="text-sm text-muted-foreground">সেশন যাচাই করা হচ্ছে…</p>
      </div>
    );
  }
  // PRODUCTION RULE: demo/simulation প্রোডাকশনে নিষিদ্ধ — env না থাকলে
  // কোনো ডেমো লগইন/ডেটা তৈরি হবে না, setup নির্দেশনা দেখানো হবে।
  if (!isRealMode()) return <SetupRequired />;
  return parent ? <AppShell /> : <LoginScreen />;
}
