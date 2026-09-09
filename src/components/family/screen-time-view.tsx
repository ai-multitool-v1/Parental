"use client";
/**
 * স্ক্রিন টাইম — UsageStatsManager ডেমো: আজ / ৭ দিন / ৩০ দিন।
 */
import { useState } from "react";
import { Clock3, MonitorSmartphone, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip as ReTooltip,
  PieChart, Pie, Cell, CartesianGrid,
} from "recharts";
import { useFamily } from "@/lib/family/store";
import { fmtMinutes } from "@/lib/family/engine";
import { SectionCard } from "./ui-bits";

const COLORS = ["#059669", "#0d9488", "#f59e0b", "#f43f5e", "#64748b", "#84cc16", "#a855f7"];

export function ScreenTimeView() {
  const usage = useFamily((s) => s.usage);
  const trend = useFamily((s) => s.usageTrend);
  const policy = useFamily((s) => s.device.policy);
  const dispatchCommand = useFamily((s) => s.dispatchCommand);
  const [range, setRange] = useState<"today" | "7d" | "30d">("today");

  const sorted = [...usage].sort((a, b) => b[range === "today" ? "minutesToday" : range === "7d" ? "minutes7d" : "minutes30d"] - a[range === "today" ? "minutesToday" : range === "7d" ? "minutes7d" : "minutes30d"]);
  const total = sorted.reduce((acc, u) => acc + (range === "today" ? u.minutesToday : range === "7d" ? u.minutes7d : u.minutes30d), 0);
  const catTotal = new Map<string, number>();
  sorted.forEach((u) => catTotal.set(u.category, (catTotal.get(u.category) ?? 0) + (range === "today" ? u.minutesToday : range === "7d" ? u.minutes7d : u.minutes30d)));
  const catData = Array.from(catTotal, ([name, value]) => ({ name, value }));
  const chartData = sorted.map((u) => ({
    name: u.appName,
    মিনিট: range === "today" ? u.minutesToday : range === "7d" ? u.minutes7d : u.minutes30d,
  }));

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-3 gap-4">
        <div className="rounded-xl border-2 p-4 bg-gradient-to-br from-emerald-50/80 to-transparent dark:from-emerald-950/20">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /> আজকের মোট</p>
          <p className="mt-1 text-2xl font-bold">{fmtMinutes(usage.reduce((a, u) => a + u.minutesToday, 0))}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> ৭ দিনের গড়/দিন</p>
          <p className="mt-1 text-2xl font-bold">{fmtMinutes(Math.round(trend.reduce((a, t) => a + t.minutes, 0) / 7))}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><MonitorSmartphone className="h-3.5 w-3.5" /> সবচেয়ে বেশি</p>
          <p className="mt-1 text-lg font-bold truncate">{sorted[0]?.appName}</p>
          <p className="text-xs text-muted-foreground">{sorted[0] ? fmtMinutes(sorted[0].minutesToday) : ""} আজ</p>
        </div>
      </div>

      <SectionCard
        title="অ্যাপ ব্যবহারের বিশ্লেষণ"
        description="আজ / ৭ দিন / ৩০ দিনের ব্যবহার"
        icon={<Clock3 className="h-4 w-4 text-muted-foreground" />}
        action={
          <Button size="sm" variant="outline" onClick={() => dispatchCommand("SYNC_USAGE")}>
            <RefreshCw className="h-4 w-4 mr-1.5" /> রিফ্রেশ
          </Button>
        }
      >
        <Tabs value={range} onValueChange={(v) => setRange(v as typeof range)}>
          <TabsList className="mb-4">
            <TabsTrigger value="today">আজ</TabsTrigger>
            <TabsTrigger value="7d">৭ দিন</TabsTrigger>
            <TabsTrigger value="30d">৩০ দিন</TabsTrigger>
          </TabsList>
          <TabsContent value={range} className="mt-0 space-y-5">
            <div className="grid lg:grid-cols-[1fr_280px] gap-5">
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.12} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-18} textAnchor="end" height={52} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ReTooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="মিনিট" fill="#059669" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="h-72">
                <p className="text-xs text-muted-foreground mb-2">ক্যাটাগরি বিভাজন</p>
                <ResponsiveContainer width="100%" height="85%">
                  <PieChart>
                    <Pie data={catData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={3}>
                      {catData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <ReTooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number | string) => fmtMinutes(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-2 justify-center">
                  {catData.map((c, i) => (
                    <span key={c.name} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* প্রতি-অ্যাপ ব্যার */}
            <div className="space-y-3">
              {sorted.map((u) => {
                const mins = range === "today" ? u.minutesToday : range === "7d" ? u.minutes7d : u.minutes30d;
                const limit = policy.dailyLimits[u.packageName];
                const pct = limit && range === "today" ? Math.min(100, (mins / limit) * 100) : Math.min(100, (mins / Math.max(1, sorted[0] ? (range === "today" ? sorted[0].minutesToday : range === "7d" ? sorted[0].minutes7d : sorted[0].minutes30d) : 1)) * 100);
                return (
                  <div key={u.packageName}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="flex items-center gap-2">
                        {u.appName}
                        {limit && range === "today" && <Badge variant="outline" className="text-[10px]">সীমা {limit}মি</Badge>}
                      </span>
                      <span className="text-muted-foreground">{fmtMinutes(mins)} · {Math.round(total ? (mins / total) * 100 : 0)}%</span>
                    </div>
                    <Progress value={pct} className="h-2" />
                  </div>
                );
              })}
            </div>
          </TabsContent>
        </Tabs>
      </SectionCard>

      <SectionCard title="৭ দিনের প্রবণতা" description="দৈনিক মোট স্ক্রিন টাইম (মিনিট)" icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.12} />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <ReTooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="minutes" name="মিনিট" fill="#0d9488" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>
    </div>
  );
}
