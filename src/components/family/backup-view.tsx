"use client";
/**
 * BackupView — consent-based automatic cloud backup প্যানেল (premium-অনলি)।
 *
 * অভিভাবক এখানে দেখেন: ক্যাটাগরি (Photos/Videos/Contacts/SMS) ON/OFF,
 * অনুমতির অবস্থা, শেষ ব্যাকআপ, অপেক্ষমাণ/ব্যর্থ ফাইল, স্টোরেজ ব্যবহার —
 * এবং ব্যাকআপ হওয়া ছবি/ভিডিও সরাসরি ওয়েবসাইট থেকে দেখা ও নামানো যায়।
 *
 * v1.4.0: প্রিমিয়াম গেট, মিডিয়া ভিউয়ার (গ্যালারি + প্লেয়ার), এবং
 * ইন্টারনাল আর্কিটেকচার/স্টোরেজ বর্ণনা সরানো হয়েছে (নিরাপত্তা)।
 */
import { useMemo, useState } from "react";
import {
  CloudUpload, Images, Video, BookUser, MessageSquareText,
  Download, RefreshCw, Play, Eye, HardDrive,
  AlertTriangle, ListChecks, RotateCcw, Crown, FileQuestion, X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useFamily, BACKUP_PERMISSION } from "@/lib/family/store";
import { BACKUP_CATEGORIES, type BackupCategory, type BackupItem, type BackupItemState } from "@/lib/family/types";
import { fmtTime } from "@/lib/family/engine";
import { SectionCard, PremiumTag, PremiumUpsellDialog } from "./ui-bits";

const CATEGORY_META: Record<
  BackupCategory,
  { label: string; icon: React.ReactNode; hint: string }
> = {
  photos: { label: "Photos", icon: <Images className="h-5 w-5" />, hint: "চাইল্ডের ফোনে নতুন ছবি এলেই স্বয়ংক্রিয় ব্যাকআপ" },
  videos: { label: "Videos", icon: <Video className="h-5 w-5" />, hint: "বড় ভিডিওও নিরাপদে ব্যাকআপ হয়" },
  contacts: { label: "Contacts", icon: <BookUser className="h-5 w-5" />, hint: "নতুন/পরিবর্তিত কন্টাক্ট ব্যাকআপ ও রিস্টোর" },
  sms: { label: "SMS (optional)", icon: <MessageSquareText className="h-5 w-5" />, hint: "চাইল্ডের অনুমতি থাকলে ব্যাকআপ; না থাকলে অনুপলব্ধ" },
};

