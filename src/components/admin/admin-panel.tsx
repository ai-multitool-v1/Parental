"use client";
/**
 * Developer Admin Panel — পূর্ণ অ্যাডমিনিস্ট্রেশন কনসোল।
 *
 * ট্যাব: ওভারভিউ · রেজিস্টার্ড ইউজার · লাইভ সেশন · ডিভাইস ব্যান · অডিট লগ
 * অ্যাডমিন যা কিছু করতে পারে: সব ইউজার/ডিভাইস দেখা, লাইভ মনিটর, ban/unban
 * (user + device), force logout, সম্পূর্ণ অডিট ট্রেইল।
 *
 * নোট: parent dashboard-এ এই প্যানেলের কোনো লিংক/বাটন ইচ্ছাকৃতভাবে নেই —
 * পৃথক /admin রুট, পৃথক ক্রেডেনশিয়াল, পৃথক অডিট ট্রেইল।
 */
import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, Users, Activity, Smartphone, ScrollText, LogOut, Search,
  ShieldAlert, Ban, CheckCircle2, RefreshCcw, ShieldCheck, Radio, UserX, Wifi, Crown, CircleMinus, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAdminStore } from "@/lib/family/admin-store";
import { useFamily } from "@/lib/family/store";
import { fmtClock, fmtTime } from "@/lib/family/engine";
import { CREDIT_LINE, DEVELOPER_CREDIT, POWERED_BY } from "@/lib/family/branding";
import { cn } from "@/lib/utils";
import type { AdminAuditEntry, AdminDevice, AdminUser, FirebaseAdminUser } from "@/lib/family/admin-types";

type Tab = "overview" | "users" | "live" | "devices" | "audit";

const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
  { key: "overview", label: "ওভারভিউ", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "users", label: "রেজিস্টার্ড ইউজার", icon: <Users className="h-4 w-4" /> },
  { key: "live", label: "লাইভ সেশন", icon: <Radio className="h-4 w-4" /> },
  { key: "devices", label: "ডিভাইস ব্যান", icon: <Smartphone className="h-4 w-4" /> },
  { key: "audit", label: "অডিট লগ", icon: <ScrollText className="h-4 w-4" /> },
];

function StatCard({ label, value, icon, tone }: { label: string; value: string | number; icon: React.ReactNode; tone: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", tone)}>{icon}</span>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function StatusBadges({ u }: { u: AdminUser }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {u.online && (
        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-0 gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> লাইভ
        </Badge>
      )}
      {u.banned ? (
        <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-0 gap-1">
          <Ban className="h-3 w-3" /> ব্যান
        </Badge>
      ) : (
        <Badge variant="secondary">সক্রিয়</Badge>
      )}
      {u.plan === "premium" ? (
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0 gap-1">
          <Crown className="h-3 w-3" /> প্রিমিয়াম
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">ফ্রি</Badge>
      )}
      {u.role === "admin" && <Badge variant="outline" className="border-emerald-500/50 text-emerald-600">ADMIN</Badge>}
    </span>
  );
}

/* ------------------------------ Users tab --------------------------------- */

