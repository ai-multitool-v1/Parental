"use client";
/**
 * Developer Admin Login — পৃথক identity space।
 *
 * নিরাপত্তা বৈশিষ্ট্য (ডেমো):
 *  - Parent লগইন দিয়ে ঢোকা যায় না; আলাদা username/password।
 *  - ৫ বার ভুল → ৫ মিনিট lockout (লাইভ কাউন্টডাউন)।
 *  - Timing-safe তুলনা + সব চেষ্টা অডিটে যায়।
 *  - সেশন শুধু মেমোরিতে — পেজ reload করলেই লগআউট।
 *
 * Real Firebase mode: Firebase Auth (admin UID-তে custom claim { admin: true })
 * + Firestore rules (request.auth.token.admin == true) + functions adminSetBanState।
 */
import { useEffect, useState } from "react";
import { ShieldAlert, Lock, Eye, EyeOff, Ban, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAdminStore } from "@/lib/family/admin-store";
import { DEVELOPER_CREDIT, POWERED_BY } from "@/lib/family/branding";

export function AdminLogin() {
  const adminLogin = useAdminStore((s) => s.adminLogin);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [lockLeft, setLockLeft] = useState(0);

  // lockout কাউন্টডাউন
  useEffect(() => {
    const iv = window.setInterval(() => {
      setLockLeft(Math.max(0, useAdminStore.getState().remainingLockoutMs()));
    }, 500);
    return () => window.clearInterval(iv);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const result = await adminLogin(username, password);
    if (result === "ok") setError("");
    else if (result === "empty") setError("ইউজারনেম ও পাসওয়ার্ড দিন");
    else if (result === "locked") setError("অনেক ব্যর্থ চেষ্টা — অ্যাকাউন্ট সাময়িকভাবে লক হয়েছে");
    else setError("ভুল ইউজারনেম বা পাসওয়ার্ড");
  };

  const locked = lockLeft > 0;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950">
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Card className="shadow-2xl border-2 border-slate-800 bg-slate-900/80 backdrop-blur text-slate-100">
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                  <ShieldAlert className="h-6 w-6" />
                </span>
                <div>
                  <CardTitle className="text-xl">Developer Admin Console</CardTitle>
                  <CardDescription className="text-slate-400">
                    প্ল্যাটফর্ম অ্যাডমিনিস্ট্রেশন — পূর্ণ নিয়ন্ত্রণ ও পর্যবেক্ষণ
                  </CardDescription>
                </div>
              </div>
              <Badge variant="outline" className="mt-3 w-fit border-emerald-500/40 text-emerald-400">
                Restricted Area — শুধু অনুমোদিত ডেভেলপার
              </Badge>
            </CardHeader>
            <form onSubmit={submit}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="admin-user" className="text-slate-300">Admin Username</Label>
                  <Input
                    id="admin-user"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="off"
                    className="bg-slate-950/60 border-slate-700 text-slate-100"
                    disabled={locked}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-pass" className="text-slate-300">Admin Password</Label>
                  <div className="relative">
                    <Input
                      id="admin-pass"
                      type={showPass ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                      className="bg-slate-950/60 border-slate-700 text-slate-100"
                      disabled={locked}
                    />
                    <button
                      type="button"
                      aria-label="পাসওয়ার্ড দেখুন"
                      onClick={() => setShowPass((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    >
                      {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {locked && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-300" role="alert">
                    <Ban className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>
                      নিরাপত্তা লক: {Math.ceil(lockLeft / 1000)} সেকেন্ড পরে আবার চেষ্টা করুন।
                      সব ব্যর্থ চেষ্টা অডিট লগে রেকর্ড হচ্ছে।
                    </p>
                  </div>
                )}
                {!locked && error && <p className="text-sm text-rose-400">{error}</p>}

                <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/40 p-3 text-[11px] text-slate-400">
                  <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
                  <p>
                    Restricted console — শুধুমাত্র অনুমোদিত ডেভেলপার অ্যাডমিন প্রবেশ করতে পারবেন।
                    সব লগইন প্রচেষ্টা সার্ভার-সাইডে যাচাই ও লকডাউন হয় (৫ বার ভুল → ৫ মিনিট)।
                  </p>
                </div>
              </CardContent>
              <CardFooter className="flex-col gap-3">
                <Button
                  type="submit"
                  disabled={locked}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                >
                  <Lock className="h-4 w-4" /> {locked ? "লক করা আছে" : "অ্যাডমিন লগইন"}
                </Button>
                <p className="text-[10px] text-slate-500 text-center">
                  ক্রেডেনশিয়াল সার্ভার-সাইডে সংরক্ষিত (scrypt hash) — client bundle-এ কোনো
                  সিক্রেট নেই। বুটস্ট্র্যাপ পাসওয়ার্ড সার্ভার কনসোলে একবার প্রিন্ট হয়।
                </p>
              </CardFooter>
            </form>
          </Card>
        </div>
      </main>
      <footer className="py-4 text-center text-xs text-slate-500">
        <p>
          <span className="font-medium text-slate-400">{DEVELOPER_CREDIT}</span>
          <span className="mx-1.5">·</span>
          <span className="text-emerald-500">{POWERED_BY}</span>
        </p>
      </footer>
    </div>
  );
}
