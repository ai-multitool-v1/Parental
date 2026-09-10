"use client";
/**
 * লগইন + সাইন আপ স্ক্রিন — v1.4.1 SECURITY REWRITE (CRITICAL FIX #1)।
 *
 * পূর্বে: একটাই ফর্ম, যেকোনো email+password গ্রহণ করত এবং প্রথমবার দিলেই
 * নতুন অ্যাকাউন্ট auto-তৈরি হতো — পাসওয়ার্ড কখনো যাচাই হতো না।
 *
 * এখন: আলাদা "সাইন আপ" (নাম + ইমেইল + পাসওয়ার্ড + কনফার্ম) এবং "লগইন"
 * (ইমেইল + পাসওয়ার্ড) ফর্ম। ভেরিফিকেশন সার্ভার-সাইডে (scrypt hash,
 * persisted user store, ৫-বার-ভুল → ৫-মিনিট লকআউট)। নির্দিষ্ট error
 * state: ভুল পাসওয়ার্ড / অ্যাকাউন্ট নেই / ইতিমধ্যে আছে / লকড / ব্যানড।
 *
 * Real Firebase mode: createUserWithEmailAndPassword /
 * signInWithEmailAndPassword (+ onParentLogin blocking function)।
 */
import { useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Users,
  Eye,
  EyeOff,
  Ban,
  Lock,
  UserPlus,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useFamily, type LoginResultCode, type SignupResultCode } from "@/lib/family/store";
import { isRealMode } from "@/lib/family/real";
import { DEVELOPER_CREDIT, POWERED_BY, PLATFORM_VERSION } from "@/lib/family/branding";

type Mode = "login" | "signup";

const LOGIN_ERROR: Partial<Record<LoginResultCode, string>> = {
  empty: "ইমেইল ও পাসওয়ার্ড দিন",
  no_account: "এই ইমেইলে কোনো অ্যাকাউন্ট নেই — আগে সাইন আপ করুন",
  wrong_password: "ভুল পাসওয়ার্ড — আবার চেষ্টা করুন",
  locked: "অনেকবার ভুল চেষ্টা — ৫ মিনিটের জন্য লগইন বন্ধ (নিরাপত্তা লক)",
  network: "সার্ভারে পৌঁছানো যায়নি — সংযোগ দেখে আবার চেষ্টা করুন",
};

const SIGNUP_ERROR: Partial<Record<SignupResultCode, string>> = {
  empty: "সব ঘর পূরণ করুন",
  bad_name: "নাম কমপক্ষে ২ অক্ষরের হতে হবে",
  invalid_email: "সঠিক ইমেইল ঠিকানা দিন",
  weak_password: "পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে",
  mismatch: "দুটি পাসওয়ার্ড মিলছে না",
  exists: "এই ইমেইলে অ্যাকাউন্ট ইতিমধ্যে আছে — লগইন করুন",
  network: "সার্ভারে পৌঁছানো যায়নি — সংযোগ দেখে আবার চেষ্টা করুন",
};