function FirebaseUsersTable() {
  const fbUsers = useAdminStore((s) => s.fbUsers);
  const fbMode = useAdminStore((s) => s.fbMode);
  const fbLoading = useAdminStore((s) => s.fbLoading);
  const loadFirebaseUsers = useAdminStore((s) => s.loadFirebaseUsers);
  const firebaseSetPlan = useAdminStore((s) => s.firebaseSetPlan);
  const firebaseBanUser = useAdminStore((s) => s.firebaseBanUser);
  const firebaseDeleteUser = useAdminStore((s) => s.firebaseDeleteUser);
  const [q, setQ] = useState("");
  const [banTarget, setBanTarget] = useState<FirebaseAdminUser | null>(null);
  const [reason, setReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FirebaseAdminUser | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void loadFirebaseUsers();
  }, [loadFirebaseUsers]);

  if (fbMode === "unconfigured") {
    return (
      <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
        <p className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" /> ফায়ারবেজ অ্যাকাউন্ট ভিউ কনফিগার হয়নি
        </p>
        <p className="text-sm text-amber-800/80 dark:text-amber-200/80">
          Vercel environment variable <code className="rounded bg-amber-200/60 dark:bg-amber-900/60 px-1.5 py-0.5 font-mono text-xs">WORKER_ADMIN_SECRET</code> সেট করে
          রিডিপ্লয় করলে এখানে আসল রেজিস্টার্ড ইউজার, ডিলিট ও প্রিমিয়াম টগল দেখা যাবে। (নিচের লোকাল রেজিস্ট্রি ডেমো-মোড ডেটা।)
        </p>
      </div>
    );
  }
  if (fbMode === "error" && !fbLoading) {
    return (
      <div className="rounded-xl border-2 border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-4 space-y-2">
        <p className="font-semibold text-rose-700 dark:text-rose-300">ফায়ারবেজ অ্যাকাউন্ট লোড ব্যর্থ</p>
        <Button size="sm" variant="outline" onClick={() => void loadFirebaseUsers()}>
          <RefreshCcw className="h-3.5 w-3.5 mr-1" /> আবার চেষ্টা করুন
        </Button>
      </div>
    );
  }

  const filtered = fbUsers.filter(
    (u) =>
      q === "" ||
      u.email.toLowerCase().includes(q.toLowerCase()) ||
      u.displayName.toLowerCase().includes(q.toLowerCase()) ||
      u.uid.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{fbUsers.length}</span> জন আসল ফায়ারবেজ অ্যাকাউন্ট — Auth + Firestore profile (plan/ban/ডিভাইস সংখ্যা)
        </p>
        <div className="flex items-center gap-2">
          <div className="relative w-52">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ইমেইল/নাম/UID…" className="pl-9 h-9" />
          </div>
          <Button size="sm" variant="outline" className="h-9" onClick={() => void loadFirebaseUsers()} disabled={fbLoading}>
            <RefreshCcw className={cn("h-3.5 w-3.5", fbLoading && "animate-spin")} />
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-muted/70">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">User ID (UID)</th>
              <th className="px-3 py-2 font-medium">ইমেইল / নাম</th>
              <th className="px-3 py-2 font-medium">তৈরি</th>
              <th className="px-3 py-2 font-medium">সর্বশেষ লগইন</th>
              <th className="px-3 py-2 font-medium">ডিভাইস</th>
              <th className="px-3 py-2 font-medium">স্ট্যাটাস</th>
              <th className="px-3 py-2 font-medium text-right">অ্যাকশন</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.uid} className="border-t align-middle hover:bg-muted/40">
                <td className="px-3 py-2.5 font-mono text-[11px]">{u.uid}</td>
                <td className="px-3 py-2.5">
                  <p className="font-medium whitespace-nowrap">{u.email || "—"}</p>
                  {u.displayName && <p className="text-xs text-muted-foreground">{u.displayName}</p>}
                </td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
                  {u.createdAtMs ? fmtTime(u.createdAtMs) : "—"}
                </td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                  {u.lastSignInMs ? fmtClock(u.lastSignInMs) : "—"}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{u.deviceCount}</td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex flex-wrap gap-1">
                    {u.admin && <Badge variant="outline" className="border-emerald-500/50 text-emerald-600">ADMIN</Badge>}
                    {u.banned ? (
                      <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-0">ব্যান</Badge>
                    ) : (
                      <Badge variant="secondary">সক্রিয়</Badge>
                    )}
                    {u.plan === "premium" ? (
                      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0 gap-1">
                        <Crown className="h-3 w-3" /> প্রিমিয়াম
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">ফ্রি</Badge>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end gap-1.5">
                    {!u.admin && (
                      u.plan === "premium" ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void firebaseSetPlan(u.uid, "free")}>
                          <CircleMinus className="h-3.5 w-3.5 mr-1" /> ফ্রি
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-amber-400 text-amber-700 dark:text-amber-400" onClick={() => void firebaseSetPlan(u.uid, "premium")}>
                          <Crown className="h-3.5 w-3.5 mr-1" /> প্রিমিয়াম
                        </Button>
                      )
                    )}
                    {!u.admin && (
                      u.banned ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-emerald-400 text-emerald-700 dark:text-emerald-400" onClick={() => void firebaseBanUser(u.uid, false, "")}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> আনব্যান
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          onClick={() => { setBanTarget(u); setReason(""); }}
                        >
                          <Ban className="h-3.5 w-3.5 mr-1" /> ব্যান
                        </Button>
                      )
                    )}
                    {!u.admin && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs border-rose-400 text-rose-600 hover:bg-rose-100 dark:hover:bg-rose-950/60"
                        onClick={() => { setDeleteTarget(u); setConfirmText(""); }}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> ডিলিট
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !fbLoading && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">কোনো ফায়ারবেজ অ্যাকাউন্ট পাওয়া যায়নি</td></tr>
            )}
            {fbLoading && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">লোড হচ্ছে…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---- ban dialog (firebase user) ---- */}
      <Dialog open={!!banTarget} onOpenChange={(o) => !o && setBanTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <Ban className="h-5 w-5" /> {banTarget?.email} ব্যান করবেন?
            </DialogTitle>
            <DialogDescription>
              ব্যান করলে Auth refresh-token revoke হয় — ইউজার সাথে সাথে লগআউট হয়ে আর লগইন করতে পারবে না।
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="fb-ban-reason">কারণ (অডিট লগে সংরক্ষিত)</Label>
            <Textarea id="fb-ban-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="যেমন: প্ল্যাটফর্ম অপব্যবহার…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanTarget(null)}>বাতিল</Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (banTarget) void firebaseBanUser(banTarget.uid, true, reason.trim());
                setBanTarget(null);
              }}
            >
              ব্যান করুন
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- delete dialog (irreversible cascade) ---- */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <Trash2 className="h-5 w-5" /> স্থায়ীভাবে ডিলিট করবেন?
            </DialogTitle>
            <DialogDescription>
              <span className="font-semibold text-foreground">{deleteTarget?.email}</span> — এটি IRREVERSIBLE:
              Firebase Auth অ্যাকাউন্ট, সব পেয়ার করা ডিভাইস (টেলিমেট্রি/কমান্ড/সেশন সহ), চাইল্ড Auth অ্যাকাউন্ট,
              প্রোফাইল ডক ও pairing code — সব মুছে যাবে।
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="fb-delete-confirm">নিশ্চিত করতে ইমেইলটি লিখুন: <span className="font-mono">{deleteTarget?.email}</span></Label>
            <Input id="fb-delete-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="ইমেইল টাইপ করুন…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>বাতিল</Button>
            <Button
              variant="destructive"
              disabled={deleting || confirmText.trim().toLowerCase() !== (deleteTarget?.email ?? "").trim().toLowerCase()}
              onClick={() => {
                if (!deleteTarget) return;
                setDeleting(true);
                void firebaseDeleteUser(deleteTarget.uid).then((ok) => {
                  setDeleting(false);
                  if (ok) setDeleteTarget(null);
                });
              }}
            >
              {deleting ? "ডিলিট হচ্ছে…" : "স্থায়ীভাবে ডিলিট করুন"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UsersTab() {
  const [source, setSource] = useState<"firebase" | "local">("firebase");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={source === "firebase" ? "default" : "outline"}
          className={source === "firebase" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}
          onClick={() => setSource("firebase")}
        >
          <Users className="h-4 w-4 mr-1.5" /> ফায়ারবেজ অ্যাকাউন্ট (আসল)
        </Button>
        <Button
          size="sm"
          variant={source === "local" ? "default" : "outline"}
          onClick={() => setSource("local")}
        >
          <LayoutDashboard className="h-4 w-4 mr-1.5" /> লোকাল রেজিস্ট্রি (ডেমো)
        </Button>
      </div>
      {source === "firebase" ? <FirebaseUsersTable /> : <LocalUsersTable />}
    </div>
  );
}

