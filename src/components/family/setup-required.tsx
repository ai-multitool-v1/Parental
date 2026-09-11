"use client";
/**
 * SetupRequired — production dashboard শুধু real mode-এ চলে।
 * NEXT_PUBLIC_* env vars বিল্ডে inline না থাকলে (Vercel env মিসিং/redeploy বাকি)
 * এই স্ক্রিন দেখায় — কোনো demo/সিমুলেটেড ডেটা production-এ আর দেখা বা তৈরি হয় না।
 */
import { ShieldAlert, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const REQUIRED_VARS = [
  { key: "NEXT_PUBLIC_FIREBASE_API_KEY", desc: "Firebase Web API key" },
  { key: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", desc: "firebaseapp.com auth domain" },
  { key: "NEXT_PUBLIC_FIREBASE_PROJECT_ID", desc: "Firebase project id" },
  { key: "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", desc: "FCM sender id" },
  { key: "NEXT_PUBLIC_FIREBASE_APP_ID", desc: "Firebase web app id" },
  { key: "NEXT_PUBLIC_SECURE_API_BASE", desc: "Cloudflare Worker URL (workers.dev)" },
] as const;

export function SetupRequired() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-lg w-full border-amber-300 dark:border-amber-700 shadow-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            সার্ভার কনফিগারেশন অসম্পূর্ণ
          </CardTitle>
          <CardDescription>
            প্রোডাকশন ড্যাশবোর্ড শুধুই রিয়েল মোডে চলে (Firebase Auth + Worker)।
            এই ডিপ্লয়মেন্টে প্রয়োজনীয় environment variables পাওয়া যায়নি, তাই
            ডেমো/সিমুলেশন বন্ধ রাখা হয়েছে।
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="rounded-lg border p-3">
            <p className="font-medium mb-2">Vercel → Settings → Environment Variables-এ এই ৬টি ভ্যালু দিন (Production):</p>
            <ul className="space-y-1.5">
              {REQUIRED_VARS.map((v) => (
                <li key={v.key} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-2">
                  <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{v.key}</code>
                  <span className="text-xs text-muted-foreground">{v.desc}</span>
                </li>
              ))}
            </ul>
          </div>
          <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs">
            <li>ভ্যালুগুলো সেভ করুন</li>
            <li>Deployments → সর্বশেষ deploy-এর ⋯ মেনু → <strong>Redeploy</strong></li>
            <li>পেজ রিলোড করলেই লগইন স্ক্রিন চালু হবে</li>
          </ol>
          <a
            href="https://vercel.com/dashboard"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"
          >
            Vercel Dashboard খুলুন <ExternalLink className="h-3 w-3" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
