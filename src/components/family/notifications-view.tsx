"use client";
/**
 * Parent → Child নোটিফিকেশন (spec §19) — FCM data flow, delivery/read receipt।
 */
import { useState } from "react";
import { BellRing, Send, CheckCheck, Clock3, MailOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useFamily } from "@/lib/family/store";
import { fmtClock } from "@/lib/family/engine";
import { SectionCard } from "./ui-bits";

const QUICK = ["বাড়িতে আসার সময় হয়েছে।", "খাওয়া শেষ করে পড়তে বসো।", "ফোন রেখে দাও, দেখা হবে কিছুক্ষণ।"];

export function NotificationsView() {
  const notifications = useFamily((s) => s.notifications);
  const sendNotification = useFamily((s) => s.sendNotification);
  const markRead = useFamily((s) => s.markNotificationRead);
  const [msg, setMsg] = useState("");

  const send = (m: string) => {
    if (!m.trim()) return;
    sendNotification(m);
    setMsg("");
  };

  return (
    <div className="space-y-5">
      <SectionCard
        title="চাইল্ডকে নোটিফিকেশন পাঠান"
        description="চাইল্ডের ডিভাইসে push notification পৌঁছে যাবে"
        icon={<BellRing className="h-4 w-4 text-muted-foreground" />}
      >
        <Textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="বার্তা লিখুন… যেমন: বাড়িতে আসার সময় হয়েছে।"
          maxLength={200}
          rows={3}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {QUICK.map((q) => (
            <button key={q} onClick={() => setMsg(q)} className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:border-emerald-400 hover:text-foreground transition-colors">
              {q}
            </button>
          ))}
        </div>
        <Button onClick={() => send(msg)} disabled={!msg.trim()} className="mt-3 bg-emerald-600 hover:bg-emerald-700 text-white">
          <Send className="h-4 w-4 mr-1.5" /> পাঠান
        </Button>
      </SectionCard>

      <SectionCard title="পাঠানো বার্তার ইতিহাস" description="Sent → Delivered → Read" icon={<Clock3 className="h-4 w-4 text-muted-foreground" />}>
        <div className="space-y-2.5">
          {notifications.map((n) => (
            <div key={n.id} className="rounded-lg border p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium flex-1 min-w-40">{n.message}</p>
                <Badge variant="secondary" className="gap-1 text-[10px]"><Send className="h-3 w-3" /> Sent {fmtClock(n.sentAt)}</Badge>
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <CheckCheck className={`h-3 w-3 ${n.delivered ? "text-emerald-600" : ""}`} /> {n.delivered ? `Delivered ${fmtClock(n.deliveredAt ?? n.sentAt)}` : "Delivering…"}
                </Badge>
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <MailOpen className={`h-3 w-3 ${n.read ? "text-emerald-600" : ""}`} /> {n.read ? "Read" : "Unread"}
                </Badge>
              </div>
              {!n.read && (
                <Button size="sm" variant="ghost" className="mt-1.5 h-7 text-xs" onClick={() => markRead(n.id)}>
                  Read হিসেবে চিহ্নিত করুন
                </Button>
              )}
            </div>
          ))}
          {notifications.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">এখনো কোনো বার্তা পাঠানো হয়নি</p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