function LocalUsersTable() {
  const users = useAdminStore((s) => s.users);
  const banUser = useAdminStore((s) => s.banUser);
  const unbanUser = useAdminStore((s) => s.unbanUser);
  const forceLogout = useAdminStore((s) => s.forceLogout);
  const setPlan = useAdminStore((s) => s.setPlan);
  const [q, setQ] = useState("");
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState("");

  const filtered = users.filter(
    (u) =>
      q === "" ||
      u.email.toLowerCase().includes(q.toLowerCase()) ||
      u.name.toLowerCase().includes(q.toLowerCase()) ||
      u.uid.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          মোট <span className="font-semibold text-foreground">{users.length}</span> জন রেজিস্টার্ড ইউজার — সব রেকর্ড, UID, লগইন ও স্ট্যাটাস দৃশ্যমান
        </p>
        <div className="relative w-52">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ইমেইল/নাম/UID…" className="pl-9 h-9" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm min-w-[880px]">
          <thead className="bg-muted/70">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">User ID (UID)</th>
              <th className="px-3 py-2 font-medium">নাম</th>
              <th className="px-3 py-2 font-medium">ইমেইল</th>
              <th className="px-3 py-2 font-medium">রেজিস্টার্ড</th>
              <th className="px-3 py-2 font-medium">সর্বশেষ লগইন</th>
              <th className="px-3 py-2 font-medium">লগইন</th>
              <th className="px-3 py-2 font-medium">স্ট্যাটাস</th>
              <th className="px-3 py-2 font-medium text-right">অ্যাকশন</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.uid} className="border-t align-middle hover:bg-muted/40">
                <td className="px-3 py-2.5 font-mono text-[11px]">{u.uid}</td>
                <td className="px-3 py-2.5 font-medium whitespace-nowrap">{u.name}</td>
                <td className="px-3 py-2.5 text-xs">{u.email}</td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">{fmtTime(u.registeredAt)}</td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                  {u.lastLoginAt ? fmtClock(u.lastLoginAt) : "—"}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{u.loginCount}</td>
                <td className="px-3 py-2.5"><StatusBadges u={u} /></td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end gap-1.5">
                    {/* v1.4.0 — প্রিমিয়াম/ফ্রি টগল (অ্যাডমিন সব করতে পারে) */}
                    {u.role !== "admin" && (
                      u.plan === "premium" ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPlan(u.uid, "free")}>
                          <CircleMinus className="h-3.5 w-3.5 mr-1" /> ফ্রি করুন
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-amber-400 text-amber-700 dark:text-amber-400" onClick={() => setPlan(u.uid, "premium")}>
                          <Crown className="h-3.5 w-3.5 mr-1" /> প্রিমিয়াম করুন
                        </Button>
                      )
                    )}
                    {u.online && !u.banned && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => forceLogout(u.uid)}>
                        <UserX className="h-3.5 w-3.5 mr-1" /> লগআউট
                      </Button>
                    )}
                    {u.banned ? (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-emerald-400 text-emerald-700 dark:text-emerald-400" onClick={() => unbanUser(u.uid)}>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> আনব্যান
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                        onClick={() => { setBanTarget(u); setReason(""); }}
                      >
                        <Ban className="h-3.5 w-3.5 mr-1" /> ব্যান
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">কোনো ম্যাচ পাওয়া যায়নি</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!banTarget} onOpenChange={(o) => !o && setBanTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <Ban className="h-5 w-5" /> {banTarget?.name} ব্যান করবেন?
            </DialogTitle>
            <DialogDescription>
              ব্যান করলে ইউজার সাথে সাথে লগআউট হয়ে যাবে এবং আর লগইন করতে পারবে না। ডিভাইস টোকেন revoke করা হবে।
              সিদ্ধান্তটি অডিট লগে রেকর্ড হবে।
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ban-reason">কারণ (অডিট লগে সংরক্ষিত)</Label>
            <Textarea
              id="ban-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="যেমন: প্ল্যাটফর্ম অপব্যবহার / ভুয়া অ্যাকাউন্ট…"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanTarget(null)}>বাতিল</Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (banTarget) banUser(banTarget.uid, reason.trim());
                setBanTarget(null);
              }}
            >
              ব্যান করুন
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------ Live tab ---------------------------------- */

