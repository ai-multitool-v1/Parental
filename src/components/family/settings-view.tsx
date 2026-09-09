"use client";
/**
 * সেটিংস (v1.4.0) — শুধু অভিভাবক-সংক্রান্ত সেটিংস।
 * ব্যাকএন্ড/ডেটাবেস/সিস্টেম-সংক্রান্ত কোনো তথ্য এখানে রাখা হয় না।
 */
import { useState } from "react";
import {
  KeyRound, Crown, Trash2, Send, LifeBuoy, LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useFamily } from "@/lib/family/store";
import { TELEGRAM_URL, TELEGRAM_HANDLE, CREDIT_LINE } from "@/lib/family/branding";
import { SectionCard, PremiumUpsellDialog } from "./ui-bits";

export function SettingsView() {
  const parent = useFamily((s) => s.parent);
  const toggleMfa = useFamily((s) => s.toggleMfa);
  const logout = useFamily((s) => s.logout);
  const resetDemo = useFamily((s) => s.resetDemo);
  const isPremium = useFamily((s) => s.isPremium());
  const [upsell, setUpsell] = useState(false);

  return (
    <div className="space-y-5">
      {/* অ্যাকাউন্ট */}
      <SectionCard title="অ্যাকাউন্ট" icon={<KeyRound className="h-4 w-4 text-muted-foreground" />}>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-lg border px-3.5 py-3">
            <div className="min-w-0">
              <p className="font-medium truncate">{parent?.name}</p>
              <p className="text-xs text-muted-foreground truncate">{parent?.email}</p>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3.5 py-3">
            <div>
              <p className="font-medium flex items-center gap-2">দুই-স্তরের যাচাই (MFA)
                <Badge variant="secondary" className="text-[10px]">সুপারিশকৃত</Badge>
              </p>
              <p className="text-xs text-muted-foreground">লগইনের সময় অতিরিক্ত সুরক্ষা কোড চাইবে</p>
            </div>
            <Switch checked={!!parent?.mfaEnabled} onCheckedChange={toggleMfa} aria-label="MFA টগল" />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOut className="h-4 w-4 mr-1.5" /> লগআউট
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* প্ল্যান */}
      <SectionCard
        title="আপনার প্ল্যান"
        description="প্রিমিয়ামে ডিভাইস কন্ট্রোল, স্ক্রিন শেয়ারিং, ক্যামেরা/অডিও-ভিডিও ও ক্লাউড ব্যাকআপ আনলক হয়"
        icon={<Crown className="h-4 w-4 text-amber-500" />}
      >
        {isPremium ? (
          <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-center gap-3">
            <Crown className="h-6 w-6 text-amber-500" />
            <div>
              <p className="font-semibold text-amber-800 dark:text-amber-300">প্রিমিয়াম সক্রিয়</p>
              <p className="text-xs text-amber-700/80 dark:text-amber-400/80">আপনি সব ফিচার ব্যবহার করতে পারছেন।</p>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border p-4 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium">ফ্রি প্ল্যান</p>
              <p className="text-xs text-muted-foreground">বেসিক ফিচারগুলো চালু আছে — প্রিমিয়ামে সব ফিচার আনলক হবে।</p>
            </div>
            <Button size="sm" className="bg-amber-500 hover:bg-amber-600 text-white gap-1.5" onClick={() => setUpsell(true)}>
              <Crown className="h-4 w-4" /> প্রিমিয়াম দেখুন
            </Button>
          </div>
        )}
      </SectionCard>

      {/* সাপোর্ট */}
      <SectionCard
        title="সাপোর্ট ও যোগাযোগ"
        description="কোনো সমস্যা, প্রশ্ন বা আপিল করতে সরাসরি Telegram-এ মেসেজ করুন"
        icon={<LifeBuoy className="h-4 w-4 text-muted-foreground" />}
      >
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <Send className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Telegram সাপোর্ট</p>
            <p className="text-xs text-muted-foreground truncate">অফিসিয়াল চ্যানেল: {TELEGRAM_HANDLE}</p>
          </div>
          <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
            <Button size="sm" className="bg-sky-600 hover:bg-sky-700 text-white gap-1.5">
              <Send className="h-3.5 w-3.5" /> Telegram খুলুন
            </Button>
          </a>
        </div>
      </SectionCard>

      {/* অ্যাকাউন্ট মুছে ফেলা */}
      <SectionCard title="অ্যাকাউন্ট মুছে ফেলুন" icon={<Trash2 className="h-4 w-4 text-muted-foreground" />}>
        <p className="text-sm text-muted-foreground mb-3">
          অ্যাকাউন্ট মুছলে এই অভিভাবক অ্যাকাউন্টের সব সেটিংস ও ডিভাইস লিংক সরে যাবে। এই অ্যাকশন ফেরানো যায় না।
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              <Trash2 className="h-4 w-4 mr-1.5" /> অ্যাকাউন্ট মুছুন
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>অ্যাকাউন্ট ও সব ডেটা মুছবেন?</AlertDialogTitle>
              <AlertDialogDescription>
                ডিভাইস লিংক, সেটিংস ও স্থানীয় ডেটা মুছে যাবে এবং আপনি লগআউট হয়ে যাবেন।
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>বাতিল</AlertDialogCancel>
              <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" onClick={resetDemo}>
                সব মুছে ফেলুন
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SectionCard>

      <p className="text-center text-[11px] text-muted-foreground">{CREDIT_LINE}</p>

      <PremiumUpsellDialog open={upsell} onOpenChange={setUpsell} feature="প্রিমিয়াম প্ল্যান" />
    </div>
  );
}
