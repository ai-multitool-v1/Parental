"use client";
/**
 * /admin — Developer Admin Console (পৃথক রুট)।
 *
 * নিরাপত্তা মডেল (v1.4.1 — server-authoritative):
 *  - Parent dashboard-এ এই পেজের কোনো লিংক/বাটন নেই (user requirement)।
 *  - ক্রেডেনশিয়াল সার্ভারে (scrypt hash) — client bundle-এ কিছু নেই।
 *    সেশন = httpOnly signed cookie; প্রতিটি mutation সার্ভারে যাচাই হয়।
 *  - রেজিস্ট্রি (users/devices/ban/plan/audit) সার্ভারের single source of
 *    truth — client mirror শুধু দেখার জন্য (hydrate)।
 *  - Real mode: Firebase Auth custom claim { admin: true } + Firestore rules
 *    (isAdmin) + adminSetBanState/adminSetPlan callables।
 */
import { useEffect } from "react";
import { useAdminStore } from "@/lib/family/admin-store";
import { AdminLogin } from "@/components/admin/admin-login";
import { AdminPanel } from "@/components/admin/admin-panel";

export default function AdminPage() {
  const admin = useAdminStore((s) => s.admin);
  const sweep = useAdminStore((s) => s.sweep);
  const hydrate = useAdminStore((s) => s.hydrate);

  // সেশন/রেজিস্ট্রি সার্ভার থেকে হাইড্রেট (cookie verify + snapshot)
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // সেশন-সুইপ ব্যাকগ্রাউন্ডেও চলুক (stale লাইভ মার্ক)
  useEffect(() => {
    const iv = window.setInterval(() => sweep(), 20_000);
    return () => window.clearInterval(iv);
  }, [sweep]);

  if (!admin) {
    return <AdminLogin />;
  }
  return <AdminPanel />;
}