function LiveTab() {
  const users = useAdminStore((s) => s.users);
  const forceLogout = useAdminStore((s) => s.forceLogout);
  const [, setClock] = useState(0);
  // লাইভ সেশন সময় আপডেট রাখতে হালকা re-render
  useEffect(() => {
    const iv = window.setInterval(() => setClock((c) => c + 1), 5000);
    return () => window.clearInterval(iv);
  }, []);

  const live = users.filter((u) => u.online);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        এখন <span className="font-semibold text-emerald-600">{live.length}</span> জন লগইন/লাইভ — activity heartbeat (৯০ সেকেন্ড timeout) অনুযায়ী
      </p>
      {live.length === 0 && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">এখন কেউ লাইভ নেই</div>
      )}
      <div className="grid gap-2.5 sm:grid-cols-2">
        {live.map((u) => {
          const mins = u.sessionStartedAt ? Math.max(1, Math.round((Date.now() - u.sessionStartedAt) / 60000)) : 0;
          return (
            <div key={u.uid} className="rounded-lg border p-3.5">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                  <Wifi className="h-4.5 w-4.5" />
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-background animate-pulse" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{u.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                </div>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => forceLogout(u.uid)}>
                  বিচ্ছিন্ন করুন
                </Button>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                <div>
                  <p className="font-medium text-foreground">{u.uid.slice(0, 10)}…</p>
                  <p>User ID</p>
                </div>
                <div>
                  <p className="font-medium text-foreground tabular-nums">{mins} মিনিট</p>
                  <p>সেশন সময়</p>
                </div>
                <div>
                  <p className="font-medium text-foreground">{u.lastActivityAt ? fmtClock(u.lastActivityAt) : "—"}</p>
                  <p>সর্বশেষ activity</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- Devices tab -------------------------------- */

function DevicesTab() {
  const devices = useAdminStore((s) => s.devices);
  const banDevice = useAdminStore((s) => s.banDevice);
  const unbanDevice = useAdminStore((s) => s.unbanDevice);
  const [banTarget, setBanTarget] = useState<AdminDevice | null>(null);
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        ডিভাইস ব্যান সিস্টেম — ব্যানকৃত ডিভাইস কোনো কমান্ড execute করতে পারবে না, FCM push বন্ধ হবে এবং
        heartbeat/টেলিমেট্রি প্রত্যাখ্যাত হবে (Cloud Function + rules enforce করে)।
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-muted/70">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Device ID</th>
              <th className="px-3 py-2 font-medium">ডিভাইস</th>
              <th className="px-3 py-2 font-medium">মালিক</th>
              <th className="px-3 py-2 font-medium">মডেল</th>
              <th className="px-3 py-2 font-medium">সর্বশেষ seen</th>
              <th className="px-3 py-2 font-medium">স্ট্যাটাস</th>
              <th className="px-3 py-2 font-medium text-right">অ্যাকশন</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t hover:bg-muted/40">
                <td className="px-3 py-2.5 font-mono text-[11px]">{d.id.slice(0, 18)}…</td>
                <td className="px-3 py-2.5 font-medium whitespace-nowrap">{d.name}</td>
                <td className="px-3 py-2.5 text-xs">{d.ownerEmail}</td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap">{d.model}<span className="block text-[10px] text-muted-foreground">{d.androidVersion}</span></td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap">{fmtClock(d.lastSeen)}</td>
                <td className="px-3 py-2.5">
                  {d.banned ? (
                    <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-0 gap-1">
                      <Ban className="h-3 w-3" /> ব্যানকৃত
                    </Badge>
                  ) : (
                    <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-0">নিরাপদ</Badge>
                  )}
                  {d.banned && d.banReason && (
                    <p className="mt-1 text-[10px] text-muted-foreground max-w-40">{d.banReason}</p>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {d.banned ? (
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-emerald-400 text-emerald-700 dark:text-emerald-400" onClick={() => unbanDevice(d.id)}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> আনব্যান
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      onClick={() => { setBanTarget(d); setReason(""); }}
                    >
                      <Ban className="h-3.5 w-3.5 mr-1" /> ব্যান
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!banTarget} onOpenChange={(o) => !o && setBanTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <Ban className="h-5 w-5" /> {banTarget?.name} ব্যান করবেন?
            </DialogTitle>
            <DialogDescription>
              ডিভাইসটি সাথে সাথে কমান্ড চ্যানেল থেকে বিচ্ছিন্ন হবে — চলমান কমান্ডও বাতিল হবে।
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="dev-ban-reason">কারণ (অডিট লগে সংরক্ষিত)</Label>
            <Textarea
              id="dev-ban-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="যেমন: নিরাপত্তা অভিযোগ / অননুমোদিত ডিভাইস…"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanTarget(null)}>বাতিল</Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (banTarget) banDevice(banTarget.id, reason.trim());
                setBanTarget(null);
              }}
            >
              ব্যান করুন
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------ Audit tab --------------------------------- */

function AuditTab() {
  const adminAudit = useAdminStore((s) => s.adminAudit);
  const familyAudit = useFamily((s) => s.auditLogs);
  const [src, setSrc] = useState<"all" | "admin" | "platform">("all");
  const [q, setQ] = useState("");

  const merged = useMemo(() => {
    const adminRows = adminAudit.map<AdminAuditEntry & { source: "admin" }>((a) => ({ ...a, source: "admin" }));
    const platformRows = familyAudit.map<AdminAuditEntry & { source: "platform" }>((a) => ({
      id: a.id, at: a.timestamp, actor: a.actorUid, action: a.action,
      target: undefined, result: a.result === "APPROVED" || a.result === "EXECUTED" ? "OK" : a.result === "PENDING" ? "OK" : "DENIED",
      detail: `${a.actorRole}: ${a.detail}`, source: "platform",
    }));
    const all = [...adminRows, ...platformRows].sort((x, y) => y.at - x.at);
    return all.filter(
      (a) =>
        (src === "all" || a.source === src) &&
        (q === "" || a.action.toLowerCase().includes(q.toLowerCase()) || a.detail.toLowerCase().includes(q.toLowerCase())),
    );
  }, [adminAudit, familyAudit, src, q]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          প্ল্যাটফর্ম + অ্যাডমিন সম্পূর্ণ অডিট ট্রেইল (append-only) — শুধুমাত্র ডেভেলপার অ্যাডমিন দেখতে পারে, অভিভাবক কখনোই না
        </p>
        <div className="relative w-52">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="action/detail খুঁজুন…" className="pl-9 h-9" />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(["all", "admin", "platform"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setSrc(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              src === f ? "bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100" : "text-muted-foreground hover:border-slate-400",
            )}
          >
            {f === "all" ? "সব" : f === "admin" ? "অ্যাডমিন অ্যাকশন" : "প্ল্যাটফর্ম"}
          </button>
        ))}
      </div>
      <div className="max-h-[520px] overflow-y-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/85 backdrop-blur">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">সময়</th>
              <th className="px-3 py-2 font-medium">উৎস</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">ফল</th>
              <th className="px-3 py-2 font-medium">বিস্তারিত</th>
            </tr>
          </thead>
          <tbody>
            {merged.slice(0, 250).map((a) => (
              <tr key={`${a.source}-${a.id}`} className="border-t align-top hover:bg-muted/40">
                <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap">{fmtClock(a.at)}</td>
                <td className="px-3 py-2.5">
                  <Badge variant={a.source === "admin" ? "default" : "secondary"} className={cn("text-[10px]", a.source === "admin" && "bg-slate-900 dark:bg-slate-100 dark:text-slate-900")}>
                    {a.source === "admin" ? "ADMIN" : "PLATFORM"}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] font-medium">{a.action}</td>
                <td className="px-3 py-2.5">
                  <span className={cn(
                    "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold font-mono",
                    a.result === "OK" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
                  )}>
                    {a.result}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{a.detail}</td>
              </tr>
            ))}
            {merged.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">কোনো লগ পাওয়া যায়নি</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">দেখানো হচ্ছে {Math.min(merged.length, 250)} / {merged.length} এন্ট্রি · retention ১ বছর</p>
    </div>
  );
}

/* ---------------------------- Overview tab -------------------------------- */

function OverviewTab({ onGo }: { onGo: (t: Tab) => void }) {
  const users = useAdminStore((s) => s.users);
  const devices = useAdminStore((s) => s.devices);
  const adminAudit = useAdminStore((s) => s.adminAudit);
  const live = users.filter((u) => u.online).length;
  const bannedUsers = users.filter((u) => u.banned).length;
  const bannedDevices = devices.filter((d) => d.banned).length;
  const totalLogins = users.reduce((acc, u) => acc + u.loginCount, 0);
  const premiumUsers = users.filter((u) => u.plan === "premium").length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="রেজিস্টার্ড ইউজার" value={users.length} icon={<Users className="h-4 w-4 text-emerald-600" />} tone="bg-emerald-500/10" />
        <StatCard label="এখন লাইভ" value={live} icon={<Radio className="h-4 w-4 text-sky-600" />} tone="bg-sky-500/10" />
        <StatCard label="প্রিমিয়াম ইউজার" value={premiumUsers} icon={<Crown className="h-4 w-4 text-amber-500" />} tone="bg-amber-500/10" />
        <StatCard label="ব্যানকৃত (user/device)" value={`${bannedUsers}/${bannedDevices}`} icon={<Ban className="h-4 w-4 text-rose-600" />} tone="bg-rose-500/10" />
        <StatCard label="মোট লগইন" value={totalLogins} icon={<Activity className="h-4 w-4 text-slate-500" />} tone="bg-slate-500/10" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold">দ্রুত অ্যাকশন</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onGo("users")}><Users className="h-4 w-4 mr-1.5" /> ইউজার ম্যানেজ</Button>
            <Button size="sm" variant="outline" onClick={() => onGo("live")}><Radio className="h-4 w-4 mr-1.5" /> লাইভ মনিটর</Button>
            <Button size="sm" variant="outline" onClick={() => onGo("devices")}><Smartphone className="h-4 w-4 mr-1.5" /> ডিভাইস ব্যান</Button>
            <Button size="sm" variant="outline" onClick={() => onGo("audit")}><ScrollText className="h-4 w-4 mr-1.5" /> অডিট লগ</Button>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-600" />
            <p>
              অ্যাডমিন সেশন শুধু মেমোরিতে — reload করলেই লগআউট। সব অ্যাকশন অডিটে।
              Production: Firebase custom claim + Firestore rules + App Check enforced।
            </p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold">সাম্প্রতিক অ্যাডমিন অ্যাকশন</p>
          <ul className="mt-3 space-y-2">
            {adminAudit.slice(0, 6).map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-xs border-b pb-2 last:border-0">
                <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap mt-0.5">{fmtClock(a.at)}</span>
                <span className="font-mono text-[11px] font-medium">{a.action}</span>
                <span className="ml-auto truncate text-muted-foreground">{a.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Panel ----------------------------------- */

export function AdminPanel() {
  const [tab, setTab] = useState<Tab>("overview");
  const admin = useAdminStore((s) => s.admin);
  const adminLogout = useAdminStore((s) => s.adminLogout);
  const sweep = useAdminStore((s) => s.sweep);

  // লাইভ সেশন sweep — প্যানেল খোলা থাকাকালীন
  useEffect(() => {
    const iv = window.setInterval(() => sweep(), 15_000);
    return () => window.clearInterval(iv);
  }, [sweep]);

  return (
    // নোট: প্যানেল wrapper-এ গ্লোবাল light text সেট করা হয়নি — ট্যাব কনটেন্ট
    // থিম টোকেন (bg-card/text-foreground) ব্যবহার করে, শুধু chrome ডার্ক।
    <div className="min-h-screen flex flex-col bg-slate-950">
      {/* টপবার */}
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100">
        <div className="flex h-14 items-center gap-3 px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <ShieldAlert className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h1 className="font-bold leading-tight">Developer Admin Console</h1>
            <p className="text-[10px] text-slate-500 leading-tight">Silent Exploit Team Bd — Full Platform Control</p>
          </div>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <span className="hidden sm:flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1 text-xs">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-mono">{admin?.username}</span>
            </span>
            <Button
              size="sm"
              variant="outline"
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              onClick={adminLogout}
            >
              <LogOut className="h-4 w-4 mr-1" /> লগআউট
            </Button>
          </div>
        </div>
        {/* ট্যাব */}
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2" aria-label="অ্যাডমিন ট্যাব">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                tab === t.key ? "bg-emerald-600 text-white font-medium" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
              )}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 p-3 sm:p-5">
        {/* ট্যাব কনটেন্ট একটি light sheet-এ — থিম টোকেন (bg-card/মিউটেড টেক্সট)
            ডার্ক chrome-এর উপর সঠিকভাবে পড়া যায় */}
        <div className="rounded-xl border border-slate-800 bg-background text-foreground shadow-xl p-3 sm:p-4">
          {tab === "overview" && <OverviewTab onGo={setTab} />}
          {tab === "users" && <UsersTab />}
          {tab === "live" && <LiveTab />}
          {tab === "devices" && <DevicesTab />}
          {tab === "audit" && <AuditTab />}
        </div>
      </main>

      <footer className="border-t border-slate-800 py-3 text-center text-[11px] text-slate-500">
        <p>{CREDIT_LINE}</p>
        <p className="mt-0.5">Restricted console — সব অ্যাকশন অডিট লগে রেকর্ড হয় · Session in-memory only</p>
      </footer>
    </div>
  );
}