export function LoginScreen() {
  const login = useFamily((s) => s.login);
  const signup = useFamily((s) => s.signup);
  const [mode, setMode] = useState<Mode>("login");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [banned, setBanned] = useState(false);
  const [busy, setBusy] = useState(false);

  // মোড বদলালে error state রিসেট
  useEffect(() => {
    setError("");
    setBanned(false);
  }, [mode]);

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanned(false);
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result === "banned") {
        setError("");
        setBanned(true);
      } else setError(LOGIN_ERROR[result] ?? "");
    } finally {
      setBusy(false);
    }
  };

  const submitSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanned(false);
    setBusy(true);
    try {
      const result = await signup(name, email, password, confirm);
      if (result === "ok") {
        // সাইন আপ সফল → লগইনে পাঠাও (re-auth flow, পরিষ্কার state)
        setMode("login");
        setError("অ্যাকাউন্ট তৈরি হয়েছে — এখন লগইন করুন");
        return;
      }
      setError(SIGNUP_ERROR[result] ?? "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-emerald-50 via-background to-teal-50 dark:from-emerald-950/20 dark:via-background dark:to-teal-950/20">
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-4xl grid lg:grid-cols-2 gap-6 items-stretch">
          {/* ব্র্যান্ডিং পাশ */}
          <div className="hidden lg:flex flex-col justify-center gap-5 p-8">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shadow-lg">
                <Users className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Family Safety</h1>
                <p className="text-sm text-muted-foreground">Consent-based Parental Control Platform</p>
              </div>
            </div>
            <ul className="space-y-3 text-sm text-muted-foreground">
              {[
                "নিরাপদ ডিভাইস পেয়ারিং — একবার ব্যবহারযোগ্য সীমিত মেয়াদের কোড",
                "লাইভ লোকেশন, স্ক্রিন টাইম, অ্যাপ রেস্ট্রিকশন ও Bedtime",
                "ক্যামেরা/মাইক/স্ক্রিন সেশন — সবসময় চাইল্ডের সম্মতিতে",
                "SOS ইমার্জেন্সি ও escalation",
                "প্রিমিয়ামে ডিভাইস কন্ট্রোল ও ক্লাউড ব্যাকআপ",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-3 text-xs text-amber-800 dark:text-amber-300">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                সব sensitive সেশন চাইল্ডের সম্মতিতে চলে — কোনো hidden tracking নেই।
              </p>
            </div>
          </div>

          {/* লগইন / সাইন আপ ফর্ম */}
          <Card className="shadow-xl border-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <KeyRound className="h-5 w-5 text-emerald-600" />
                অভিভাবক {mode === "login" ? "লগইন" : "সাইন আপ"}
              </CardTitle>
              <CardDescription>
                {mode === "login"
                  ? "আপনার অভিভাবক অ্যাকাউন্টে লগইন করুন"
                  : "নতুন অভিভাবক অ্যাকাউন্ট তৈরি করুন"}
              </CardDescription>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 mt-2">
                <button
                  type="button"
                  onClick={() => setMode("login")}
                  className={`h-8 rounded-md text-sm font-medium transition-colors ${mode === "login" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  aria-pressed={mode === "login"}
                >
                  লগইন
                </button>
                <button
                  type="button"
                  onClick={() => setMode("signup")}
                  className={`h-8 rounded-md text-sm font-medium transition-colors ${mode === "signup" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  aria-pressed={mode === "signup"}
                >
                  সাইন আপ
                </button>
              </div>
            </CardHeader>
            {!isRealMode() && (
              <div className="px-6 pb-1">
                <p className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 p-2.5 text-xs text-amber-700 dark:text-amber-300">
                  ⚠️ ডেমো মোড চালু আছে — অ্যাকাউন্ট ও পেয়ারিং কোড সার্ভারে সেভ হয় না, আর কোড আসল child app-এ কাজ করবে না। রিয়েল মোডের জন্য Vercel-এ Firebase + Worker env vars সেট করে Redeploy করুন।
                </p>
              </div>
            )}
            {mode === "login" ? (
              <form onSubmit={submitLogin}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">ইমেইল</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">পাসওয়ার্ড</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPass ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        aria-label="পাসওয়ার্ড দেখুন"
                        onClick={() => setShowPass((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                  {banned && (
                    <div className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-900 p-3 text-xs text-rose-800 dark:text-rose-300" role="alert">
                      <Ban className="h-4 w-4 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold">আপনার অ্যাকাউন্টটি ব্যান করা হয়েছে</p>
                        <p className="mt-0.5">প্ল্যাটফর্ম নীতিমালা লঙ্ঘনের কারণে এই অ্যাকাউন্ট স্থগিত। আপিল করতে সাপোর্টে যোগাযোগ করুন।</p>
                      </div>
                    </div>
                  )}
                </CardContent>
                <CardFooter className="flex-col gap-3">
                  <Button
                    type="submit"
                    disabled={busy}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                  >
                    {busy ? "যাচাই হচ্ছে…" : <><KeyRound className="h-4 w-4" /> লগইন করুন</>}
                  </Button>
                  <Separator />
                  <p className="text-xs text-muted-foreground text-center">
                    অ্যাকাউন্ট না থাকলে উপরের <span className="font-medium text-foreground/80">সাইন আপ</span> ট্যাব থেকে নতুন অ্যাকাউন্ট খুলুন।
                    পাসওয়ার্ড সার্ভারে hash আকারে সংরক্ষিত হয়।
                  </p>
                </CardFooter>
              </form>
            ) : (
              <form onSubmit={submitSignup}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="su-name">নাম</Label>
                    <Input
                      id="su-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="আপনার নাম"
                      autoComplete="name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="su-email">ইমেইল</Label>
                    <Input
                      id="su-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="su-password">পাসওয়ার্ড</Label>
                    <div className="relative">
                      <Input
                        id="su-password"
                        type={showPass ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        aria-label="পাসওয়ার্ড দেখুন"
                        onClick={() => setShowPass((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">কমপক্ষে ৮ অক্ষর</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="su-confirm">পাসওয়ার্ড নিশ্চিত করুন</Label>
                    <Input
                      id="su-confirm"
                      type={showPass ? "text" : "password"}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                </CardContent>
                <CardFooter className="flex-col gap-3">
                  <Button
                    type="submit"
                    disabled={busy}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                  >
                    {busy ? "তৈরি হচ্ছে…" : <><UserPlus className="h-4 w-4" /> অ্যাকাউন্ট তৈরি করুন</>}
                  </Button>
                  <Separator />
                  <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-[11px] text-muted-foreground w-full">
                    <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <p>
                      পাসওয়ার্ড কখনো plaintext-এ সংরক্ষণ হয় না — সার্ভারে
                      scrypt hash (salted) আকারে থাকে এবং লগইনে hash compare
                      করে যাচাই হয়। ৫ বার ভুল চেষ্টায় ৫ মিনিটের নিরাপত্তা লক।
                    </p>
                  </div>
                </CardFooter>
              </form>
            )}
          </Card>
        </div>
      </main>
      <footer className="py-4 text-center text-xs text-muted-foreground space-y-1">
        <div className="flex items-center justify-center gap-1.5">
          <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-400">
            <Timer className="h-3 w-3 mr-1" /> Server-verified auth
          </Badge>
          <span>Family Safety Platform {PLATFORM_VERSION}</span>
        </div>
        <p>
          <span className="font-medium text-foreground/70">{DEVELOPER_CREDIT}</span>
          <span className="mx-1.5">·</span>
          <span className="text-emerald-700 dark:text-emerald-400">{POWERED_BY}</span>
        </p>
      </footer>
    </div>
  );
}