const STATE_BADGE: Record<BackupItemState, { label: string; cls: string }> = {
  PENDING: { label: "PENDING", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0" },
  UPLOADING: { label: "UPLOADING", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 border-0 animate-pulse" },
  UPLOADED: { label: "UPLOADED", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 border-0" },
  FAILED: { label: "FAILED", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-0" },
  CANCELLED: { label: "CANCELLED", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 border-0" },
};

function fmtBytes(b: number): string {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(2)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1 << 10) return `${(b / (1 << 10)).toFixed(0)} KB`;
  return `${b} B`;
}

const ERROR_LABEL: Record<string, string> = {
  POLICY_DISABLED: "ব্যাকআপ বন্ধ আছে",
  CONSENT_MISSING: "চাইল্ড কনসেন্ট নেই",
  NETWORK: "নেটওয়ার্ক ব্যর্থ — আবার চেষ্টা হবে",
  DEVICE_BANNED: "ডিভাইস ব্যানকৃত",
  R2_OBJECT_MISSING: "স্টোরেজ অবজেক্ট নিশ্চিহ্ন",
  BACKUP_STORAGE_UNAVAILABLE: "স্টোরেজ কনফিগার নেই",
};

/** ছবি/ভিডিও ভিউয়ার — আপলোড হওয়া ফাইল ওয়েবসাইট থেকেই দেখা যায় */
function MediaViewer({
  item,
  onClose,
}: {
  item: BackupItem | null;
  onClose: () => void;
}) {
  const download = useFamily((s) => s.downloadBackupItem);
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-emerald-600" /> {item?.fileName ?? ""}
        </DialogTitle>
        {item && (
          <>
            <div className="rounded-xl border bg-muted/40 aspect-video grid place-items-center overflow-hidden">
              {item.category === "photos" ? (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <Images className="h-12 w-12 text-emerald-600/60" />
                  <p className="text-sm font-medium">{fmtBytes(item.sizeBytes)} · এনক্রিপ্টেড ব্যাকআপ</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    আসল ডিভাইসের ব্যাকআপ সংযোগ হলে ছবিটি এখানে দেখা যাবে; এখনই নামাতে ডাউনলোড চাপুন।
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <Play className="h-12 w-12 text-emerald-600/60" />
                  <p className="text-sm font-medium">{fmtBytes(item.sizeBytes)} · ভিডিও ব্যাকআপ</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    আসল ডিভাইসের ব্যাকআপ সংযোগ হলে ভিডিওটি এখানে প্লে হবে; এখনই নামাতে ডাউনলোড চাপুন।
                  </p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={STATE_BADGE[item.state].cls}>{STATE_BADGE[item.state].label}</Badge>
              {item.uploadedAt && (
                <span className="text-xs text-muted-foreground">আপলোড: {fmtTime(item.uploadedAt)}</span>
              )}
              <div className="ml-auto flex gap-2">
                <Button size="sm" onClick={() => download(item.id)}>
                  <Download className="h-4 w-4 mr-1.5" /> ডাউনলোড
                </Button>
                <Button size="sm" variant="outline" onClick={onClose}>
                  <X className="h-4 w-4 mr-1.5" /> বন্ধ
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function BackupView() {
  const device = useFamily((s) => s.device);
  const backupPolicy = useFamily((s) => s.backupPolicy);
  const backupItems = useFamily((s) => s.backupItems);
  const backupStats = useFamily((s) => s.backupStats);
  const setBackupCategory = useFamily((s) => s.setBackupCategory);
  const retryBackupItem = useFamily((s) => s.retryBackupItem);
  const downloadBackupItem = useFamily((s) => s.downloadBackupItem);
  const isPremium = useFamily((s) => s.isPremium());
  const [filter, setFilter] = useState<"all" | BackupItemState>("all");
  const [upsell, setUpsell] = useState(false);
  const [viewing, setViewing] = useState<BackupItem | null>(null);

  const counts = useMemo(() => {
    const by = (state: BackupItemState, cat?: BackupCategory) =>
      backupItems.filter((it) => it.state === state && (cat ? it.category === cat : true)).length;
    return {
      pending: by("PENDING"),
      uploading: by("UPLOADING"),
      failed: by("FAILED"),
      cancelled: by("CANCELLED"),
      uploaded: by("UPLOADED"),
      pendingByCat: (cat: BackupCategory) => by("PENDING", cat) + by("UPLOADING", cat),
      failedByCat: (cat: BackupCategory) => by("FAILED", cat),
    };
  }, [backupItems]);

  const visibleItems = useMemo(
    () =>
      backupItems
        .filter((it) => (filter === "all" ? true : it.state === filter))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 60),
    [backupItems, filter],
  );

  const uploadedPhotos = useMemo(
    () => backupItems.filter((it) => it.category === "photos" && it.state === "UPLOADED").slice(0, 12),
    [backupItems],
  );
  const uploadedVideos = useMemo(
    () => backupItems.filter((it) => it.category === "videos" && it.state === "UPLOADED").slice(0, 12),
    [backupItems],
  );

  const toggle = (cat: BackupCategory, on: boolean) => {
    if (!isPremium) {
      setUpsell(true);
      return;
    }
    setBackupCategory(cat, on);
  };

  return (
    <div className="space-y-4">
      {!isPremium && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-3.5 flex flex-wrap items-center gap-3">
          <Crown className="h-5 w-5 text-amber-500" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 flex-1">
            ক্লাউড ব্যাকআপ একটি প্রিমিয়াম ফিচার — ফ্রি প্ল্যানে ক্যাটাগরি পরিবর্তন ও নতুন ব্যাকআপ চালু করা যায় না।
          </p>
          <Button size="sm" variant="outline" onClick={() => setUpsell(true)}>আপগ্রেড করুন</Button>
        </div>
      )}

      {/* ---------- summary strip ---------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <HardDrive className="h-8 w-8 text-emerald-600" />
            <div>
              <p className="text-xs text-muted-foreground">স্টোরেজ ব্যবহার</p>
              <p className="text-lg font-bold">{fmtBytes(backupStats.totalBytes)}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CloudUpload className="h-8 w-8 text-sky-600" />
            <div>
              <p className="text-xs text-muted-foreground">সফল ব্যাকআপ</p>
              <p className="text-lg font-bold">{counts.uploaded} টি</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <ListChecks className="h-8 w-8 text-amber-600" />
            <div>
              <p className="text-xs text-muted-foreground">অপেক্ষমাণ / আপলোডিং</p>
              <p className="text-lg font-bold">{counts.pending + counts.uploading} টি</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-8 w-8 text-rose-500" />
            <div>
              <p className="text-xs text-muted-foreground">ব্যর্থ / বাতিল</p>
              <p className="text-lg font-bold">{counts.failed + counts.cancelled} টি</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------- per-category remote ON/OFF ---------- */}
      <SectionCard title="ব্যাকআপ ক্যাটাগরি — রিমোট ON/OFF" icon={<CloudUpload className="h-4 w-4 text-emerald-600" />}>
        {!device.paired ? (
          <p className="text-sm text-muted-foreground">ডিভাইস পেয়ার হওয়ার পর ক্যাটাগরি নিয়ন্ত্রণ এখানে সক্রিয় হবে।</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {BACKUP_CATEGORIES.map((cat) => {
              const meta = CATEGORY_META[cat];
              const enabled = backupPolicy.categories[cat].enabled;
              const permOk = device.permissions[BACKUP_PERMISSION[cat]];
              const last = backupStats.lastBackupAt[cat];
              const gateOpen = enabled && permOk;
              return (
                <Card key={cat} className={gateOpen ? "border-emerald-300/60" : ""}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <span className={gateOpen ? "text-emerald-600" : "text-muted-foreground"}>{meta.icon}</span>
                      <p className="font-semibold text-sm">{meta.label}</p>
                      {cat === "sms" && !permOk && (
                        <Badge variant="outline" className="text-muted-foreground">অনুপলব্ধ</Badge>
                      )}
                      {!isPremium && <PremiumTag className="ml-1" />}
                      <div className="ml-auto">
                        <Switch
                          checked={enabled}
                          onCheckedChange={(on) => toggle(cat, on)}
                          disabled={!isPremium}
                          aria-label={`${meta.label} ব্যাকআপ টগল`}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">{meta.hint}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className={permOk ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}>
                        অনুমতি: {permOk ? "দেওয়া আছে" : "নেই"}
                      </span>
                      <span className="text-muted-foreground">ব্যাকআপ: {enabled ? "চালু" : "বন্ধ"}</span>
                      <span className="text-muted-foreground">
                        {last ? `শেষ ব্যাকআপ ${fmtTime(last)}` : "এখনো কোনো ব্যাকআপ নেই"}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0">
                        অপেক্ষমাণ {counts.pendingByCat(cat)}
                      </Badge>
                      <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 border-0">
                        ব্যর্থ {counts.failedByCat(cat)}
                      </Badge>
                      <Badge variant="outline">
                        {backupStats.itemCounts[cat] ?? 0} আপলোডেড
                      </Badge>
                    </div>
                    {!gateOpen && isPremium && (
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        {enabled ? "অনুমতি প্রত্যাহৃত — চাইল্ড অ্যাপ নিরাপদে থেমে যাবে" : "নতুন আপলোড বন্ধ — সারির আইটেম বাতিল হবে"}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* ---------- মিডিয়া গ্যালারি (v1.4.0 — ব্যাকআপ ফাইল ওয়েবসাইট থেকে পড়া) ---------- */}
      <SectionCard
        title="ব্যাকআপ হওয়া ছবি ও ভিডিও"
        description="ওয়েবসাইট থেকেই দেখুন ও নামান — শুধু আপনার অনুমোদিত ডিভাইসের ফাইল"
        icon={<Images className="h-4 w-4 text-emerald-600" />}
      >
        {uploadedPhotos.length === 0 && uploadedVideos.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            ব্যাকআপ হওয়া মিডিয়া এখানে জমা হবে
          </div>
        ) : (
          <div className="space-y-4">
            {uploadedPhotos.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">ছবি ({uploadedPhotos.length})</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {uploadedPhotos.map((it) => (
                    <button
                      key={it.id}
                      onClick={() => setViewing(it)}
                      className="group relative aspect-square rounded-lg border bg-gradient-to-br from-emerald-100/60 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 grid place-items-center overflow-hidden hover:border-emerald-400 transition-colors"
                      aria-label={`${it.fileName} দেখুন`}
                    >
                      <Images className="h-6 w-6 text-emerald-600/50" />
                      <span className="absolute bottom-0 inset-x-0 bg-black/45 text-white text-[9px] px-1 py-0.5 truncate">
                        {it.fileName}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {uploadedVideos.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">ভিডিও ({uploadedVideos.length})</p>
                <div className="space-y-1.5">
                  {uploadedVideos.map((it) => (
                    <div key={it.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                      <Video className="h-4 w-4 text-emerald-600 shrink-0" />
                      <span className="text-xs truncate flex-1">{it.fileName}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">{fmtBytes(it.sizeBytes)}</span>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setViewing(it)}>
                        <Eye className="h-3.5 w-3.5 mr-1" /> দেখুন
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* ---------- item queue ---------- */}
      <SectionCard
        title="ব্যাকআপ সারি ও স্টেটাস"
        icon={<RefreshCw className="h-4 w-4 text-emerald-600" />}
        action={
          <div className="flex flex-wrap gap-1.5">
            {(["all", "PENDING", "UPLOADING", "UPLOADED", "FAILED", "CANCELLED"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "সব" : f}
              </Button>
            ))}
          </div>
        }
      >
        <div className="max-h-96 overflow-y-auto rounded-md border" role="list" aria-label="ব্যাকআপ আইটেম তালিকা">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">ফাইল</th>
                <th className="px-3 py-2 font-medium">ক্যাটাগরি</th>
                <th className="px-3 py-2 font-medium">সাইজ</th>
                <th className="px-3 py-2 font-medium">স্টেট</th>
                <th className="px-3 py-2 font-medium">সময়</th>
                <th className="px-3 py-2 font-medium text-right">অ্যাকশন</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it: BackupItem) => (
                <tr key={it.id} className="border-t hover:bg-muted/40" role="listitem">
                  <td className="px-3 py-2 max-w-56">
                    <p className="truncate font-medium">{it.fileName}</p>
                    {it.lastErrorCode && (
                      <p className="text-[11px] text-rose-500 truncate">
                        {ERROR_LABEL[it.lastErrorCode] ?? it.lastErrorCode}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">{CATEGORY_META[it.category].label}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtBytes(it.sizeBytes)}</td>
                  <td className="px-3 py-2">
                    <Badge className={STATE_BADGE[it.state].cls}>{STATE_BADGE[it.state].label}</Badge>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {it.uploadedAt ? fmtTime(it.uploadedAt) : fmtTime(it.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {(it.category === "photos" || it.category === "videos") && it.state === "UPLOADED" && (
                      <Button size="sm" variant="outline" className="h-7 px-2 mr-1" onClick={() => setViewing(it)}>
                        <Eye className="h-3.5 w-3.5 mr-1" /> দেখুন
                      </Button>
                    )}
                    {it.state === "UPLOADED" && it.category !== "photos" && it.category !== "videos" && (
                      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => downloadBackupItem(it.id)}>
                        <Download className="h-3.5 w-3.5 mr-1" /> নামান
                      </Button>
                    )}
                    {it.state === "FAILED" && (
                      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => retryBackupItem(it.id)}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1" /> রিট্রাই
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {visibleItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    <FileQuestion className="h-5 w-5 inline mr-1 opacity-60" />
                    এই ফিল্টারে কোনো আইটেম নেই
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* ---------- restore ---------- */}
      <SectionCard title="রিস্টোর" icon={<RotateCcw className="h-4 w-4 text-emerald-600" />}>
        <p className="text-xs text-muted-foreground mb-3">
          ফোন রিসেট বা নতুন ডিভাইস হলেও একই চাইল্ড অ্যাকাউন্টে লগইন করলে ব্যাকআপ হওয়া
          ডেটা আবার ব্যবহার করা যাবে। কন্টাক্ট রিস্টোর ডিভাইসে করা যায়; মিডিয়া ডাউনলোড করে নেওয়া যায়।
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => downloadBackupItem(
            backupItems.find((it) => it.category === "contacts" && it.state === "UPLOADED")?.id ?? ""
          )}>
            <Download className="h-4 w-4 mr-1.5" /> কন্টাক্ট আর্কাইভ নামান
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadBackupItem(
            backupItems.find((it) => it.category === "photos" && it.state === "UPLOADED")?.id ?? ""
          )}>
            <Download className="h-4 w-4 mr-1.5" /> সর্বশেষ ছবি নামান
          </Button>
        </div>
      </SectionCard>

      <MediaViewer item={viewing} onClose={() => setViewing(null)} />
      <PremiumUpsellDialog open={upsell} onOpenChange={setUpsell} feature="ক্লাউড ব্যাকআপ" />
    </div>
  );
}
